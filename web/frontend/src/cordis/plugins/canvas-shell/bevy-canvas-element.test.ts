/**
 * 单例 Bevy canvas 元素：跨 page scope 存活
 * （fix: 切换画布白屏）。
 *
 * 锁定缺陷：Bevy/winit 只在 `start()` 绑定一次 `#bevy-canvas`，若切换画布时新建
 * `<canvas>`，winit 会继续渲染到已脱离文档的旧元素，新画布永久空白。本模块保证挂载/
 * 卸载复用同一元素，且只有画布页面才把元素留在文档中。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  currentBevyCanvas,
  mountBevyCanvas,
  resetBevyCanvasElement,
  unmountBevyCanvas
} from "./bevy-canvas-element.js";

afterEach(() => {
  resetBevyCanvasElement();
  document.body.innerHTML = "";
});

describe("单例 Bevy canvas 元素", () => {
  it("挂载与再次挂载复用同一元素", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);

    const first = mountBevyCanvas(a);
    expect(first.id).toBe("bevy-canvas");
    expect(first.parentElement).toBe(a);

    const second = mountBevyCanvas(b);
    expect(second).toBe(first);
    expect(second.parentElement).toBe(b);
  });

  it("卸载后元素脱离文档但不销毁；重新挂载复用同一元素（winit 绑定保持有效）", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);

    const canvas = mountBevyCanvas(a);
    unmountBevyCanvas(a);
    expect(canvas.isConnected).toBe(false);
    expect(currentBevyCanvas()).toBe(canvas);
    expect(document.querySelector("canvas#bevy-canvas")).toBeNull();

    // 新 scope 挂载：同一元素重新进入文档。
    mountBevyCanvas(b);
    expect(currentBevyCanvas()).toBe(canvas);
    expect(document.querySelector("canvas#bevy-canvas")).toBe(canvas);
    expect(canvas.parentElement).toBe(b);
  });

  it("旧 scope 的迟到卸载不抢走新 scope 已挂载的画布", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);

    mountBevyCanvas(a);
    mountBevyCanvas(b);
    // 旧作用域的 cleanup 先于新作用域挂载执行时不应移除新容器的元素。
    unmountBevyCanvas(a);
    expect(currentBevyCanvas()?.parentElement).toBe(b);
  });
});
