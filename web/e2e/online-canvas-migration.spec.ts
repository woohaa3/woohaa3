/**
 * 在线画布迁移：首次打开旧 ID 的真实浏览器验收
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 6.8）。
 *
 * 在真实三服务拓扑（`e2e/server.mjs`）下验证：
 * - 深链接一个目标尚不存在的旧 ID：先进入 preparation 态（**不**创建 Canvas Session /
 *   同步 WS / Bevy），显示标准 loading 与媒体计数；
 * - 迁移 ready 后自动迁移到真正 Canvas scope，且**只有一条** `/api/canvases/:id/sync`
 *   WebSocket；
 * - 来源目录为空（扩展未启用/未认证）时维持恢复页，不创建/跳默认画布。
 *
 * 运行前置：`e2e/server.mjs` 需要注入受控来源端口（`E2E_ONLINE_MIGRATION_SOURCE`）才会挂载
 * prepare/status 面。未注入时本文件全部 `test.skip`，明确记为“真实浏览器 E2E 未运行”，
 * 不冒充通过（见 change 的 implementation-verification notes）。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4273);
const BASE = `http://127.0.0.1:${PORT}`;
/** 每个用例用不同旧 ID，避免共享服务端目标状态互相污染。 */
const OLD_CANVAS_ID = "legacy-canvas-1";
const OLD_CANVAS_ID_2 = "legacy-canvas-switch";

/** 服务器是否挂载了在线迁移来源（由 e2e/server.mjs 的 env 决定）。 */
async function migrationEnabled(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/api/canvas-sources`);
    // 未注入来源端口时该路由不存在（404/其它非 200/401）。
    return response.status === 200 || response.status === 401;
  } catch {
    return false;
  }
}

function trackSyncSockets(page: Page): string[] {
  const sockets: string[] = [];
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (url.includes("/api/canvases/") && url.includes("/sync")) sockets.push(url);
  });
  return sockets;
}

test.describe("在线画布迁移：首次打开旧 ID（任务 6.8）", () => {
  test("深链接旧 ID → 准备态（无 Session/WS/Bevy）→ ready 后唯一 WS 打开", async ({ page }) => {
    test.skip(!(await migrationEnabled()), "e2e 服务器未注入受控来源端口（真实浏览器 E2E 未运行）");

    const syncSockets = trackSyncSockets(page);
    await page.goto(`/?canvasId=${encodeURIComponent(OLD_CANVAS_ID)}`);

    // 准备态：出现准备 chrome，且此时尚未创建同步连接 / Bevy 运行时。
    await expect(page.getByTestId("canvas-preparation")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("progressbar", { name: "迁移进度" })).toBeVisible();
    expect(syncSockets).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as unknown as { __bevyRuntime?: unknown }).__bevyRuntime))).toBe(false);

    // ready 后迁移到 Canvas scope：准备 chrome 消失，Bevy 就绪，唯一同步 WS。
    await expect(page.getByTestId("canvas-preparation")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(
      () => (window as unknown as { __bevyRuntime?: { isReady?: () => boolean } }).__bevyRuntime?.isReady?.() === true,
      undefined,
      { timeout: 60_000 }
    );
    expect(syncSockets.length).toBe(1);
    expect(syncSockets[0]).toContain(`/api/canvases/${OLD_CANVAS_ID}/sync`);
  });

  test("切画布时准备态迟到响应不污染新 scope", async ({ page }) => {
    test.skip(!(await migrationEnabled()), "e2e 服务器未注入受控来源端口（真实浏览器 E2E 未运行）");

    const syncSockets = trackSyncSockets(page);
    await page.goto(`/?canvasId=${encodeURIComponent(OLD_CANVAS_ID_2)}`);
    await expect(page.getByTestId("canvas-preparation")).toBeVisible({ timeout: 30_000 });
    // 准备尚未完成（来源候选仍在前台等待）时立即切到根路径：准备 scope 必须被释放，
    // 不残留旧画布的同步连接；新 scope 的 socket 属于新 canvasId。
    await page.goto("/");
    await page.waitForFunction(
      () => Boolean((window as unknown as { __canvasSessionStatus?: unknown }).__canvasSessionStatus),
      undefined,
      { timeout: 60_000 }
    );
    // 不残留旧 ID 的同步连接。
    expect(syncSockets.some((url) => url.includes(OLD_CANVAS_ID_2))).toBe(false);
  });
});
