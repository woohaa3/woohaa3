/**
 * 设置通知 · 后台任务完成时标题更新 E2E
 * （change: 2026-10-17-move-settings-into-canvas-dialog）。
 *
 * 验证根因修复：真实浏览器下 claim 不再阻塞 start()，任务事实源启动；
 * 页卡切走后任务完成（记录在后台到达），文档标题前显示完成数，返回后恢复。
 *
 * 时序关键：任务记录必须在「切走后」才送达（仅后台完成的记录才写标题）。
 */
import { expect, test } from "./review-browser.js";
function taskRecord(state: "succeeded" | "failed") {
  return {
    taskKey: `e2e-notif-${Date.now().toString(36)}`,
    state,
    providerId: "test",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:01:00.000Z",
    durationMs: 1000,
    recordRevision: 1
  };
}

test.describe("通知标题（真实浏览器）", () => {
  test("切走页卡后任务成功，标题显示完成数；返回后恢复", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // Node 侧开关：切走前 changes 轮询返回空，切走后返回成功记录。
    let deliverRecord = false;
    let watermark = 5;

    await page.route("**/api/pptask/history**", async (route, request) => {
      const url = request.url();
      if (url.includes("/changes?")) {
        if (deliverRecord) {
          deliverRecord = false; // 只投递一次，避免重复累计。
          watermark = 6;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              messages: [{ record: taskRecord("succeeded"), cursor: 6 }],
              cursor: 6
            })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [], cursor: watermark })
        });
        return;
      }
      if (url.includes("/events?")) {
        // 空 NDJSON：stream 立即结束，进入 pollOnce。
        await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "\n" });
        return;
      }
      if (url.includes("?limit=")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], watermark })
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/settings");
    const baseTitle = await page.title();
    await expect(page.locator('[data-testid="settings-workspace"]')).toBeVisible({ timeout: 60_000 });

    // 通知服务应已启动且源为 live。
    const boot = await page.evaluate(() => {
      const w = window as unknown as { __taskNotificationsSnapshot?: () => unknown };
      return typeof w.__taskNotificationsSnapshot === "function" ? (w.__taskNotificationsSnapshot() as { source: { status: string } }) : null;
    });
    console.log("BOOT SNAPSHOT:", JSON.stringify(boot));
    expect(boot?.source.status).toBe("live");

    // 模拟切走页卡：覆盖 document.hidden 并触发 visibilitychange，
    // 让 foreground service 判定为后台（不等待 Playwright 多 page 焦点切换）。
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 切走后，任务完成（记录在后台到达）。
    deliverRecord = true;

    // 标题渠道是后台判定 + 轮询投递：轮询间隔默认 5s，等待上限 20s。
    await expect
      .poll(async () => page.title(), { timeout: 20_000, intervals: [500, 1000, 2000, 5000] })
      .toContain("完成");

    const titleAfter = await page.title();
    console.log("TITLE after task:", titleAfter);
    expect(titleAfter).toContain(baseTitle);

    // 返回页卡：恢复 visibility。
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect
      .poll(async () => page.title(), { timeout: 5_000, intervals: [200, 500] })
      .toBe(baseTitle);

    // 无页面报错。
    expect(errors).toEqual([]);
  });
});
