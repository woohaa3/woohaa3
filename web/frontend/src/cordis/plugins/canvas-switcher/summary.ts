import type { CanvasSummary } from "../../contract/canvas-catalog.js";

/** 相对时间：列表里只回答「多久没动过」，不摆绝对时间戳。 */
function formatRelativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const delta = Math.max(0, now - at);
  const minute = 60_000;
  if (delta < minute) return "刚刚更新";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`;
  if (delta < 30 * 24 * 60 * minute) return `${Math.floor(delta / (24 * 60 * minute))} 天前`;
  return new Date(at).toLocaleDateString();
}

/** 条目副行：更新时间 + 规模。remote-only 的计数来自远端摘要，缺失时按 0 展示。 */
export function itemMeta(entry: CanvasSummary): string {
  const updated = formatRelativeTime(entry.updatedAt);
  const scale = [
    entry.nodeCount > 0 ? `${entry.nodeCount} 个节点` : null,
    entry.assetCount > 0 ? `${entry.assetCount} 个素材` : null
  ].filter((part): part is string => part !== null);
  return [updated, ...scale].filter((part) => part !== "").join(" · ") || "暂无内容";
}
