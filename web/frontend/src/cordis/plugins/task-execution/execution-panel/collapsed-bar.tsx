/**
 * 执行面板收成一条底边栏时的样子。
 *
 * 参考稿是「⊕ + 一句占位文案」，点一下展开成完整面板。这里刻意**不放输入框**：草稿的权威
 * 状态在面板自己身上（`ExecutionPanel` 的本地 prompt / `AuthoringGenerateLayout` 的受控值），
 * 在窄条里再放一个输入框就会变成两份真相，而且焦点、@ 引用、回车提交都要重写一遍。
 * 窄条只做「看一眼 + 点开」，输入全部在展开态里完成。
 *
 * 已输入的提示词会显示在第一行（截断），所以收起后不会像丢了一样。
 *
 * 按钮语义用原生 `<button>` + `aria-expanded`，不复用 `IconButton`：那颗按钮会自带一个
 * 尺寸与内边距，把整条胶囊的高度撑成两档；这里整条就是按钮，图标只是它的内容。
 */
import { ChevronDownIcon, PlusIcon } from "@woohaa3/ui";
import type { ExecutionPanelStatus } from "./types.js";

export type CollapsedBarProps = {
  /** 当前草稿；空串时显示 `placeholder`。 */
  value: string;
  placeholder: string;
  /** 运行状态；只在失败/进行中有意义，`idle` 不显示标签。 */
  status?: ExecutionPanelStatus;
  statusLabel?: string;
  /** 只读/阻塞时的原因，显示为 `title`。 */
  hint?: string;
  onExpand: () => void;
};

export function CollapsedBar({ value, placeholder, status, statusLabel, hint, onExpand }: CollapsedBarProps) {
  const text = value.trim() || placeholder;
  const showStatus = status !== undefined && status !== "idle" && status !== "successed";
  return (
    <button
      type="button"
      className="mc-bar"
      aria-label="展开编辑面板"
      aria-expanded={false}
      {...(hint ? { title: hint } : {})}
      onClick={onExpand}
    >
      <span className="mc-bar__add" aria-hidden="true">
        <PlusIcon size={16} />
      </span>
      {showStatus ? (
        <span className="mc-bar__status" data-status={status}>
          {statusLabel ?? status}
        </span>
      ) : null}
      <span className="mc-bar__text" data-empty={value.trim() ? undefined : "true"}>
        {text}
      </span>
      <span className="mc-bar__chevron" aria-hidden="true">
        <ChevronDownIcon size={16} />
      </span>
    </button>
  );
}
