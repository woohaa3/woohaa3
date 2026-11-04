/**
 * 画布快捷键路由（change: align-godot-canvas-interactions，任务 3.4 / 3.5 / design D5）。
 *
 * 规则：
 * - Windows/Linux 用 Ctrl，macOS 用 Cmd 作为主修饰键（`Mod`）。
 * - 画布获得快捷键范围时支持 `Mod+C`、`Mod+V`、`Delete`、`Backspace`。
 * - 焦点位于 input/textarea/contenteditable/dialog 或运行时文本编辑面（`editingFocus`）
 *   时，这些按键留给当前编辑面，不触发画布命令。
 *
 * 判定是纯函数：`resolveCanvasShortcut(event, context)` 返回应执行的画布动作或 `null`。
 * 不含任何 DOM 副作用，便于单测。
 */

export type CanvasShortcutAction = "copy" | "paste" | "duplicate" | "delete" | "find" | "undo" | "redo";

export type ShortcutEventLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** 事件目标是否是可编辑面（input/textarea/contenteditable/dialog）。 */
  editableTarget?: boolean;
  /** 页面中是否存在当前用户选中的文本。 */
  textSelectionActive?: boolean;
};

export type ShortcutContext = {
  /** 画布是否获得键盘范围（宿主 DOM 焦点在画布上）。 */
  keyboardActive: boolean;
  /** 运行时文本编辑面是否获得焦点（上报的 editingFocus）。 */
  editingFocus: boolean;
  /** 是否平台为 macOS（决定 Ctrl vs Cmd）。 */
  isMac: boolean;
  /** 持久化写入门禁是否开放（离线时删除应禁用）。 */
  writable: boolean;
};

/**
 * 解析键盘事件为画布动作。返回 `null` 表示不处理（留给浏览器/编辑面）。
 */
export function resolveCanvasShortcut(
  event: ShortcutEventLike,
  context: ShortcutContext
): CanvasShortcutAction | null {
  // 编辑面优先：任一编辑范围激活时不处理画布快捷键。
  if (context.editingFocus || event.editableTarget || event.textSelectionActive) return null;
  if (!context.keyboardActive) return null;

  const mod = context.isMac ? event.metaKey : event.ctrlKey;
  const key = normalizeKey(event);

  // 撤销/重做（change: 2026-10-09-improve-canvas-workflow，任务 1.7）：
  // Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 重做；Windows/Linux 另支持 Ctrl+Y 重做。
  // 编辑面已在函数开头返回 null，因此输入框/聚焦编辑器自身的撤销优先。
  if (mod && !event.altKey && key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }
  if (!context.isMac && event.ctrlKey && !event.shiftKey && !event.altKey && key === "y") {
    return "redo";
  }

  if (mod && !event.shiftKey && !event.altKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    if (key === "d" && context.writable) return "duplicate";
    if (key === "f") return "find";
  }
  // Delete/Backspace 是持久化删除，离线（不可写）时留给编辑面/浏览器。
  if (!mod && !event.altKey && context.writable && (key === "delete" || key === "backspace")) {
    return "delete";
  }
  return null;
}

/** 平台判定：优先 `navigator.platform`，回退 `userAgent`。 */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } | undefined
): boolean {
  if (!nav) return false;
  const platform = nav.platform ?? "";
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  return /mac os x|macintosh/i.test(nav.userAgent ?? "");
}

/**
 * DOM 侧判定事件目标是否是可编辑面：input/textarea/select/contenteditable/dialog。
 * 运行时的文本编辑面通过 `editingFocus` 单独上报，不在这里。
 */
export function isEditableElement(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean; closest?: (selector: string) => Element | null }) | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "option") return true;
  if (tag === "dialog" || tag === "form") return true;
  if (element.isContentEditable === true) return true;
  const role = element.getAttribute?.("role");
  if (
    role === "textbox" ||
    role === "dialog" ||
    role === "alertdialog" ||
    role === "menu" ||
    role === "menuitem" ||
    role === "listbox" ||
    role === "option"
  ) {
    return true;
  }
  // Radix 把焦点放到 menu item，浮层容器本身可能不在焦点路径上；用祖先语义面兜底
  // （change: adopt-radix-lucide-canvas-ui，任务 3.3：菜单/Dialog 打开时按键留给浮层）。
  if (typeof element.closest === "function") {
    if (element.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) {
      return true;
    }
  }
  return false;
}

/**
 * DOM 语义区域判定（change: fix-model-focus-navigation-and-camera-parity，design D6）。
 *
 * 聚焦 document-capture 缩放前先判断事件目标：可滚动容器（history drawer / model-editor /
 * 通用 overflow 容器）与可编辑控件由 DOM 自己消费 wheel/pinch，聚焦缩放不得抢占。canvas、
 * 透明 viewfinder 与非交互 chrome 返回 false（缩放主观察相机）。
 */
export function isDomConsumingInputTarget(target: EventTarget | null): boolean {
  if (isEditableElement(target)) return true;
  const element = target as (HTMLElement & { closest?: (selector: string) => Element | null }) | null;
  if (!element || typeof element.closest !== "function") return false;
  // 显式标记的聚焦非交互区域（viewfinder / canvas chrome）优先返回 false，不因其祖先可滚动而让出。
  if (element.closest("[data-focus-canvas-chrome]")) return false;
  if (element.closest(".node-history, .model-editor, [data-canvas-scrollable]")) return true;
  // 任意具有滚动能力的祖先容器（overflow auto/scroll）也保留 DOM 滚动。
  let node: Element | null = element;
  let depth = 0;
  while (node && depth < 8) {
    depth += 1;
    const view = node.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      const style = view.getComputedStyle(node);
      const overflowY = style?.overflowY ?? "";
      const overflowX = style?.overflowX ?? "";
      if (overflowY === "auto" || overflowY === "scroll" || overflowX === "auto" || overflowX === "scroll") {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

function normalizeKey(event: ShortcutEventLike): string {
  const key = event.key ?? "";
  if (key === "Backspace" || key === "Delete") return key.toLowerCase();
  // 字母键统一小写；使用 key 而不是 code 以兼容不同键盘布局。
  return key.toLowerCase();
}
