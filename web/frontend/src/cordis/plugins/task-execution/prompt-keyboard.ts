/**
 * 提示词提交键盘策略（change: 2026-10-09-improve-canvas-workflow，任务 3.1 / design D2）。
 *
 * textarea 与 Lexical 共用同一份判定，保证「Enter 生成、Shift+Enter 换行」在所有
 * 输入路径一致，且中文输入法组合/确认、`@`/`#` 候选菜单、只读/阻止原因、key repeat 都不会
 * 误提交或双提交。Ctrl/⌘+Enter 保留为兼容的生成快捷键。
 *
 * 纯函数：不含 DOM/React/Lexical 依赖，便于单测与跨编辑器复用。
 */

export type PromptKeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `KeyboardEvent.repeat`：长按重复，不触发生成。 */
  repeat?: boolean;
  /** 原生输入法组合中（`isComposing`）。 */
  isComposing?: boolean;
  /** 兼容的 IME 229 事件。 */
  keyCode?: number;
};

export type PromptKeyboardContext = {
  /** 平台是否 macOS；Enter 语义已与平台无关，保留字段供既有调用方与帮助文案使用。 */
  isMac: boolean;
  /** 是否只读。 */
  readOnly: boolean;
  /** 是否存在阻止生成的原因（如缺少参考、参数非法）。 */
  blocked: boolean;
  /** 是否已在提交中（防重入）。 */
  busy: boolean;
  /** `@`/`#` 候选菜单是否打开（由编辑器上报）。 */
  candidateMenuOpen: boolean;
};

export type PromptKeyboardAction =
  /** 由输入法消费（组合/确认阶段）。 */
  | { action: "ime" }
  /** 由候选菜单消费（选择候选）。 */
  | { action: "candidate" }
  /** 换行（Shift+Enter / Alt+Enter）。 */
  | { action: "newline" }
  /** 提交生成（Enter / Ctrl+Enter / ⌘+Enter）。 */
  | { action: "submit" }
  /** 不处理，交给默认行为。 */
  | { action: "none" };

/**
 * 解析一次 Enter 键事件。只有 Enter 参与；其它键返回 `none`。
 */
export function resolvePromptSubmitKey(
  event: PromptKeyboardEvent,
  context: PromptKeyboardContext
): PromptKeyboardAction {
  if (event.key !== "Enter") return { action: "none" };

  // 中文输入法组合/确认：交给输入法，任何 Enter 都不提交。
  if (event.isComposing === true || event.keyCode === 229) return { action: "ime" };

  // `@`/`#` 候选菜单打开：Enter 先选择候选，绝不提交。
  if (context.candidateMenuOpen) return { action: "candidate" };

  // Shift+Enter / Alt+Enter：显式换行，不提交。
  if (event.shiftKey || event.altKey) return { action: "newline" };

  // Enter（含 Ctrl/⌘+Enter）：重复 keydown 不重复生成；只读/忙/阻止时拒绝执行。
  if (event.repeat === true) return { action: "none" };
  if (context.readOnly || context.blocked || context.busy) return { action: "none" };
  return { action: "submit" };
}

/** 操作区帮助文案：与平台无关。 */
export function promptSubmitHint(): string {
  return "Enter 生成，Shift+Enter 换行";
}

/** placeholder 文案（简洁、明确）。 */
export function promptPlaceholder(): string {
  return "输入提示词，@ 引用已连接素材，Enter 生成，Shift+Enter 换行";
}
