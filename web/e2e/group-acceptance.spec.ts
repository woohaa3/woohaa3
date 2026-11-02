import { expect, test } from "./review-browser.js";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession, waitForBevyReady, sendCommands, readStoredCanvas } from "../e2e/helpers.js";

async function scene(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ?? null
  ) as Promise<{ nodes: Array<{ id: string; type: string; x: number; y: number; group?: { memberCount: number; outputCapableLeafCount: number } }> } | null>;
}

test("group 桌面验收：创建/拖动/解组/聚合连线", async ({ page }) => {
  await installPageHelpers(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 记录所有失败响应；画布任务活动的 SSE 端点（change: add-canvas-task-activity-feed）在
  // E2E 服务器拓扑下返回 502，与本次 group change 无关（master 自己也没有该端点的 E2E 覆盖），
  // 因此单独排除；其余 4xx/5xx 一律视为回归。
  const badResponses: string[] = [];
  page.on("response", (r) => {
    if (r.status() < 400) return;
    if (r.url().includes("/api/canvas-task-activity/")) return;
    // 该拓扑没有 OAuth 身份/凭据；只容许授权状态读取明确返回 unavailable。
    if (r.status() === 503 && r.request().method() === "GET"
      && new URL(r.url()).pathname === "/api/oauth-agent/status") return;
    // 当前基线 Application composition 尚未提供这两个运营管理读取路由。
    // 仅容许明确的 404；503、其它方法/子路由及插件控制面失败仍算回归。
    const path = new URL(r.url()).pathname;
    if (r.status() === 404 && r.request().method() === "GET" && path === "/api/generation-models") return;
    badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  await waitForBevyReady(page);

  // 两个顶层图片节点 + 一个目标生成节点。
  await sendCommands(page, [
    { type: "node.add", node: { id: "a", type: "image", position: { x: 150, y: 250 } } },
    { type: "node.add", node: { id: "b", type: "image", position: { x: 520, y: 250 } } },
    { type: "node.add", node: { id: "target", type: "model3d", position: { x: 1100, y: 250 } } }
  ] as never, "probe-setup");
  await page.waitForTimeout(700);

  // 拖动前记录 a 的绝对坐标。
  const before = await scene(page);
  const aBefore = before!.nodes.find((n) => n.id === "a")!;
  console.log("a before", JSON.stringify({ x: aBefore.x, y: aBefore.y }));

  // 框选 a+b：从节点包围盒外的左上角空白开始拖（a 在 150,250，尺寸 260x195，
  // 因此起点必须避开卡片本身，否则会变成拖动节点）。
  // 避开左上角画布切换器，确保 pointerdown 落在画布空白处。
  await page.mouse.move(20, 160);
  await page.mouse.down();
  await page.mouse.move(900, 600, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const selected = await page.evaluate(() =>
    (window as unknown as { __canvasSelection?: () => { store: string[] } }).__canvasSelection?.().store
  );
  console.log("selected after marquee", JSON.stringify(selected));

  await expect.poll(async()=>page.evaluate(()=>(window as unknown as {__canvasSelection?:()=>{store:string[]}}).__canvasSelection?.().store.slice().sort())).toEqual(["a","b"]);

  // 右键其中一个节点打开菜单，点「打组」。
  await page.mouse.click(230, 300, { button: "right" });
  await page.waitForTimeout(400);
  const groupItem = page.getByRole("menuitem", { name: "打组" });
  await expect(groupItem).toBeVisible();
  await groupItem.click();
  await page.waitForTimeout(900);

  let canvas = await readStoredCanvas(page);
  const groupNode = canvas?.document.nodes.find((n) => n.type === "group");
  console.log("group created", groupNode?.id, "members", canvas?.document.nodes.filter((n) => n.parentId).map((n) => n.id));
  expect(groupNode).toBeDefined();
  const members = canvas!.document.nodes.filter((n) => n.parentId === groupNode!.id).map((n) => n.id).sort();
  expect(members).toEqual(["a", "b"]);

  // 渲染投影：group presentation 与成员绝对坐标。
  const grouped = await scene(page);
  const g = grouped!.nodes.find((n) => n.id === groupNode!.id)!;
  console.log("group presentation", JSON.stringify(g.group), "group at", g.x, g.y);
  expect(g.group!.memberCount).toBe(2);
  expect(g.group!.outputCapableLeafCount).toBe(2);
  // 成员绝对位置在打组后不变。
  const aAfter = grouped!.nodes.find((n) => n.id === "a")!;
  expect({ x: aAfter.x, y: aAfter.y }).toEqual({ x: aBefore.x, y: aBefore.y });

  // 聚合连线：从 group 右侧输出端点拉到 target。
  const gPort = { x: g.x + 600 + 0, y: g.y + 200 }; // 端点命中按场景尺寸，改用动态计算
  const portHit = await page.evaluate(() => {
    const s = (window as unknown as { __bevyRuntime?: { lastScene?: () => { nodes: Array<{ id: string; type: string; x: number; y: number; width: number; height: number }> } } }).__bevyRuntime?.lastScene?.();
    const group = s?.nodes.find((node) => node.type === "group");
    if (!group) return null;
    return { x: group.x + group.width, y: group.y + group.height / 2 };
  });
  console.log("portHit", JSON.stringify(portHit));
  void gPort;
  const target = grouped!.nodes.find((n) => n.id === "target")!;
  await page.mouse.move(portHit!.x, portHit!.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 40, target.y + 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);

  canvas = await readStoredCanvas(page);
  const aggEdges = canvas!.document.edges.filter((e) => e.target === "target");
  console.log("aggregate edges", JSON.stringify(aggEdges.map((e) => ({ s: e.source, t: e.target }))));
  // 两个成员各一条真实边，且没有 group -> target。
  expect(aggEdges.map((e) => e.source).sort()).toEqual(["a", "b"]);
  expect(aggEdges.some((e) => e.source === groupNode!.id)).toBe(false);

  // 解组：选中 group（用 E2E 钩子避免点选不稳定），右键 **group 背景**（避开成员卡片），点「解组」。
  await page.evaluate((id) => {
    (window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.([id]);
  }, groupNode!.id);
  await page.waitForTimeout(400);
  // group 顶边的空白条带（成员卡片都在 padding 40 之后，顶边 12px 内是安全的）。
  await page.mouse.click(g.x + 20, g.y + 8, { button: "right" });
  await page.waitForTimeout(500);
  const ungroupItem = page.getByRole("menuitem", { name: "解组" });
  await expect(ungroupItem).toBeVisible();
  await ungroupItem.click();
  await page.waitForTimeout(1000);
  canvas = await readStoredCanvas(page);
  console.log("after ungroup: groups", canvas!.document.nodes.filter((n) => n.type === "group").length, "nodes", canvas!.document.nodes.length);
  expect(canvas!.document.nodes.some((n) => n.type === "group")).toBe(false);
  expect(canvas!.document.nodes.some((n) => n.parentId)).toBe(false);

  console.log("errors", JSON.stringify(errors.slice(0, 6)), "count", errors.length);
  console.log("badResponses", JSON.stringify(badResponses.slice(0, 6)), "count", badResponses.length);
  expect(errors).toEqual([]);
  expect(badResponses).toEqual([]);
});
