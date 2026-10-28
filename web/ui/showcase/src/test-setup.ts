/**
 * 查看页 component test 的最小 DOM 垫片。
 *
 * jsdom 没有 `URL.createObjectURL` / `TextEncoder` 等浏览器能力；生产组件里用到的部分要
 * 显式补齐，否则挂载会在无关位置失败。只补必要项，保持测试聚焦。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:showcase/noop";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => undefined;
}
/**
 * Lexical 在模块加载时用 `'getTargetRanges' in new InputEvent('input')` 决定是否注册
 * `beforeinput` 处理器。jsdom 没有该方法，于是在 jsdom 下 Lexical 只监听 `input`，
 * 而 `act` 事件模拟默认走 `beforeinput`。补齐后再派发 `beforeinput` 就能驱动真实编辑。
 */
if (typeof InputEvent !== "undefined" && !("getTargetRanges" in InputEvent.prototype)) {
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", {
    value: () => [],
    configurable: true,
    writable: true
  });
}
/**
 * jsdom 的 `InputEvent` 不实现 `data` 的 setter 语义，但构造器接受 `data`；这里补一个
 * `inputType` 默认值，避免部分路径读到 undefined。
 */
if (typeof InputEvent !== "undefined" && !("inputType" in InputEvent.prototype)) {
  Object.defineProperty(InputEvent.prototype, "inputType", {
    value: "",
    configurable: true,
    writable: true
  });
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

/**
 * jsdom 没有 `Range.getBoundingClientRect` / `Element.getBoundingClientRect` 的真实布局，
 * 而 Lexical typeahead 菜单定位会调用它们。补齐零尺寸矩形，让菜单能正常渲染（不可见即可）。
 */
function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({})
  } as DOMRect;
}
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = zeroRect;
}
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof Element !== "undefined" && !Element.prototype.getBoundingClientRect) {
  Element.prototype.getBoundingClientRect = zeroRect;
}
if (typeof Element !== "undefined" && !Element.prototype.getClientRects) {
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0)) as unknown as typeof window.requestAnimationFrame;
}
