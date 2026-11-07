import type { CanvasOperationRecord, CanvasOperationState } from "../run-state/types.js";
import type { NodeGenerationHistoryListItem } from "./types.js";

/** Disposable, safe metadata. Only explicit owner identities join activity to history. */
export type NodeExecutionPresentation = {
  presentationId: string;
  operationId?: string;
  entryId?: string;
  state: CanvasOperationState;
  createdAt: string;
  current: boolean;
  recoverable: boolean;
  localFailure: boolean;
  progress?: number;
  error?: string;
  history?: NodeGenerationHistoryListItem;
};

/** 底图版本（上传原图 / 已有图片）的来源标签，由服务端在首次生成时补登，见 node-history-service/backfill。 */
const BASELINE_LABELS: ReadonlySet<string> = new Set(["上传原图", "已有图片"]);

/** 底图是最早的一格，但它是首次生成时才补登的，createdAt 反而晚于那次生成，所以不能只按时间排。 */
function isBaseline(item: NodeExecutionPresentation): boolean {
  const entry = item.history;
  return !!entry && entry.kind === "image" && !entry.source.runId && BASELINE_LABELS.has(entry.source.label);
}

export function mergeNodeExecutionPresentation(
  records: readonly CanvasOperationRecord[], history: readonly NodeGenerationHistoryListItem[]
): NodeExecutionPresentation[] {
  const items = new Map<string, NodeExecutionPresentation>();
  for (const record of records) {
    const id = `operation:${record.operationId}`;
    const previous = items.get(id);
    // Duplicate nonterminal inputs must never undo an observed terminal result.
    if (previous && previous.state !== "queued" && previous.state !== "running"
      && (record.state === "queued" || record.state === "running")) continue;
    items.set(id, { presentationId: id, operationId: record.operationId, state: record.state,
      createdAt: previous?.createdAt ?? record.createdAt, current: false, recoverable: false,
      localFailure: record.localFailure === true, progress: record.progress, error: record.error });
  }
  for (const entry of history) {
    const operationId = entry.source.runId;
    const id = operationId ? `operation:${operationId}` : `entry:${entry.entryId}`;
    const previous = items.get(id);
    const state = entry.outcome ?? "succeeded";
    items.set(id, { presentationId: id, ...(operationId ? { operationId } : {}), entryId: entry.entryId,
      state, createdAt: previous?.createdAt ?? entry.createdAt,
      current: state === "succeeded" && entry.current,
      recoverable: state === "succeeded" && entry.recoverable, localFailure: false,
      ...(entry.preview.kind === "failure" ? { error: entry.preview.message } : {}), history: entry });
  }
  const sorted = [...items.values()].sort((a, b) => Number(isBaseline(b)) - Number(isBaseline(a))
    || a.createdAt.localeCompare(b.createdAt)
    || a.presentationId.localeCompare(b.presentationId));
  // 进行中的运行比已落库的版本都新：底图版本是首次生成时才补登的（createdAt 晚于运行记录），
  // 只按时间排会把它排到进行中的运行之后，缩略图列表里底图就跑到了最上面。
  const isActive = (item: NodeExecutionPresentation) => !item.entryId && (item.state === "queued" || item.state === "running");
  const lastEntry = sorted.map(item => !!item.entryId).lastIndexOf(true);
  const early = sorted.slice(0, lastEntry + 1);
  if (!early.some(isActive)) return sorted;
  return [...early.filter(item => !isActive(item)), ...early.filter(isActive), ...sorted.slice(lastEntry + 1)];
}

/** Shared render/hit/anchor window; retain current, active and latest failure before filling recent items. */
export function nodeExecutionWindow(items: readonly NodeExecutionPresentation[], limit = 24, selectedId?: string): NodeExecutionPresentation[] {
  const selected = new Set<NodeExecutionPresentation>();
  const retain = (item: NodeExecutionPresentation | undefined) => { if (item && selected.size < limit) selected.add(item); };
  retain(items.find(item => item.current));
  retain(items.find(item => item.presentationId === selectedId));
  for (const item of items) if (item.state === "queued" || item.state === "running") retain(item);
  retain([...items].reverse().find(item => item.state === "failed"));
  for (let index = items.length - 1; index >= 0 && selected.size < limit; index--) retain(items[index]);
  return items.filter(item => selected.has(item));
}

export function showNodeExecutionDots(items: readonly NodeExecutionPresentation[]): boolean {
  return items.length > 1 || items.some(item => item.state !== "succeeded" || !item.entryId);
}
