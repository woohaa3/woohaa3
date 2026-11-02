/**
 * 窗口 resize 后 Bevy 渲染 surface 跟随
 * （回归：change: optimize-model-scene-snapshot-hot-path）。
 *
 * 失效驱动后永久 rAF 在静止帧不再重建快照；若 resize 不显式失效，Bevy 的 `sync_surface`
 * 会把窗口物理尺寸强行拉回旧的 surface 尺寸，表现为「放大窗口后渲染区域不变大」。这里断言
 * 窗口放大后 `__bevyRuntime.lastScene().surface` 跟随新的画布尺寸。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession } from "./helpers.js";

type Surface = { width: number; height: number; pixelRatio: number } | null;

async function lastSurface(page: Page): Promise<Surface> {
  return page.evaluate(() => {
    const runtime = (window as unknown as { __bevyRuntime?: { lastScene?: () => { surface?: Surface } | null } }).__bevyRuntime;
    return runtime?.lastScene?.()?.surface ?? null;
  });
}

test.describe("窗口 resize 跟随（change: optimize-model-scene-snapshot-hot-path）", () => {
  test("放大窗口后 surface 尺寸跟随新的画布尺寸", async ({ page }) => {
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    const before = await lastSurface(page);
    expect(before, "初始应有已提交的快照 surface").not.toBeNull();

    // 放大视口：窗口/容器与 canvas 同步变大。
    await page.setViewportSize({ width: 1600, height: 1000 });
    // resize 事件经 rAF 合并后提交新快照。
    await expect
      .poll(async () => (await lastSurface(page))?.width ?? 0, { timeout: 10_000, polling: 100 })
      .toBeGreaterThan(before!.width);

    const after = await lastSurface(page);
    expect(after!.width).toBeGreaterThan(before!.width);
    expect(after!.height).toBeGreaterThan(before!.height);

    // 缩小同样跟随。
    await page.setViewportSize({ width: 900, height: 600 });
    await expect
      .poll(async () => (await lastSurface(page))?.width ?? Number.MAX_SAFE_INTEGER, { timeout: 10_000, polling: 100 })
      .toBeLessThan(after!.width);
  });
});
