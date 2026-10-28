/**
 * 节点生成历史：同类型节点合并
 * （change: 2026-10-27-merge-same-type-node-history，任务 3.2 / design D4–D8）。
 *
 * 两阶段写：
 * 1. 校验（同画布/同 type/历史种类/资格/无进行中生成或未结算编辑会话/来源当前版本可恢复），
 *    先把目标当前内容按既有恢复留档规则入历史，再把来源全部条目复制到目标（单事务批量）。
 * 2. 在 room 串行队列内按**最新画布**重新校验，提交单批
 *    `nodeData.patch(目标) + node.remove([来源])`，带 `expectedNodeData` CAS 与修订。
 *
 * 批次成功后才删除来源历史并执行容量清理；批次失败只补偿删除本次复制的条目，来源历史保留。
 * 最坏情况是目标多出几条未生效版本或来源行成为孤儿，绝不会「节点合并了但版本没了」。
 */
import {
  encodeNodeGenerationIdentity,
  isMergeEligibleNode,
  nodeHistoryEntryId,
  nodeTypesForHistoryKind,
  YJS_SYNC_PROTOCOL_VERSION,
  type CanvasCommand,
  type NodeGenerationHistoryEntry,
  type NodeGenerationKind,
  type NodeHistoryMediaPayload,
  type NodeHistoryModelPayload,
  type NodeHistoryModelPlacement,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  currentNodeStateOf,
  currentIdentityOf,
  historyKindForNodeType,
  isActiveGeneration
} from "./current-state.js";
import { isMediaResolvable, mediaExists } from "./queries.js";
import { buildRestoreCommands } from "./restore-commands.js";
import { deleteNodeHistory } from "./capacity.js";
import { snapshotCurrentModelEdit } from "./restore.js";
import { ensureCurrentImageHistory } from "./backfill.js";
import type {
  MergeNodeHistoryInput,
  MergeNodeHistoryOutcome,
  NodeHistoryRoomPort,
  NodeHistoryServiceContext,
  RegisterModelEditInput
} from "./types.js";

/** 合并写面的稳定 actor；用于 durable 命令记录归因。 */
export const NODE_HISTORY_MERGE_ACTOR = "canvas-node-history-merge";

/** 合并命令 id 前缀；`operationId` 是对外幂等键。 */
export const NODE_HISTORY_MERGE_COMMAND_PREFIX = "nghm:";

export type MergeDependencies = {
  context: NodeHistoryServiceContext;
  /** 幂等登记一条模型编辑版本（与恢复共用留档协作者）。 */
  registerModelEdit: (input: RegisterModelEditInput) => Promise<{ status: "inserted" | "duplicate"; entryId: string }>;
  /** 按容量策略清理；合并后对目标节点与画布执行。 */
  enforceCapacity: (canvasId: string, nodeId?: string) => Promise<void>;
  /** 未结算的编辑会话探测；缺省视为无会话。 */
  hasActiveEditSession?: (canvasId: string, nodeId: string) => Promise<boolean>;
};

type MergePlan = {
  kind: NodeGenerationKind;
  /** 读取时来源节点的当前内容身份（入队后必须仍然一致）。 */
  sourceIdentity: string;
  /** 读取时目标节点的当前内容身份（可为 null）。 */
  targetIdentity: string | null;
  /** 来源当前版本条目（按内容身份匹配，不取最新一条）。 */
  entry: NodeGenerationHistoryEntry;
  /** 来源当前版本的模型摆放（含 null），用于显式写回。 */
  modelPlacement: NodeHistoryModelPlacement | null;
};

type ValidationFailure = { ok: false; code: string; message: string };

function failure(code: string, message: string): MergeNodeHistoryOutcome {
  return { ok: false, code, message };
}

/**
 * 合并请求摘要：用于「同一 operationId 不同参数必须拒绝」与命令冻结元数据。
 *
 * 只用规范化 JSON + SHA-256；不包含任何内容正文或媒体引用。
 */
export async function mergeNodeHistoryRequestHash(input: {
  canvasId: string;
  targetNodeId: string;
  sourceNodeId: string;
  operationId: string;
  expectedSourceCurrentIdentity?: string;
  expectedTargetCurrentIdentity?: string;
}): Promise<string> {
  const canonical = stableStringify({
    canvasId: input.canvasId,
    targetNodeId: input.targetNodeId,
    sourceNodeId: input.sourceNodeId,
    operationId: input.operationId,
    ...(input.expectedSourceCurrentIdentity !== undefined
      ? { expectedSourceCurrentIdentity: input.expectedSourceCurrentIdentity }
      : {}),
    ...(input.expectedTargetCurrentIdentity !== undefined
      ? { expectedTargetCurrentIdentity: input.expectedTargetCurrentIdentity }
      : {})
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 递归键排序 JSON（数组顺序保留）；core 不依赖 canvas-yjs 子路径，因此本地保留一份。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

/**
 * 合并来源节点到目标节点。
 */
export async function mergeNodeHistory(
  deps: MergeDependencies,
  input: MergeNodeHistoryInput
): Promise<MergeNodeHistoryOutcome> {
  const { context } = deps;
  const canvasId = input.canvasId.trim();
  const targetNodeId = input.targetNodeId.trim();
  const sourceNodeId = input.sourceNodeId.trim();
  const operationId = input.operationId.trim();
  if (canvasId === "" || targetNodeId === "" || sourceNodeId === "" || operationId === "") {
    return failure("malformed-request", "canvasId、目标节点、来源节点与 operationId 不能为空");
  }
  if (targetNodeId === sourceNodeId) {
    return failure("invalid-node-type", "不能把节点合并到自身");
  }

  const room = await context.resolveRoom(canvasId);
  if (!room) return failure("canvas-not-found", `画布 ${canvasId} 不存在`);

  const request = {
    canvasId,
    targetNodeId,
    sourceNodeId,
    operationId,
    ...(input.expectedSourceCurrentIdentity !== undefined
      ? { expectedSourceCurrentIdentity: input.expectedSourceCurrentIdentity }
      : {}),
    ...(input.expectedTargetCurrentIdentity !== undefined
      ? { expectedTargetCurrentIdentity: input.expectedTargetCurrentIdentity }
      : {})
  };
  const requestHash = await mergeNodeHistoryRequestHash(request);
  const commandId = `${NODE_HISTORY_MERGE_COMMAND_PREFIX}${operationId}`;

  // 响应丢失后的重试：durable 回执优先，且参数摘要必须一致（同身份不同参数拒绝）。
  const prior = await room.lookupCommand?.(commandId);
  if (prior) {
    if (prior.modelBatch?.submissionHash !== requestHash) {
      return failure("conflict", "相同操作身份使用了不同的来源、目标或期望内容");
    }
    return {
      ok: true,
      targetNodeId,
      sourceNodeId,
      revision: prior.revision,
      copied: 0,
      duplicates: 0,
      evicted: 0,
      alreadyMerged: true
    };
  }

  const exported = room.exportCanvas();
  if (!exported.ok) return failure("canvas-unavailable", exported.message);
  const canvas = exported.canvas;

  let planned = await planMerge(deps, canvas, request);
  if (!planned.ok && planned.code === "no-current-version") {
    // 导入/粘贴/画布脚本创建的图片只有当前资产、没有历史条目；图片输出是自包含的
    // 稳定媒体引用，可以在合并前补登为 image-baseline 版本，再按正常路径校验。
    // 文本/视频/音频/模型仍保持 v1 的拒绝语义，不在这里做 nodeData 直拷。
    const backfilled = await ensureCurrentImageHistory(deps, canvas, sourceNodeId);
    if (backfilled.status === "inserted" || backfilled.status === "duplicate") {
      context.log({
        event: "node-history-image-backfilled",
        canvasId,
        nodeId: sourceNodeId,
        entryId: backfilled.entryId,
        trigger: "merge"
      });
      planned = await planMerge(deps, canvas, request);
    }
  }
  if (!planned.ok) return planned;

  // 目标当前内容在覆盖前留档（模型编辑、普通图片补登或图片编辑）。
  const targetData = canvas.nodeData[targetNodeId] as Record<string, unknown> | undefined;
  try {
    if (planned.plan.kind === "model") {
      await snapshotCurrentModelEdit(deps, canvasId, targetNodeId, targetData);
    } else if (planned.plan.kind === "image") {
      // 导入/粘贴/脚本创建的图片目标也可能只有当前资产、没有历史条目。合并会覆盖它的
      // 当前内容，必须先按图片补给规则留档；否则目标原有图片会永久丢失（用户只会看到
      // 来源复制过来的那一条历史，即使两边是同一张图）。
      const targetHistory = await ensureCurrentImageHistory(deps, canvas, targetNodeId);
      if (targetHistory.status === "skipped"
        && (targetHistory.reason === "missing-asset" || targetHistory.reason === "unresolvable")) {
        return failure("merge-failed", "无法留档目标节点的当前内容，合并未开始");
      }
    }
  } catch {
    return failure("merge-failed", "无法留档目标节点的当前内容，合并未开始");
  }

  // 第一阶段：把来源全部历史复制到目标（单事务、按目标与本次合并身份重算 entryId、
  // 同一 operationId 重试幂等；不同来源条目即使内容相同也不去重）。
  const sourceEntries = await context.repository.listForNode(canvasId, sourceNodeId);
  const copies: NodeGenerationHistoryEntry[] = [];
  for (const entry of sourceEntries) {
    // 每个来源条目在目标上生成独立的合并身份：即使两边内容 identity 完全相同（例如两个
    // 节点放的是同一张图），也必须保留两条版本，不能按内容去重。operationId + 来源
    // entryId 保证同一操作重试仍幂等，同时不同来源条目互不碰撞。
    const identity = {
      kind: "local-operation" as const,
      operationId: `merge:${operationId}:${entry.entryId}`
    };
    copies.push({
      ...entry,
      entryId: nodeHistoryEntryId({ canvasId, nodeId: targetNodeId, identity }),
      sourceIdentity: encodeNodeGenerationIdentity(identity),
      nodeId: targetNodeId
    });
  }
  let insertedIds: string[] = [];
  let duplicates = 0;
  try {
    const inserted = await context.repository.insertMany(copies);
    insertedIds = inserted.insertedIds;
    duplicates = inserted.duplicateIds.length;
  } catch {
    return failure("merge-failed", "历史复制失败，合并未开始");
  }

  // 第二阶段：在 room 队列内按最新画布重新校验并提交单批 patch + remove。
  const derive = async (latest: ServerCanvas) => {
    const rechecked = await revalidateInQueue(deps, latest, request, planned.plan);
    if (!rechecked.ok) return rechecked;
    const expectedNodeData: Record<string, unknown> = {
      [targetNodeId]: latest.nodeData[targetNodeId] ?? null,
      [sourceNodeId]: latest.nodeData[sourceNodeId] ?? null
    };
    const built = buildMergeCommands(
      {
        targetNodeId,
        sourceNodeId,
        kind: planned.plan.kind,
        modelPlacement: planned.plan.modelPlacement,
        expectedNodeData
      },
      planned.plan.entry
    );
    if (!built.ok) return built;
    return {
      ok: true as const,
      batch: {
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId,
        baseRevision: latest.revision,
        actorId: NODE_HISTORY_MERGE_ACTOR,
        commands: built.commands
      },
      modelBatch: { submissionHash: requestHash, nodes: [] }
    };
  };

  const submitted = await submitMerge(room, commandId, requestHash, derive);
  if (!submitted.ok) {
    await compensate(context, canvasId, targetNodeId, sourceNodeId, insertedIds, submitted.code);
    return failure(
      submitted.code === "conflict" ? "conflict" : "merge-failed",
      submitted.message
    );
  }

  // 批次成功后才删除来源历史；失败路径绝不删。
  await deleteNodeHistory(context, canvasId, sourceNodeId);
  const evicted = await enforceCapacityAndCount(deps, canvasId, targetNodeId);
  context.log({
    event: "node-history-merged",
    canvasId,
    targetNodeId,
    sourceNodeId,
    copied: insertedIds.length,
    duplicates,
    evicted,
    revision: submitted.revision,
    compensated: false
  });
  return {
    ok: true,
    targetNodeId,
    sourceNodeId,
    revision: submitted.revision,
    copied: insertedIds.length,
    duplicates,
    evicted,
    alreadyMerged: false
  };
}

/** 第一阶段校验：节点资格、类型、进行中状态、来源当前版本与媒体可恢复性。 */
async function planMerge(
  deps: MergeDependencies,
  canvas: ServerCanvas,
  input: MergeNodeHistoryInput
): Promise<{ ok: true; plan: MergePlan } | ValidationFailure> {
  const { context } = deps;
  const { canvasId, targetNodeId, sourceNodeId } = input;
  const source = canvas.document.nodes.find((node) => node.id === sourceNodeId);
  const target = canvas.document.nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) {
    return { ok: false, code: "unknown-node", message: "来源或目标节点不存在于该画布" };
  }
  if (source.type !== target.type) {
    return { ok: false, code: "invalid-node-type", message: "只能合并同类型节点" };
  }
  const kind = historyKindForNodeType(target.type);
  if (!kind || !nodeTypesForHistoryKind(kind).includes(source.type)) {
    return { ok: false, code: "invalid-node-type", message: `节点类型 ${target.type} 不提供合并` };
  }
  if (!isMergeEligibleNode({ node: source, data: canvas.nodeData[sourceNodeId] }) ||
      !isMergeEligibleNode({ node: target, data: canvas.nodeData[targetNodeId] })) {
    return { ok: false, code: "invalid-node-type", message: "组、托管节点、预览或复合资产不能参与合并" };
  }
  const sourceData = canvas.nodeData[sourceNodeId] as Record<string, unknown> | undefined;
  const targetData = canvas.nodeData[targetNodeId] as Record<string, unknown> | undefined;
  if (isActiveGeneration(sourceData) || isActiveGeneration(targetData)) {
    return { ok: false, code: "conflict", message: "节点存在进行中的生成，无法合并" };
  }
  if (deps.hasActiveEditSession) {
    if (await deps.hasActiveEditSession(canvasId, sourceNodeId) ||
        await deps.hasActiveEditSession(canvasId, targetNodeId)) {
      return { ok: false, code: "conflict", message: "节点存在未结算的编辑会话，无法合并" };
    }
  }

  const sourceIdentity = currentIdentityOf(canvas, sourceNodeId, kind);
  if (sourceIdentity === null) {
    return { ok: false, code: "no-current-version", message: "来源节点没有可合并的当前版本" };
  }
  const entries = await context.repository.listForNode(canvasId, sourceNodeId);
  const entry = entries.find((candidate) =>
    candidate.kind === kind
    && candidate.currentIdentity === sourceIdentity
    && candidate.payload.kind !== "failure"
  );
  if (!entry) {
    return { ok: false, code: "no-current-version", message: "来源节点的当前内容没有对应的历史版本" };
  }
  if (!entry.recoverable) {
    return { ok: false, code: "unrecoverable", message: "来源节点的当前历史版本不可恢复" };
  }
  if (entry.kind === "image" || entry.kind === "video" || entry.kind === "audio") {
    const payload = entry.payload as NodeHistoryMediaPayload;
    const scope = { canvasId };
    if (!(await isMediaResolvable(context, payload, scope))) {
      if (entry.recoverable) await context.repository.markUnrecoverable(canvasId, entry.nodeId, entry.entryId);
      return { ok: false, code: "unrecoverable", message: "来源当前版本的媒体对象已不可用" };
    }
    if (entry.kind === "image" && payload.imageEdit) {
      if (!payload.base || !(await mediaExists(context, payload.base.storageKey, scope))) {
        if (entry.recoverable) await context.repository.markUnrecoverable(canvasId, entry.nodeId, entry.entryId);
        return { ok: false, code: "unrecoverable", message: "来源当前版本所需的图片原图已不可用" };
      }
      if (payload.project && !(await mediaExists(context, payload.project.storageKey, scope))) {
        if (entry.recoverable) await context.repository.markUnrecoverable(canvasId, entry.nodeId, entry.entryId);
        return { ok: false, code: "unrecoverable", message: "来源当前版本所需的图片工程对象已不可用" };
      }
    }
  }

  const targetIdentity = currentIdentityOf(canvas, targetNodeId, kind);
  if (input.expectedSourceCurrentIdentity !== undefined && input.expectedSourceCurrentIdentity !== sourceIdentity) {
    return { ok: false, code: "conflict", message: "来源节点当前内容已被其它写入改变，合并被拒绝" };
  }
  if (input.expectedTargetCurrentIdentity !== undefined && input.expectedTargetCurrentIdentity !== targetIdentity) {
    return { ok: false, code: "conflict", message: "目标节点当前内容已被其它写入改变，合并被拒绝" };
  }
  const state = currentNodeStateOf(canvas, sourceNodeId, kind);
  return {
    ok: true,
    plan: {
      kind,
      sourceIdentity,
      targetIdentity,
      entry,
      modelPlacement: state.placement
    }
  };
}

/** 队列内复核：来源/目标仍存在且内容身份未变；无进行中生成或未结算会话。 */
async function revalidateInQueue(
  deps: MergeDependencies,
  latest: ServerCanvas,
  input: MergeNodeHistoryInput,
  plan: MergePlan
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const source = latest.document.nodes.find((node) => node.id === input.sourceNodeId);
  const target = latest.document.nodes.find((node) => node.id === input.targetNodeId);
  if (!source || !target) return { ok: false, code: "unknown-node", message: "来源或目标节点已被删除" };
  if (source.type !== target.type || !isMergeEligibleNode({ node: source, data: latest.nodeData[input.sourceNodeId] }) ||
      !isMergeEligibleNode({ node: target, data: latest.nodeData[input.targetNodeId] })) {
    return { ok: false, code: "invalid-node-type", message: "节点类型已变化，无法合并" };
  }
  if (isActiveGeneration(latest.nodeData[input.sourceNodeId] as Record<string, unknown> | undefined) ||
      isActiveGeneration(latest.nodeData[input.targetNodeId] as Record<string, unknown> | undefined)) {
    return { ok: false, code: "conflict", message: "节点开始了新的生成，合并被取消" };
  }
  if (deps.hasActiveEditSession && (
    await deps.hasActiveEditSession(input.canvasId, input.sourceNodeId) ||
    await deps.hasActiveEditSession(input.canvasId, input.targetNodeId)
  )) {
    return { ok: false, code: "conflict", message: "节点开始了新的编辑会话，合并被取消" };
  }
  const kind = historyKindForNodeType(target.type);
  if (!kind || currentIdentityOf(latest, input.sourceNodeId, kind) !== plan.sourceIdentity) {
    return { ok: false, code: "conflict", message: "来源节点当前内容已改变，合并被拒绝" };
  }
  if (currentIdentityOf(latest, input.targetNodeId, kind) !== plan.targetIdentity) {
    return { ok: false, code: "conflict", message: "目标节点当前内容已改变，合并被拒绝" };
  }
  return { ok: true };
}

/** 生成单批命令：目标内容切换 + 来源当前版本模型摆放显式写回 + 删除来源节点。 */
function buildMergeCommands(
  input: {
    targetNodeId: string;
    sourceNodeId: string;
    kind: NodeGenerationKind;
    modelPlacement: NodeHistoryModelPlacement | null;
    expectedNodeData: Record<string, unknown>;
  },
  entry: NodeGenerationHistoryEntry
): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
  const built = buildRestoreCommands(input.targetNodeId, entry);
  if (!built.ok) return built;
  const commands = [...built.commands];
  const index = commands.findIndex((command) =>
    command.type === "nodeData.patch" && command.nodeId === input.targetNodeId
  );
  if (index < 0) {
    return { ok: false, code: "merge-failed", message: "恢复命令缺少目标内容写入" };
  }
  const patch = commands[index] as Extract<CanvasCommand, { type: "nodeData.patch" }>;
  // 模型当前身份包含摆放：来源条目未携带摆放时必须显式写 null（批次里始终有摆放语义），
  // 由 reducer 归一化为默认摆放，使目标内容与来源当前版本等价；来源带摆放时写回后身份完全一致。
  const value = input.kind === "model"
    ? {
        ...((patch.value ?? {}) as Record<string, unknown>),
        modelPlacement: input.modelPlacement,
        modelScriptStatus: "ok",
        modelScriptError: null
      }
    : patch.value;
  commands[index] = {
    ...patch,
    value: value as never,
    expectedNodeData: input.expectedNodeData as never
  };
  commands.push({ type: "node.remove", nodeIds: [input.sourceNodeId] });
  return { ok: true, commands };
}

type SubmitResult =
  | { ok: true; revision: number }
  | { ok: false; code: string; message: string };

/** 优先走 `submitDerived`；最小端口只有 `submit` 时在导出快照上派生后提交。 */
async function submitMerge(
  room: NodeHistoryRoomPort,
  commandId: string,
  requestHash: string,
  derive: Parameters<NonNullable<NodeHistoryRoomPort["submitDerived"]>>[0]["derive"]
): Promise<SubmitResult> {
  if (room.submitDerived) {
    const result = await room.submitDerived({
      commandId,
      expectedModelBatchHash: requestHash,
      derive
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, revision: result.revision };
  }
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const derived = await derive(exported.canvas);
  if (!derived.ok) return { ok: false, code: derived.code, message: derived.message };
  const result = await room.submit(derived.batch);
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true, revision: result.revision };
}

/** 批次失败：只删本次新增的复制条目，来源历史与目标内容保持不变。 */
async function compensate(
  context: NodeHistoryServiceContext,
  canvasId: string,
  targetNodeId: string,
  sourceNodeId: string,
  insertedIds: readonly string[],
  code: string
): Promise<void> {
  if (insertedIds.length > 0) {
    try {
      await context.repository.delete(canvasId, insertedIds);
    } catch {
      // 补偿失败不掩盖原始错误：孤儿行不丢数据（design Risks）。
    }
  }
  context.log({
    event: "node-history-merge-failed",
    canvasId,
    targetNodeId,
    sourceNodeId,
    code,
    compensated: insertedIds.length > 0
  });
}

/** 执行容量清理并统计被淘汰条目数（节点级 + 画布级）。 */
async function enforceCapacityAndCount(
  deps: MergeDependencies,
  canvasId: string,
  targetNodeId: string
): Promise<number> {
  const beforeNode = (await deps.context.repository.listForNode(canvasId, targetNodeId)).length;
  const beforeCanvas = await deps.context.repository.canvasStats(canvasId);
  await deps.enforceCapacity(canvasId, targetNodeId);
  const afterNode = (await deps.context.repository.listForNode(canvasId, targetNodeId)).length;
  const afterCanvas = await deps.context.repository.canvasStats(canvasId);
  const nodeEvicted = Math.max(0, beforeNode - afterNode);
  const canvasEvicted = Math.max(0, beforeCanvas.count - nodeEvicted - afterCanvas.count);
  return nodeEvicted + canvasEvicted;
}

/** 供测试/诊断读取模型历史 payload 的摆放（避免重复解码逻辑）。 */
export function modelPlacementOfPayload(payload: NodeHistoryModelPayload): NodeHistoryModelPlacement | undefined {
  return payload.placement;
}
