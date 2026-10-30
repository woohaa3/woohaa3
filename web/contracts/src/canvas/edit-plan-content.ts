/**
 * owner 内容节点的历史净差异（change: 2026-10-28-generic-extension-content-ownership，任务 2.4）。
 *
 * 复合资产 nodeData 的 forward/inverse 由 owner `diff` 决定；内核只把结果包成受保护的
 * `node-data-set` 操作，并用整份 nodeData 前置条件保证撤销不会覆盖并发修改。owner 失败时
 * 整次规划失败，调用方不得产生可撤销记录或半提交。
 */
import { isCompositeAssetNodeType, readCompositeAssetExtensionId } from "./domain/core/composite-asset-identity.js";
import type { ContentContributionResolver } from "./content-contribution.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

export type ContentNodeDataDiffPlan = {
  nodeIds: ReadonlySet<string>;
  forwardOps: import("./edit-command.js").EditOperation[];
  inverseOps: import("./edit-command.js").EditOperation[];
  forwardPre: import("./edit-command.js").EditPrecondition[];
  inversePre: import("./edit-command.js").EditPrecondition[];
};

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Record<string, unknown>)[key]]))
      : entry);
}

function isDataObject(value: unknown): value is CanvasNodeData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planContentNodeDataDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  nodes: readonly Woohaa3CanvasSerializedNode[],
  content: ContentContributionResolver | undefined,
  exclude: ReadonlySet<string> = new Set()
): ContentNodeDataDiffPlan | { ok: false; reason: string } {
  const nodeIds = new Set<string>();
  const forwardOps: import("./edit-command.js").EditOperation[] = [];
  const inverseOps: import("./edit-command.js").EditOperation[] = [];
  const forwardPre: import("./edit-command.js").EditPrecondition[] = [];
  const inversePre: import("./edit-command.js").EditPrecondition[] = [];
  for (const node of nodes) {
    if (exclude.has(node.id) || !isCompositeAssetNodeType(node.type) || !content) continue;
    const previous = before.nodeData[node.id];
    const next = after.nodeData[node.id];
    const extensionId = readCompositeAssetExtensionId(next ?? previous);
    const codec = extensionId ? content.resolve(extensionId)?.nodeData : null;
    if (!codec) continue;
    if (sameJson(previous, next)) continue;
    // owner 的 diff 只处理业务数据；结构字段由通用路径处理。
    let diff: Awaited<ReturnType<typeof codec.diff>>;
    try {
      diff = codec.diff(previous ?? {}, next ?? {}, {
        nodeIds: new Map([[node.id, node.id]]),
        createId: (prefix, index) => `${prefix}-diff-${index}`
      });
    } catch {
      return { ok: false, reason: `content-diff-failed:${extensionId}` };
    }
    if (!diff.ok) return { ok: false, reason: diff.code };
    if (!isDataObject(diff.forward) || !isDataObject(diff.inverse)) {
      return { ok: false, reason: `content-diff-invalid:${extensionId}` };
    }
    nodeIds.add(node.id);
    forwardOps.push({ kind: "node-data-set", nodeId: node.id, value: diff.forward });
    inverseOps.push({ kind: "node-data-set", nodeId: node.id, value: diff.inverse });
    forwardPre.push(previous === undefined
      ? { kind: "node-data-equals", nodeId: node.id, present: false }
      : { kind: "node-data-equals", nodeId: node.id, present: true, value: previous });
    inversePre.push({ kind: "node-data-equals", nodeId: node.id, present: true, value: diff.forward });
  }
  // 其余节点由调用方的通用字段规划继续处理；这里仅返回 owner 覆盖的节点 id。
  return { nodeIds, forwardOps, inverseOps, forwardPre, inversePre };
}
