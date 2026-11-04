/**
 * 命令 reducer 的最终规范化与提交判定。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。把工作副本一次性写回规范聚合；`changed` 由显式比较得出。
 */
import { reconcileInputMappings } from "../domain/input-mapping.js";
import { normalizeCanvas, toWoohaa3CanvasDocument, type CanvasNodeData, type ServerCanvas } from "../domain/index.js";
import type { ApplyCanvasCommandsResult, WorkingState } from "./types.js";

/**
 * 把工作副本写回规范聚合。
 *
 * 复用 `toWoohaa3CanvasDocument`（含网格吸附与视口钳制），与 Web Store 的 `commitCanvas`
 * 语义一致。`changed` 由显式比较得出：无净变化时 revision
 * 不递增，调用方据此记录可幂等返回的结果。
 */
export function finalize(canvas: ServerCanvas, work: WorkingState, now: string): ApplyCanvasCommandsResult {
  const document = toWoohaa3CanvasDocument({ nodes: work.nodes, edges: work.edges }, now);

  const candidate: ServerCanvas = {
    ...canvas,
    title: work.title,
    document,
    nodeData: work.nodeData as ServerCanvas["nodeData"],
    assets: work.assets,
    jobs: work.jobs,
    updatedAt: now
  };

  // 关键：经 domain 规范化，剥离 Blob/base64/函数等非 JSON 值、剪枝孤儿 nodeData，
  // 与 Web Store 的 `commitCanvas` 落到同一规范形态。
  const normalized = normalizeCanvas(candidate, { content: work.content });

  // 输入 mapping 生命周期收敛（change: add-reference-inputs-and-mentions，任务 2.1）：
  // 生成最终 document 后运行 reconciliation，使 edge 与稳定 slot 在同一提交内一致，
  // 并保留已有 slotId/sourceAssetIds/label（design D1/D2）。
  const reconciled: ServerCanvas = {
    ...normalized,
    nodeData: reconcileInputMappings(
      normalized.nodeData as Record<string, CanvasNodeData>,
      normalized.document
    ) as ServerCanvas["nodeData"]
  };

  const changed = !isSameCommittedState(canvas, reconciled);
  return { ok: true, canvas: changed ? reconciled : canvas, changed };
}

export function isSameCommittedState(a: ServerCanvas, b: ServerCanvas): boolean {
  // Position edits need not serialize unrelated model scripts/assets/jobs.
  // Keep JSON equality (including property order), rather than reference equality.
  if (JSON.stringify(a.document.nodes) !== JSON.stringify(b.document.nodes)) return false;
  return JSON.stringify({
    title: a.title ?? "",
    edges: a.document.edges,
    nodeData: a.nodeData,
    assets: a.assets,
    jobs: a.jobs
  }) === JSON.stringify({
    title: b.title ?? "",
    edges: b.document.edges,
    nodeData: b.nodeData,
    assets: b.assets,
    jobs: b.jobs
  });
}
