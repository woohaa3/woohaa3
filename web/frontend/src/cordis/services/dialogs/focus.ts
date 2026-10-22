/**
 * Dialog focus 管理（change: add-frontend-dialog-system，任务 3.2 / design D4；
 *  change: adopt-radix-lucide-canvas-ui 任务 6.3：Tab trap 由 Radix FocusScope 承担，
 *  本模块只保留 Host 需要的 opener 记录、初始焦点与关闭后恢复）。
 *
 * 纯 DOM 逻辑，document 可注入以便单测：
 * - push 前记录当前聚焦元素；
 * - 打开后焦点进入显式 initial target / 首个可编辑控件 / 首个操作控件 / Content；
 * - pop 时优先恢复仍连接且可聚焦的 opener；嵌套回到父弹窗；opener 失效回退到画布
 *   keyboard owner，最后回退应用根。
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export type DialogDocument = Pick<Document, "activeElement" | "querySelector"> & {
  getElementById?(id: string): Element | null;
};

/** 画布键盘 owner 的稳定选择器（design D4 的回退目标）。 */
export const CANVAS_KEYBOARD_OWNER_SELECTOR = "#bevy-canvas";

/** 元素是否仍连接且可聚焦。 */
function isFocusable(element: Element | null): element is HTMLElement {
  if (!element) return false;
  const html = element as HTMLElement;
  if (!html.isConnected) return false;
  if (typeof html.focus !== "function") return false;
  if (html.hasAttribute?.("disabled")) return false;
  const tabindex = html.getAttribute?.("tabindex");
  if (tabindex !== null && Number(tabindex) < 0) return false;
  return true;
}

/** 记录当前聚焦元素（opener）。 */
export function captureFocus(doc: DialogDocument): Element | null {
  return doc.activeElement ?? null;
}

/** modal 内可聚焦元素（按 DOM 顺序）。 */
export function focusableWithin(container: Element): HTMLElement[] {
  const nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
  return Array.from(nodes).filter(isFocusable);
}

/**
 * 把焦点移入 modal：
 * 1. 显式 `data-dialog-initial-focus`；
 * 2. 首个可编辑控件（input/textarea/select）；
 * 3. 首个可聚焦控件；
 * 4. Content 容器自身。
 */
export function focusInitial(container: Element): void {
  const explicit = container.querySelector("[data-dialog-initial-focus]");
  if (isFocusable(explicit)) {
    explicit.focus();
    return;
  }
  const focusables = focusableWithin(container);
  const editable = focusables.find((element) =>
    ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
  );
  (editable ?? focusables[0] ?? (container as unknown as HTMLElement)).focus?.();
}

/**
 * 关闭后恢复焦点：优先 opener（若仍连接可聚焦），否则回退画布 keyboard owner，
 * 最后回退应用根（body）。
 */
export function restoreFocus(doc: DialogDocument, opener: Element | null): void {
  if (isFocusable(opener)) {
    opener.focus();
    return;
  }
  const owner = doc.querySelector(CANVAS_KEYBOARD_OWNER_SELECTOR);
  if (owner) {
    // 画布元素默认不带 tabindex，但仍应作为回退的键盘 owner 接收焦点。
    (owner as HTMLElement).focus?.();
    if (doc.activeElement === owner) return;
  }
  const body = doc.querySelector("body");
  if (body) (body as HTMLElement).focus?.();
}

