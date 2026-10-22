/**
 * Task Activity extension 测试的 jsdom 补齐（change: 2026-10-10-extract-optional-feature-extensions）。
 *
 * Radix 定位（Tooltip/Popover/ScrollArea）依赖 `ResizeObserver`，jsdom 未实现。这里提供最小
 * polyfill，使组件测试可运行真实 primitives 行为；只在 jsdom 测试加载（node 测试不 import）。
 */

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.DOMRect === "undefined") {
  class DOMRectStub {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0
    ) {}
    get top(): number { return this.y; }
    get left(): number { return this.x; }
    get right(): number { return this.x + this.width; }
    get bottom(): number { return this.y + this.height; }
  }
  (globalThis as unknown as { DOMRect: unknown }).DOMRect = DOMRectStub;
}

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

export {};
