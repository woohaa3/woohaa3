import {beforeEach} from "vitest";
/**
 * Vitest DOM 环境补齐
 * （change: 2026-10-21-extract-photocraft-subproject，design D6）。
 *
 * Radix 定位（Tooltip/Popover/Menu）依赖 `ResizeObserver`，jsdom 未实现。这里提供最小
 * polyfill；只在 jsdom 用例里产生作用，node 环境用例不依赖本模块。
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

// Separate test sessions; individual remounts still exercise actual persistence.
beforeEach(()=>{if(typeof localStorage!=="undefined")for(const key of Object.keys(localStorage))if(key.startsWith("photocraft.tools.v1."))localStorage.removeItem(key);});
