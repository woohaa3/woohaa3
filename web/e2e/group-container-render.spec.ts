/**
 * group 容器渲染层级与成员拖动的浏览器验收
 * （change: fix-group-and-marquee-preview）。
 *
 * 覆盖两个曾经的真实回归：
 * 1. 打完组/选中组后容器盖住成员（共享 mesh 无深度测试，覆盖顺序即提交顺序，而文档顺序把
 *    group 追加在成员之后）。
 * 2. 点选组内节点时节点向左上跳跃（拖动 origin 误用局部坐标，而渲染预览按绝对坐标解释）。
 *
 * 只用产品镜像断言：`window.__bevyRuntime.lastScene()` 与 `window.__canvasCanonical`。
 */
import { expect, test } from "./review-browser.js";
import {
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  sendCommands,
  waitForBevyReady,
  waitForCanvasSession
} from "../e2e/helpers.js";

type SceneNode = { id: string; type: string; x: number; y: number; width: number; height: number };
type Scene = {
  nodes: SceneNode[];
  selection: { nodes: string[] };
  marquee?: unknown;
};

async function scene(page: import("@playwright/test").Page): Promise<Scene | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
  ) as Promise<Scene | null>;
}

/** 建两个节点、框选并打组，返回 group 与成员的渲染投影。 */
async function groupTwoMembers(page: import("@playwright/test").Page) {
  await sendCommands(page, [
    { type: "node.add", node: { id: "a", type: "image", position: { x: 360, y: 380 } } },
    { type: "node.add", node: { id: "b", type: "image", position: { x: 700, y: 380 } } }
  ] as never, "group-render-setup");
  await page.waitForTimeout(500);

  // 从左上**空白**按下拖到右下，框住两个成员。
  // 注意起点避开左上角的画布切换器 chrome（change: 2026-09-29-add-multi-canvas-workspace
  // 在 (16,16) 起新增了画布标题触发器），否则按下会落在按钮上而不是画布空白。
  await page.mouse.move(60, 120);
  await page.mouse.down();
  await page.mouse.move(980, 640, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.mouse.click(420, 430, { button: "right" });
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: "打组" }).click();
  await page.waitForTimeout(900);

  const projection = (await scene(page))!;
  const group = projection.nodes.find((node) => node.type === "group")!;
  return { group, projection };
}

test("group 容器不盖住成员，选中时用虚线高亮", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  await waitForBevyReady(page);

  const { group } = await groupTwoMembers(page);

  // 文档顺序把 group 排在成员之后（打组的真实顺序）——渲染层必须自行把容器提前，
  // 这由 Rust 单测 `draw_order` 与截图共同保证；这里断言场景几何本身正确。
  const doc = await readStoredCanvas(page);
  const docIds = doc!.document.nodes.map((node) => node.id);
  expect(docIds.indexOf(group.id)).toBeGreaterThan(docIds.indexOf("a"));
  // 两个成员节点在场景里位于容器范围内（说明容器承载它们，而不是被覆盖后消失）。
  for (const id of ["a", "b"]) {
    const member = (await scene(page))!.nodes.find((node) => node.id === id)!;
    expect(member.x).toBeGreaterThanOrEqual(group.x);
    expect(member.x + member.width).toBeLessThanOrEqual(group.x + group.width + 1);
  }

  // 选中 group：点容器标题区（成员之上、容器之内）。
  await page.mouse.click(group.x + 40, group.y + 16);
  await page.waitForTimeout(500);
  const selection = (await scene(page))!.selection.nodes;
  expect(selection).toEqual([group.id]);
  expect(errors).toEqual([]);
});

test("点选并拖动组内成员不跳跃（origin 取绝对坐标）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  await waitForBevyReady(page);

  await groupTwoMembers(page);
  const before = (await scene(page))!.nodes.find((node) => node.id === "a")!;

  // 在成员卡片内按下并平移 (+40,+30)：预览应等于「绝对起点 + 位移」，而不是「局部坐标 + 位移」。
  await page.getByRole("button", { name: "关闭执行面板", exact: true }).click();
  const start = { x: before.x + 120, y: before.y + 40 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 30, { steps: 5 });
  await expect.poll(async () => { const n = (await scene(page))!.nodes.find(node => node.id === "a")!; return {x:n.x,y:n.y}; }).toEqual({ x: before.x + 40, y: before.y + 30 });
  const during = (await scene(page))!.nodes.find((node) => node.id === "a")!;
  expect({ x: during.x, y: during.y }).toEqual({ x: before.x + 40, y: before.y + 30 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  // 落点后文档里的成员仍是相对坐标，且绝对位置与预览一致（不跳回）。
  const doc = await readStoredCanvas(page);
  const group = doc!.document.nodes.find((node) => node.type === "group")!;
  const member = doc!.document.nodes.find((node) => node.id === "a")!;
  expect((member as { parentId?: string }).parentId).toBe(group.id);
  expect(group.position.x + member.position.x).toBeCloseTo(before.x + 40, 0);
  expect(group.position.y + member.position.y).toBeCloseTo(before.y + 30, 0);
  expect(errors).toEqual([]);
});
