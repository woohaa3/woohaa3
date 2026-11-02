/**
 * 节点历史版本条的纯领域模型：版本引用、选择解析与未读策略。
 *
 * 不依赖 React / Cordis / DOM，供选择控制器、投影器和测试共用。
 */
import { visibleNodeHistoryVersions, type NodeGenerationHistoryListItem } from "@woohaa3/contracts";

export type VersionRef =
  | { kind: "current" }
  | { kind: "entry"; entryId: string }
  | { kind: "operation"; operationId: string };

export type VersionRequest = {
  nodeId: string;
  entryId?: string;
  presentationId?: string;
  operationId?: string;
  index?: number;
  step?: number;
};

export function presentationOfItem(item: NodeGenerationHistoryListItem): string {
  return item.source.runId ? `operation:${item.source.runId}` : `entry:${item.entryId}`;
}

export function presentationOfRef(ref: VersionRef): string {
  switch (ref.kind) {
    case "current": return "current";
    case "entry": return `entry:${ref.entryId}`;
    case "operation": return `operation:${ref.operationId}`;
  }
}

export function refFromPresentation(presentationId: string | undefined): VersionRef | null {
  if (!presentationId) return null;
  if (presentationId.startsWith("operation:")) return { kind: "operation", operationId: presentationId.slice("operation:".length) };
  if (presentationId.startsWith("entry:")) return { kind: "entry", entryId: presentationId.slice("entry:".length) };
  return null;
}

export function refOfItem(item: NodeGenerationHistoryListItem): VersionRef {
  return item.source.runId
    ? { kind: "operation", operationId: item.source.runId }
    : { kind: "entry", entryId: item.entryId };
}

export function itemByPresentation(
  items: readonly NodeGenerationHistoryListItem[] | undefined,
  presentationId: string
): NodeGenerationHistoryListItem | undefined {
  return items?.find(item => presentationOfItem(item) === presentationId);
}

/** 把旧的 index/step/presentation 请求解析成具体历史条目；operation 点击可没有归档条目。 */
export function resolveVersionItem(
  items: readonly NodeGenerationHistoryListItem[],
  request: VersionRequest,
  selectedId: string | undefined
): NodeGenerationHistoryListItem | undefined {
  if (request.entryId) return items.find(item => item.entryId === request.entryId);
  if (request.presentationId) {
    const item = itemByPresentation(items, request.presentationId);
    if (item) return item;
  }
  const visible = visibleNodeHistoryVersions(items);
  const cursor = selectedId;
  const current = Math.max(0, items.findIndex(item => cursor ? presentationOfItem(item) === cursor : item.current));
  return request.index !== undefined
    ? visible[request.index]
    : items[Math.max(0, Math.min(items.length - 1, current + (request.step ?? 0)))];
}

/** 只有成功归档是未读候选；失败/取消/中断等红点不标。 */
export function unseenEntryIds(
  items: readonly NodeGenerationHistoryListItem[],
  seenAt: string | undefined
): Set<string> {
  const unseen = new Set<string>();
  if (!seenAt) return unseen;
  for (const item of items) {
    if (!item.entryId || item.createdAt <= seenAt) continue;
    if ((item.outcome ?? "succeeded") !== "succeeded") continue;
    unseen.add(item.entryId);
  }
  return unseen;
}
