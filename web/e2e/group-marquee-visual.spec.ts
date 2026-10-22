/**
 * group 容器底半透明 + 框选虚线框的浏览器验收
 * （change: fix-group-and-marquee-preview）。
 *
 * 只用产品镜像断言瞬时呈现态：`window.__bevyRuntime.lastScene()`。这些字段是浏览器本地
 * 呈现态，不进入规范画布——用例同时断言 revision 不被框选推进。
 */
import { expect, test } from "@playwright/test";
import {
  installPageHelpers,
  resetCanvasStorage,
  sendCommands,
  waitForBevyReady,
  waitForCanvasSession
} from "../e2e/helpers.js";

type Scene = {
  revision: number;
  marquee?: { x: number; y: number; width: number; height: number } | null;
};

async function scene(page: import("@playwright/test").Page): Promise<Scene | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
  ) as Promise<Scene | null>;
}

test("框选显示虚线选区矩形且不推进规范状态", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const badResponses: string[] = [];
  page.on("response", (r) => {
    if (r.status() < 400) return;
    // 画布任务活动 SSE 端点（change: add-canvas-task-activity-feed）在 E2E 服务器拓扑下返回
    // 502，与本次 change 无关，单独排除。
    if (r.url().includes("/api/canvas-task-activity/")) return;
    // 该拓扑没有 OAuth 身份/凭据；只容许授权状态读取明确返回 unavailable。
    if (r.status() === 503 && r.request().method() === "GET"
      && new URL(r.url()).pathname === "/api/oauth-agent/status") return;
    badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  await waitForBevyReady(page);

  await sendCommands(page, [
    { type: "node.add", node: { id: "a", type: "image", position: { x: 200, y: 220 } } }
  ] as never, "marquee-setup");
  await expect.poll(async () => (await scene(page))?.revision).toBe(1);

  const revisionBefore = (await scene(page))!.revision;
  // 静止时无选区。
  expect((await scene(page))?.marquee ?? null).toBeNull();

  // 从左上空白按下拖到右下，保持按住以观察进行中的选区。
  await page.mouse.move(60, 120);
  await page.mouse.down();
  await page.mouse.move(700, 560, { steps: 6 });
  await page.waitForTimeout(300);

  const dragging = await scene(page);
  console.log("marquee while dragging", JSON.stringify(dragging?.marquee));
  expect(dragging?.marquee).not.toBeNull();
  expect(dragging!.marquee!.width).toBeGreaterThan(0);
  expect(dragging!.marquee!.height).toBeGreaterThan(0);
  // 框选是本地呈现态：不推进 revision。
  expect(dragging!.revision).toBe(revisionBefore);

  await page.mouse.up();
  await page.waitForTimeout(400);
  // 松手后选区移除，且仍不推进规范状态。
  const released = await scene(page);
  console.log("marquee after release", JSON.stringify(released?.marquee));
  expect(released?.marquee ?? null).toBeNull();
  expect(released!.revision).toBe(revisionBefore);
  expect(errors).toEqual([]);
  expect(badResponses).toEqual([]);
});
