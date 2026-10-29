/**
 * 画布目录条目的删除入口与行内确认。
 *
 * 删除不可撤销，确认信息必须贴着被删的那一行（与重命名同一套行内展开），
 * 不另叠一层 Dialog。抽在这里是为了让 chrome.tsx 保持在单文件行数上限内。
 */
import { Button } from "@woohaa3/ui/primitives";
import type { CanvasSummary } from "../../contract/canvas-catalog.js";

/** 条目右侧的删除入口（文本动作，危险色只在悬停时出现）。 */
export function CanvasDeleteButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="canvas-switcher__item-delete"
      onClick={onClick}
      disabled={disabled}
      title="删除这张画布"
    >
      删除
    </button>
  );
}

/** 行内删除确认：整行替换为问题文案 + 危险动作 + 取消。 */
export function CanvasDeleteConfirm({
  entry,
  busy,
  onConfirm,
  onCancel
}: {
  entry: CanvasSummary;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="canvas-switcher__delete-row" data-testid="canvas-switcher-delete-confirm">
      <span className="canvas-switcher__delete-question">
        删除「{entry.title.trim() || "未命名画布"}」？
        {entry.sources?.includes("remote") ? "远端与本机的内容都会移除，" : ""}
        无法恢复。
      </span>
      <Button size="sm" tone="danger" disabled={busy} onClick={onConfirm}>
        删除
      </Button>
      <Button size="sm" disabled={busy} onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
