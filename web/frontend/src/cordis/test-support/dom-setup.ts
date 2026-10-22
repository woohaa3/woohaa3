/**
 * Vitest DOM 环境补齐（change: adopt-radix-lucide-canvas-ui）。
 *
 * Radix 定位（Tooltip/Popover/Menu）依赖 `ResizeObserver`，jsdom 未实现。
 * 这里提供最小 polyfill，使 primitives 的 jsdom 组件测试可运行真实 Radix 行为。
 * 仅在 jsdom 环境下生效（node 环境测试不 import 本模块的副作用）。
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
