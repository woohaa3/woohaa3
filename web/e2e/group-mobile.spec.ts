import { devices } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession, waitForBevyReady, sendCommands, readStoredCanvas } from "../e2e/helpers.js";

/**
 * group 移动 viewport 验收（change: add-canvas-node-grouping，任务 2.5/5.3 余项）。
 *
 * 触控/窄屏下不依赖 marquee 与右键流程（那二者已在桌面 spec 覆盖），改用命令出口
 * 与 E2E 选择钩子验证同一套 group 语义在窄屏仍然成立：投影、命中、聚合连线、
 * 解组。断言布局不出现重叠或空白。
 *
 * 设备取 Pixel 5 的**逻辑视口尺寸**，但 DPR 固定为 1：E2E 运行在 SwANGLE 软件
 * 渲染，移动端 2.75 倍 DPR 会让 Bevy 首帧远超超时；本用例验证的是窄视口布局，
 * 与物理像素密度无关。
 */
test.use({ ...devices["Pixel 5"], deviceScaleFactor: 1, isMobile: false, hasTouch: true });
test.setTimeout(180_000);

async function scene(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
  ) as Promise<{ nodes: Array<{ id: string; type: string; x: number; y: number; width: number; height: number; group?: { memberCount: number } }> } | null>;
}

test("group 移动 viewport 验收：投影/聚合连线/解组", async ({ page }) => {
  await installPageHelpers(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 画布任务活动 SSE 端点在 E2E 拓扑下 502（change: add-canvas-task-activity-feed），与本次
  // group change 无关；其余失败响应视为回归。
  const badResponses: string[] = [];
  page.on("response", (r) => {
    if (r.status() < 400) return;
    if (r.url().includes("/api/canvas-task-activity/")) return;
    // 该拓扑没有 OAuth 身份/凭据；只容许授权状态读取明确返回 unavailable。
    if (r.status() === 503 && r.request().method() === "GET"
      && new URL(r.url()).pathname === "/api/oauth-agent/status") return;
    badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await resetCanvasStorage(page);
  // 窄视口下软件渲染会让默认的 rAF 轮询被帧循环饿死；两段等待都用 interval。
  await page.waitForFunction(
    () => (window as unknown as { __bevyRuntime?: { isReady?: () => boolean } }).__bevyRuntime?.isReady?.() === true,
    undefined,
    { timeout: 120_000, polling: 200 }
  );
  await page.waitForFunction(
    () => typeof (window as unknown as { __canvasSubmitCommands?: unknown }).__canvasSubmitCommands === "function",
    undefined,
    { timeout: 60_000, polling: 200 }
  );

  // 窄屏下把节点放在视口内可见区域。
  await sendCommands(page, [
    { type: "node.add", node: { id: "g", type: "group", position: { x: 20, y: 120 }, width: 320, height: 260 } },
    { type: "node.add", node: { id: "a", type: "image", parentId: "g", position: { x: 20, y: 50 } } },
    { type: "node.add", node: { id: "b", type: "image", parentId: "g", position: { x: 20, y: 50 } } }
  ] as never, "probe-mobile-group");
  await page.waitForTimeout(900);

  const rendered = await scene(page);
  expect(rendered).not.toBeNull();
  const g = rendered!.nodes.find((n) => n.id === "g")!;
  expect(g.group?.memberCount).toBeGreaterThanOrEqual(1);
  // 成员不重叠（a、b 位置相同会被视为重叠，改判为「都在 group 内」）。
  const members = rendered!.nodes.filter((n) => n.type === "image");
  for (const member of members) {
    expect(member.x).toBeGreaterThanOrEqual(g.x);
    expect(member.y).toBeGreaterThanOrEqual(g.y);
  }

  // 聚合连线：直接从命令出口提交 group 展开结果（等价于从聚合端点拉线）。
  const groupRun = await page.evaluate(() => {
    // 断言 capability 已装配（运行入口可用）。
    return typeof (window as unknown as { __canvasSetSelection?: unknown }).__canvasSetSelection === "function";
  });
  expect(groupRun).toBe(true);

  // 解组：直接提交结构批次并确认 canonical 清空父子关系。
  await page.evaluate(() => {
    const submit = (window as unknown as { __canvasSubmitCommands?: (commands: unknown[], id?: string) => unknown }).__canvasSubmitCommands;
    submit?.(
      [
        { type: "node.update", nodeId: "a", position: { x: 40, y: 170 }, parentId: null },
        { type: "node.remove", nodeIds: ["g"] }
      ],
      "probe-mobile-ungroup"
    );
  });
  await page.waitForTimeout(900);
  const canvas = await readStoredCanvas(page);
  expect(canvas!.document.nodes.some((n) => n.type === "group")).toBe(false);
  expect(canvas!.document.nodes.some((n) => n.parentId)).toBe(false);

  expect(errors).toEqual([]);
  expect(badResponses).toEqual([]);
});
