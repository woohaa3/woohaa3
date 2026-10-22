/**
 * 输入 mapping 生命周期不变量与校验
 * （change: add-reference-inputs-and-mentions，任务 1.2 / 1.3 / design D1/D2）。
 *
 * 纯函数、无副作用。规定：
 * - 每个合法 incoming source 在目标节点上**恰好一条** mapping；
 * - 目标节点内 `slotId` 唯一、`sourceNodeId` 唯一；
 * - `sortKey` 确定且可重排（重排只改 sortKey，不动 slotId）；
 * - 已有 mapping 的 `slotId` / `sourceAssetIds` / label / 扩展字段永不重算（design D2）。
 */
import { ensureWoohaa3CanvasInputMappingSlotId, sortWoohaa3CanvasInputMappings } from "./core";
import type { CanvasNodeInputMapping } from "./types";

export type MappingInvariantViolation =
  | { kind: "duplicate-slot"; nodeId: string; slotId: string }
  | { kind: "duplicate-source"; nodeId: string; sourceNodeId: string }
  | { kind: "missing-slot"; nodeId: string; sourceNodeId: string }
  | { kind: "unknown-source"; nodeId: string; sourceNodeId: string }
  | { kind: "nondeterministic-order"; nodeId: string };

export type MappingInvariantInput = {
  nodeId: string;
  /** 目标节点当前合法 incoming source 集合（决定“应有”的 mapping）。 */
  incomingSources: readonly string[];
  mappings: readonly CanvasNodeInputMapping[];
};

/**
 * 校验目标节点 mapping 是否满足稳定槽不变量。
 * 返回全部违规项（空数组表示一致）。
 */
export function validateInputMappingInvariants(input: MappingInvariantInput): MappingInvariantViolation[] {
  const violations: MappingInvariantViolation[] = [];
  const incoming = new Set(input.incomingSources);
  const slotIds = new Set<string>();
  const sources = new Set<string>();

  for (const mapping of input.mappings) {
    const slotId = mapping.slotId;
    if (typeof slotId !== "string" || slotId === "") {
      violations.push({ kind: "missing-slot", nodeId: input.nodeId, sourceNodeId: mapping.sourceNodeId });
    } else if (slotIds.has(slotId)) {
      violations.push({ kind: "duplicate-slot", nodeId: input.nodeId, slotId });
    } else {
      slotIds.add(slotId);
    }
    if (!incoming.has(mapping.sourceNodeId)) {
      violations.push({ kind: "unknown-source", nodeId: input.nodeId, sourceNodeId: mapping.sourceNodeId });
    }
    if (sources.has(mapping.sourceNodeId)) {
      violations.push({ kind: "duplicate-source", nodeId: input.nodeId, sourceNodeId: mapping.sourceNodeId });
    } else {
      sources.add(mapping.sourceNodeId);
    }
  }

  // 每个 incoming source 必须有 mapping。
  for (const sourceNodeId of input.incomingSources) {
    if (!sources.has(sourceNodeId)) {
      violations.push({ kind: "missing-slot", nodeId: input.nodeId, sourceNodeId });
    }
  }

  // 排序必须确定：按 sortKey 排序后与声明顺序一致（否则视为不确定）。
  const sorted = sortWoohaa3CanvasInputMappings(input.mappings);
  const deterministic = sorted.every((mapping, index) => mapping === input.mappings[index]);
  if (!deterministic) violations.push({ kind: "nondeterministic-order", nodeId: input.nodeId });

  return violations;
}

/**
 * 规范化一组 mapping，使其落回合法一致状态：
 * 1. 删除 source 不在 incoming 中的 mapping；
 * 2. 保留已有 slotId（不为已存在的 mapping 重算）；
 * 3. 为缺失 mapping 的 source 生成稳定 slot；
 * 4. 去重同一 source（保留首条）；
 * 5. 按 sortKey 稳定排序（重排只改顺序，不改 slotId）。
 *
 * 生成新 slot 时使用 `sourceNodeId + 位置` 的确定性 helper（backfill 语义）；已存在 slot
 * 的 mapping 原样保留。
 */
export function normalizeInputMappings(options: {
  nodeId: string;
  incomingSources: readonly string[];
  mappings: readonly CanvasNodeInputMapping[];
  /** 生成缺失 mapping 时使用的 role（按 source 顺序）。 */
  roleForSource: (sourceNodeId: string, existingRoles: readonly string[]) => string;
}): CanvasNodeInputMapping[] {
  const incomingSet = new Set(options.incomingSources);
  const kept: CanvasNodeInputMapping[] = [];
  const seenSources = new Set<string>();

  for (const mapping of options.mappings) {
    if (!incomingSet.has(mapping.sourceNodeId)) continue;
    if (seenSources.has(mapping.sourceNodeId)) continue;
    seenSources.add(mapping.sourceNodeId);
    kept.push(ensureWoohaa3CanvasInputMappingSlotId(mapping));
  }

  const result = [...kept];
  for (const sourceNodeId of options.incomingSources) {
    if (seenSources.has(sourceNodeId)) continue;
    result.push(
      ensureWoohaa3CanvasInputMappingSlotId({
        sourceNodeId,
        role: options.roleForSource(sourceNodeId, result.map((mapping) => mapping.role)),
        sortKey: String(result.length)
      })
    );
    seenSources.add(sourceNodeId);
  }

  return sortWoohaa3CanvasInputMappings(result);
}

/**
 * 重排 mapping：只更新 `sortKey`，保留 `slotId` / `sourceAssetIds` / role / 扩展字段。
 * `orderedSourceIds` 未覆盖的 mapping 追加在后（保持原相对顺序）。
 */
export function reorderInputMappings(
  mappings: readonly CanvasNodeInputMapping[],
  orderedSourceIds: readonly string[]
): CanvasNodeInputMapping[] {
  const rank = new Map(orderedSourceIds.map((id, index) => [id, index]));
  return [...mappings]
    .map((mapping, index) => ({ mapping, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.mapping.sourceNodeId) ?? Number.POSITIVE_INFINITY;
      const rightRank = rank.get(right.mapping.sourceNodeId) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ mapping }, index) => ({ ...mapping, sortKey: String(index) }));
}

export type InputMappingBackfillChange = {
  nodeId: string;
  before: CanvasNodeInputMapping[];
  after: CanvasNodeInputMapping[];
};

/**
 * 幂等 slot backfill（任务 1.3 / design D2）。
 *
 * 对整份 `nodeData` 逐节点补齐缺失 slot、删除悬空 source、稳定排序，**只补元数据**：
 * 不改 edge、不改 role 语义之外的字段、不改输出资产。重复运行结果不变（返回 changes 为空）。
 *
 * 迁移应先在 dry-run 下检查 `changes` 数量与内容，再作为权威 Canvas 命令提交。
 */
export function backfillInputMappingSlots(options: {
  nodeData: Record<string, { inputMapping?: CanvasNodeInputMapping[] }>;
  edges: readonly { source: string; target: string }[];
  nodeIds: readonly string[];
  roleForSource: (nodeId: string, sourceNodeId: string, existingRoles: readonly string[]) => string;
}): { nodeData: Record<string, { inputMapping?: CanvasNodeInputMapping[] }>; changes: InputMappingBackfillChange[] } {
  const validNodes = new Set(options.nodeIds);
  const sourcesByTarget = new Map<string, string[]>();
  for (const edge of options.edges) {
    if (!validNodes.has(edge.source) || !validNodes.has(edge.target)) continue;
    const list = sourcesByTarget.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    sourcesByTarget.set(edge.target, list);
  }

  const next = { ...options.nodeData };
  const changes: InputMappingBackfillChange[] = [];
  for (const nodeId of Object.keys(options.nodeData)) {
    const data = options.nodeData[nodeId];
    if (!data) continue;
    const before = Array.isArray(data.inputMapping) ? data.inputMapping : [];
    const incoming = sourcesByTarget.get(nodeId) ?? [];
    const after = normalizeInputMappings({
      nodeId,
      incomingSources: incoming,
      mappings: before,
      roleForSource: (sourceNodeId, existingRoles) => options.roleForSource(nodeId, sourceNodeId, existingRoles)
    });
    // 只在语义上有变化时记录（同长度且逐条 slotId 相同即视为无变化）。
    const identical =
      after.length === before.length &&
      after.every((mapping, index) => mapping.slotId === before[index]?.slotId) &&
      before.every((mapping) => mapping.slotId !== undefined);
    if (!identical) changes.push({ nodeId, before, after });
    next[nodeId] = { ...data, inputMapping: after };
  }
  return { nodeData: next, changes };
}
