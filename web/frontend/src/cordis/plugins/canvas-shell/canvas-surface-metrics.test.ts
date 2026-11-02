import { describe, expect, it } from "vitest";
import { createSurfaceMetrics } from "./canvas-surface-metrics.js";

/**
 * 画布宿主（`.bevy-canvas-surface`）被资源轨 / 顶栏挤到 (248, 52) 的场景。
 * 只需要 `getBoundingClientRect`，不用 jsdom。
 */
type HarnessOptions = {
  /** 调用方算出的「是否桌面原生壳」（`hasNativeBootstrap || data-native-canvas`）。 */
  native?: boolean;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

/**
 * 构造 `createSurfaceMetrics` 需要的最小对象。
 *
 * 裸转型只在这里出现一次：测试只需要 `getBoundingClientRect` 与 `devicePixelRatio`，
 * 构造完整的 `HTMLCanvasElement` / `Window` 没有意义。类型断言集中在一处，改动只需核这里。
 */
function harness(options: HarnessOptions = {}) {
  const { native = false, left = 248, top = 52, width = 827, height = 701 } = options;
  const rect = { left, top, width, height };
  const host = { getBoundingClientRect: () => rect, clientWidth: width, clientHeight: height };
  const canvas = { parentElement: host, getBoundingClientRect: () => rect, clientWidth: 0, clientHeight: 0 };
  const target = { devicePixelRatio: 1 };
  return createSurfaceMetrics({
    canvas: canvas as unknown as HTMLCanvasElement,
    target: target as unknown as Window & typeof globalThis,
    activeViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    native
  });
}

describe("surfaceSize 的原点", () => {
  /*
   * 回归：浏览器里渲染器在 iframe 内，iframe 本身就是画布「洞」。
   * 若这里仍把 `rect.left/top`（资源轨 248、顶栏 52）当原点传给 Bevy，
   * `place_native_surface` 会把窗口撑成 `origin + 宽`（1075），位图超出 iframe，
   * 右侧恰好被裁掉一个资源轨的宽度 —— 表现为卡片被整齐切掉一块、画面左偏。
   */
  it("浏览器（iframe）路径不传原点：iframe 已经是画布洞", () => {
    const surface = harness().surfaceSize();
    expect(surface.originX).toBe(0);
    expect(surface.originY).toBe(0);
    // 尺寸仍取画布宿主自身，不受原点影响。
    expect(surface.width).toBe(827);
    expect(surface.height).toBe(701);
  });

  it("桌面原生路径保留原点：交换链铺满窗口，画布画在偏移后的洞里", () => {
    const surface = harness({ native: true }).surfaceSize();
    expect(surface.originX).toBe(248);
    expect(surface.originY).toBe(52);
    expect(surface.width).toBe(827);
    expect(surface.height).toBe(701);
  });

  /*
   * 原点跟随宿主位置：资源轨收起后宿主左缘变成 64，原点必须跟着走，
   * 否则原生壳里画布会错位一整个资源轨的宽度。
   */
  it("原点跟随宿主偏移变化", () => {
    expect(harness({ native: true, left: 64, top: 0 }).surfaceSize().originX).toBe(64);
    expect(harness({ native: true, left: 0, top: 0 }).surfaceSize().originX).toBe(0);
  });

  /*
   * 无布局时没有可对齐的原点：即便调用方判为原生，也不能把 `left/top` 当成原点
   * （此时宽高已回退到 `clientWidth`/1，交换链会按错误的原点摆放）。
   */
  it("没有布局（宽度为 0）时原点恒为 0，即使判为原生", () => {
    const surface = harness({ native: true, width: 0, height: 0 }).surfaceSize();
    expect(surface.originX).toBe(0);
    expect(surface.originY).toBe(0);
    // 尺寸回退仍生效。
    expect(surface.width).toBeGreaterThan(0);
  });
});
