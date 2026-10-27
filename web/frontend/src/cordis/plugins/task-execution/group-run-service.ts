/**
 * 分组批量执行服务（change: 2026-10-16-add-group-selection-toolbar，任务 1.2/1.3/1.4 / design D4/D5）。
 *
 * 单一入口同时提供：
 * - **只读预览** `preview(groupId)`：递归展开 group 非 group 后代，逐叶子复用
 *   `resolveLeafRunPrecheck` 统计可提交数量 N 与跳过原因；不发请求、不生成 runId、不创建任务。
 * - **提交** `runGroup(groupId)`：点击时重新预检并**冻结**本次 canvasId/groupId/成员与输入快照，
 *   在任何 await 前按 `(canvasId, groupId)` 取提交锁、按 `(canvasId, nodeId)` 预占叶子，
 *   逐个复用单节点提交；每次实际请求前再复核资格。
 * - **提交中查询** `isSubmitting(groupId)` 与 `subscribe` 供横条与右键共享门禁/文案。
 *
 * 锁与预占只表示**请求编排**：不写 canonical、不生成分组 taskStatus/runId/job、不把未请求成员标为
 * 排队。所有完成、拒绝、异常与页面失效路径都清理编排状态。
 *
 * 纯逻辑 + 注入依赖，便于单测（不依赖 DOM / fetch）。
 */
import type { CanvasTaskCatalog, CanvasTaskModelType, ServerCanvas } from "@woohaa3/contracts";
import type { SubmitCoordinator, SubmitInput } from "./submit-coordinator.js";
import { collectGroupLeafDescendants } from "./group-leaf-resolution.js";
import { resolveLeafRunPrecheck, type LeafRunPrecheckInput } from "./leaf-run-precheck.js";
import type { CatalogState } from "../../contracts.js";
import type {
  GroupRunPreview,
  GroupRunPreviewEntry,
  GroupRunService,
  GroupRunSkipCategory,
  GroupRunSummary
} from "../service-keys.js";

export type { GroupRunPreview, GroupRunPreviewEntry, GroupRunService, GroupRunSkipCategory, GroupRunSummary };

export type GroupRunServiceOptions = {
  /** 当前 canvasId；用于固定身份并给锁/预占分区。 */
  canvasId: () => string;
  /** 当前 working 画布；页面失效时返回 null。 */
  getCanvas: () => ServerCanvas | null;
  /** 当前目录状态。 */
  catalogState: () => CatalogState;
  /** 当前会话是否可写（提交门禁）。 */
  isWritable: () => boolean;
  /** 读取 `{nodeId, modelKey}` 分区草稿。 */
  readDraft?: (nodeId: string, modelKey: string) => { prompt?: string; parameters?: Record<string, unknown> } | undefined;
  /** 统一运行状态 busy 查询（任一 owner 的非终态操作）。 */
  isBusy?: (nodeId: string) => boolean;
  /** 提交单个叶子（复用单节点 `SubmitCoordinator`）。 */
  submit: SubmitCoordinator["submit"];
  /** 每批提交结束回调（供宿主给出结果摘要）。 */
  textPrecheck?: (canvas: ServerCanvas, nodeId: string) => { eligible: true; input: import("../../contract/agent-conversation.js").AgentConversationSubmitInput } | { eligible: false; reason: string };
  submitText?: (input: import("../../contract/agent-conversation.js").AgentConversationSubmitInput) => Promise<{ ok: boolean; error?: string }>;
  onSummary?: (summary: GroupRunSummary) => void;
};

type FrozenMember = {
  nodeId: string;
  /** 冻结时的输入快照（模型身份与参数）；请求前仍复核当前资格。 */
  textInput?: import("../../contract/agent-conversation.js").AgentConversationSubmitInput;
  snapshot: { modelKey: string; prompt: string; parameters: Record<string, unknown>; expectedModelType: CanvasTaskModelType };
};

const SKIP_RUNNING = "成员已在执行中";

/** 归类单节点阻止原因（用于预览的跳过类别与结果摘要）。 */
export function categorizeSkipReason(reason: string): GroupRunSkipCategory {
  if (reason === SKIP_RUNNING) return "running";
  if (reason.includes("下线") || reason.includes("不可用") || reason.includes("没有可用模型")) {
    return "model-unavailable";
  }
  if (reason.includes("不存在") || reason.includes("不支持")) return "not-runnable";
  return "input-missing";
}

export function createGroupRunService(options: GroupRunServiceOptions): GroupRunService {
  const listeners = new Set<() => void>();
  /** `(canvasId, groupId)` 提交锁：表示有本页批次正在编排该分组。 */
  const submittingGroups = new Set<string>();
  /** `(canvasId, nodeId)` 批量预占：跨分组共享，防止嵌套组交叠重复提交同一叶子。 */
  const reservedLeaves = new Set<string>();
  let disposed = false;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const groupKey = (canvasId: string, groupId: string) => `${canvasId}\u0000${groupId}`;
  const leafKey = (canvasId: string, nodeId: string) => `${canvasId}\u0000${nodeId}`;

  const precheckInput = (
    canvas: ServerCanvas,
    nodeId: string,
    catalog: CanvasTaskCatalog | null,
    catalogState: CatalogState
  ): LeafRunPrecheckInput => ({
    canvas,
    nodeId,
    catalog,
    catalogState,
    ...(options.readDraft ? { readDraft: options.readDraft } : {}),
    ...(options.isBusy ? { isBusy: options.isBusy } : {}),
    isReserved: (id) => reservedLeaves.has(leafKey(options.canvasId(), id))
  });

  function preview(groupNodeId: string): GroupRunPreview {
    const canvas = options.getCanvas();
    const disabled: GroupRunPreview = { groupId: groupNodeId, count: 0, skipped: [], enabled: false };
    if (!canvas) return { ...disabled, reason: "作品尚未加载" };
    const writable = options.isWritable();
    if (!writable) return { ...disabled, reason: "当前会话不可写（画布只读）" };

    const catalogState = options.catalogState();
    const catalog = catalogState.status === "ready" ? catalogState.catalog : null;

    const leafIds = collectGroupLeafDescendants(canvas.document.nodes, groupNodeId);
    const skipped: GroupRunPreviewEntry[] = [];
    let count = 0;
    let running = 0;
    for (const nodeId of leafIds) {
      const text = canvas.document.nodes.find(node => node.id === nodeId)?.type === "text";
      if (text) {
        if (options.isBusy?.(nodeId) || reservedLeaves.has(leafKey(options.canvasId(), nodeId))) { skipped.push({ nodeId, reason: SKIP_RUNNING, category: "running" }); running++; continue; }
        const result = options.textPrecheck?.(canvas, nodeId);
        if (result?.eligible) count++;
        else skipped.push({ nodeId, reason: result?.reason ?? "请为文本成员连接助手", category: "input-missing" });
        continue;
      }
      const result = resolveLeafRunPrecheck(precheckInput(canvas, nodeId, catalog, catalogState));
      if (result.eligible) {
        count += 1;
        continue;
      }
      if (result.running) running += 1;
      skipped.push({
        nodeId,
        category: categorizeSkipReason(result.reason ?? ""),
        reason: result.reason ?? "不可提交"
      });
    }
    if (count === 0) {
      const reason = leafIds.length === 0
        ? "分组内没有可执行成员"
        : running === leafIds.length
          ? "成员均在运行中"
          : catalogState.status === "loading" ? "任务目录尚未加载" : catalogState.status === "error" ? `任务目录加载失败：${catalogState.error}` : "没有可提交的任务（检查提示词、模型与参考素材）";
      return { groupId: groupNodeId, count: 0, skipped, enabled: false, reason };
    }
    return { groupId: groupNodeId, count, skipped, enabled: true };
  }

  /**
   * 点击时冻结成员与输入快照；只纳入当前可提交的叶子（N 的同一预检），并把其余叶子的
   * 当前跳过原因一并返回，使零受理摘要也能说明真实原因（design D4/D6）。
   */
  function freezeMembers(
    canvas: ServerCanvas,
    groupNodeId: string
  ): { members: FrozenMember[]; skipped: Array<{ nodeId: string; reason: string }> } {
    const catalogState = options.catalogState();
    const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
    const leafIds = collectGroupLeafDescendants(canvas.document.nodes, groupNodeId);
    const members: FrozenMember[] = [];
    const skipped: Array<{ nodeId: string; reason: string }> = [];
    for (const nodeId of leafIds) {
      if (canvas.document.nodes.find(node => node.id === nodeId)?.type === "text") {
        const result = options.textPrecheck?.(canvas, nodeId);
        if (options.isBusy?.(nodeId)) skipped.push({ nodeId, reason: SKIP_RUNNING });
        else if (result?.eligible && options.submitText) members.push({ nodeId, textInput: structuredClone(result.input), snapshot: { modelKey: "", prompt: result.input.entry.prompt, parameters: {}, expectedModelType: "language" } });
        else skipped.push({ nodeId, reason: result && !result.eligible ? result.reason : "请为文本成员连接助手" });
        continue;
      }
      const result = resolveLeafRunPrecheck(precheckInput(canvas, nodeId, catalog, catalogState));
      if (!result.eligible || !result.input) {
        skipped.push({ nodeId, reason: result.reason ?? "不可提交" });
        continue;
      }
      members.push({
        nodeId,
        snapshot: {
          modelKey: result.input.modelKey,
          prompt: result.input.prompt,
          parameters: result.input.parameters,
          expectedModelType: result.input.expectedModelType
        }
      });
    }
    return { members, skipped };
  }

  async function runGroup(groupNodeId: string, origin?: SubmitInput["origin"]): Promise<GroupRunSummary> {
    const summary: GroupRunSummary = { groupId: groupNodeId, accepted: [], skipped: [], failed: [] };
    const canvasId = options.canvasId();
    // 在任何 await 前取得同组提交锁；已在编排同一组时不重复发起。
    const key = groupKey(canvasId, groupNodeId);
    if (disposed || submittingGroups.has(key)) return summary;
    const canvas = options.getCanvas();
    if (!canvas) {
      summary.skipped.push({ nodeId: groupNodeId, reason: "作品尚未加载" });
      return summary;
    }
    if (!options.isWritable()) {
      summary.skipped.push({ nodeId: groupNodeId, reason: "当前会话不可写（画布只读）" });
      return summary;
    }
    const frozen = freezeMembers(canvas, groupNodeId);
    if (frozen.members.length === 0) {
      // 无成员可提交：把每个叶子的真实原因写入摘要，而不是统一误报一种原因（spec「没有成员被受理
      // 时说明真实原因」）。
      summary.skipped.push(
        ...(frozen.skipped.length > 0 ? frozen.skipped : [{ nodeId: groupNodeId, reason: "没有可提交的成员" }])
      );
      options.onSummary?.(summary);
      return summary;
    }
    summary.skipped.push(...frozen.skipped);
    const members = frozen.members;

    submittingGroups.add(key);
    emit();
    try {
      for (const member of members) {
        // 跨分组共享叶子预占：先占，避免嵌套组交叠重复提交（先于资格复核以给出精确原因）。
        const leaf = leafKey(canvasId, member.nodeId);
        if (reservedLeaves.has(leaf)) {
          summary.skipped.push({ nodeId: member.nodeId, reason: SKIP_RUNNING });
          continue;
        }
        // 每个请求前复核：页面身份、写权限、成员存在且仍归属于该分组、模型可用性与运行状态。
        const eligibility = recheckMember(canvasId, groupNodeId, member);
        if (!eligibility.ok) {
          summary.skipped.push({ nodeId: member.nodeId, reason: eligibility.reason });
          continue;
        }
        reservedLeaves.add(leaf);
        emit();
        try {
          if (member.textInput && options.submitText) {
            const outcome = await options.submitText(member.textInput);
            if (outcome.ok) summary.accepted.push(member.nodeId);
            else summary.failed.push({ nodeId: member.nodeId, error: outcome.error ?? "文本提交失败" });
            continue;
          }
          const outcome = await options.submit({
            origin,
            nodeId: member.nodeId,
            modelKey: member.snapshot.modelKey,
            prompt: member.snapshot.prompt,
            parameters: member.snapshot.parameters,
            catalog: currentCatalog()!,
            expectedModelType: member.snapshot.expectedModelType
          } satisfies SubmitInput);
          if (outcome.ok) summary.accepted.push(member.nodeId);
          else summary.failed.push({ nodeId: member.nodeId, error: outcome.error });
        } catch (error) {
          // 单项异常也计入 failed 并继续其它合法成员；不留下永久预占或活动态。
          summary.failed.push({
            nodeId: member.nodeId,
            error: error instanceof Error ? error.message : "提交异常"
          });
        } finally {
          reservedLeaves.delete(leaf);
          emit();
        }
      }
    } finally {
      submittingGroups.delete(key);
      if (!disposed) {
        emit();
        options.onSummary?.(summary);
      }
    }
    return summary;
  }

  /**
   * 请求前复核：页面身份、写权限、成员仍存在且仍归属该分组、模型可用性、参数/参考素材与统一
   * 运行态。快照只决定本次输入，不绕过当前门禁（预览后的变化允许使受理数少于 N）。
   *
   * 已发出的请求不在此撤销；这里只决定**是否还能发出**后续请求。
   */
  function recheckMember(
    canvasId: string,
    groupNodeId: string,
    member: FrozenMember
  ): { ok: true } | { ok: false; reason: string } {
    if (disposed) return { ok: false, reason: "页面已释放（已跳过）" };
    if (options.canvasId() !== canvasId) return { ok: false, reason: "画布已切换（已跳过）" };
    if (!options.isWritable()) return { ok: false, reason: "当前会话不可写（已跳过）" };
    const canvas = options.getCanvas();
    if (!canvas) return { ok: false, reason: "作品尚未加载（已跳过）" };
    const node = canvas.document.nodes.find((entry) => entry.id === member.nodeId);
    if (!node) return { ok: false, reason: "成员已不存在（已跳过）" };
    // 成员必须仍归属于该分组（含嵌套：递归祖先链包含 groupId）。
    if (!belongsToGroup(canvas.document.nodes, member.nodeId, groupNodeId)) {
      return { ok: false, reason: "成员已移出该分组（已跳过）" };
    }
    // 统一运行状态阻止重复提交（不依赖滞后的 canonical taskStatus）。
    if (options.isBusy?.(member.nodeId)) return { ok: false, reason: SKIP_RUNNING };
    // 模型可用性、参数与参考素材：复用同一纯预检（当前目录/规范数据，不用过期快照绕过）。
    if (member.textInput) return { ok: true };
    const catalogState = options.catalogState();
    const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
    const current = resolveLeafRunPrecheck(precheckInput(canvas, member.nodeId, catalog, catalogState));
    if (!current.eligible) return { ok: false, reason: current.reason ?? "提交前资格已变化（已跳过）" };
    return { ok: true };
  }

  function currentCatalog(): CanvasTaskCatalog | null {
    const state = options.catalogState();
    return state.status === "ready" ? state.catalog : null;
  }

  return {
    preview,
    runGroup,
    isSubmitting: (groupNodeId) => submittingGroups.has(groupKey(options.canvasId(), groupNodeId)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      submittingGroups.clear();
      reservedLeaves.clear();
      listeners.clear();
    }
  };
}

/** 成员是否仍归属于该分组（递归祖先链，防环）。 */
export function belongsToGroup(
  nodes: readonly { id: string; parentId?: string }[],
  nodeId: string,
  groupNodeId: string
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let parentId = byId.get(nodeId)?.parentId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === groupNodeId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}
