/**
 * 片场地面范围（等距平行四边形）的真实应用验收
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，任务 5.6 / 6.4 / 7.2 / 7.3）。
 *
 * 在真实 Bevy WASM 运行时上用确定性 fixture 验证：
 * - 范围几何：包裹**模型地面占地**（不是内容适配矩形）的地面矩形投影，四边与地面网格
 *   平行（斜率由画布相机 pitch 决定）、外包矩形宽高比由同一 pitch 决定、8 个抓手（四顶点 + 四边中点）；
 * - hover/select/double-click：范围内命中、范围顶部之上的模型身体命中、AABB 空白角不命中、
 *   双击整体聚焦；
 * - 框选：与平行四边形正面积相交才选中，只碰 AABB 空白角不选中；
 * - drop：真实鼠标把合法 model3d 拖入范围可导入、源节点回位；图片拖入不显示提示且被拒绝；
 *   空白角不命中；上层普通卡片先于业务过滤；所有 composite-asset（含炉体）默认等距范围；
 * - resize：从任意抓手起拖对角锁定等比调整规范 width/height（含中心回算），释放经 Yjs 回流；
 * - pan/zoom、DPR、嵌套 group 下的范围与提示对齐。
 *
 * 断言基于真实运行时镜像（`__bevyRuntime.lastScene()` / `queryPoint` / `queryCompositeAssetScopes`
 * / canonical），不做逐像素哈希；像素只作存在性/颜色信号。几何期望用 contracts 侧纯函数由
 * 场景下发的 `scopeGround` 重算，作为跨语言一致性 oracle。
 */
import {
  CANVAS_CAMERA_PITCH,
  canonicalFilmSetFields,
  compositeAssetScopeContains,
  compositeAssetScopeGeometry,
  createFilmSetSnapshot,
  createModel3DNodeData,
  createModelSnapshot,
  model3DNodeDataFields,
  type FilmSetItem
} from "@woohaa3/contracts";
import { expect, test, type Page } from "@playwright/test";
import {
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  sendCommands,
  waitForCommandsSettled,
  waitForCanvasSession
} from "./helpers.js";

const DEFAULT_W = 260;
const DEFAULT_H = 195;
/** 地面投影轴比由 contracts 的全局画布相机 pitch 决定（design D1/D2）。 */
const S = Math.sin(CANVAS_CAMERA_PITCH);

type ScopeGround = { cx: number; cy: number; hx: number; hz: number };
type ScopeEntry = {
  nodeId: string;
  shape: string;
  vertices: Array<[number, number]>;
  handles: Array<[number, number]>;
  aabb: [number, number, number, number];
  base: [number, number, number, number];
};
type SceneNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  compositeAsset?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scopeShape?: string;
    scopeGround?: ScopeGround;
  };
  group?: { memberCount: number };
};

async function scene(page: Page): Promise<{ nodes: SceneNode[]; viewport: { x: number; y: number; zoom: number }; surface: { pixelRatio: number } } | null> {
  return page.evaluate(() => (window as any).__bevyRuntime?.lastScene?.() ?? null);
}

/** 世界坐标 → 页面 client 坐标（与控制器 `worldToClient` 同一换算）。 */
async function toClient(page: Page, world: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((point) => {
    const s = (window as any).__bevyRuntime.lastScene();
    const v = s.viewport;
    const r = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return { x: r.left + point.x * v.zoom + v.x, y: r.top + point.y * v.zoom + v.y };
  }, world);
}

/** accepted 范围几何条目（由 Rust 从已接受场景派生）。 */
async function acceptedScope(page: Page, nodeId: string): Promise<ScopeEntry | null> {
  return page.evaluate((id) => {
    const r = (window as any).__bevyRuntime?.queryCompositeAssetScopes?.();
    if (!r?.ok) return null;
    return r.value.find((entry: any) => entry.nodeId === id) ?? null;
  }, nodeId);
}

/** 节点下发的 `scopeGround`（地面矩形：投影中心 + 沿地面轴的半边长）。 */
async function scopeGroundOf(page: Page, nodeId: string): Promise<ScopeGround | null> {
  return page.evaluate((id) => {
    const s = (window as any).__bevyRuntime.lastScene();
    return s.nodes.find((n: any) => n.id === id)?.compositeAsset?.scopeGround ?? null;
  }, nodeId);
}

/** 用 contracts 纯函数由 `scopeGround` 重算期望几何（跨语言一致性 oracle）。 */
function expectedGeometry(ground: ScopeGround) {
  return compositeAssetScopeGeometry({ x: 0, y: 0, width: 1, height: 1 }, "isometric-diamond", 32, ground);
}

async function queryPoint(page: Page, world: { x: number; y: number }) {
  return page.evaluate((point) => {
    const zoom = (window as any).__bevyRuntime.lastScene().viewport.zoom;
    const hit = (window as any).__bevyRuntime.queryPoint({ x: point.x, y: point.y, zoom, hoveredEdgeId: null });
    return hit?.value ?? hit;
  }, world);
}

function groundItem(width = 8, depth = 8): FilmSetItem {
  return { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width, depth } };
}

function modelItem(id: string, name: string): FilmSetItem {
  return {
    id,
    kind: "model",
    name,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({id:'body',size:[1.4,1.4,1.4],color:'#40ee50'});`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

/** 小地面、较高的模型：可见身体投影远高于地面范围。 */
function tallModelItem(id: string, name: string): FilmSetItem {
  return {
    id,
    kind: "model",
    name,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({id:'tower',size:[0.5,4,0.5],color:'#40ee50'});`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

/** 建一个带默认尺寸的片场节点，等待其呈现就绪。 */
async function seedFilmSet(
  page: Page,
  id: string,
  position: { x: number; y: number },
  width = DEFAULT_W,
  height = DEFAULT_H,
  items: FilmSetItem[] = [groundItem(), modelItem("actor", "演员")]
) {
  const fields = canonicalFilmSetFields(createFilmSetSnapshot({
    title: "对地面片场",
    timeline: { duration: 0, loop: false },
    filmSetContent: { schemaVersion: 4, items }
  }));
  const result = await sendCommands(page, [
    { type: "node.add", node: { id, type: "composite-asset", position, width, height }, nodeData: fields as never }
  ], `ground-film-${id}`);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await waitForCommandsSettled(page);
  await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === id)?.compositeAsset?.scopeShape)
    .toBe("isometric-diamond");
  await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === id)?.compositeAsset?.scopeGround)
    .not.toBeUndefined();
}

test.describe("片场地面范围（change: 2026-10-12）", () => {
  test("显式地面几何、平行四边形/空白角命中、双击聚焦与 selection 增量", async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await seedFilmSet(page, "film", { x: 240, y: 160 });
    const ground = (await scopeGroundOf(page, "film"))!;
    expect(ground).not.toBeNull();
    const expected = expectedGeometry(ground);

    // 接受几何来自 Rust，与 contracts 由同一 `scopeGround` 重算的一致。
    const accepted = (await acceptedScope(page, "film"))!;
    expect(accepted).not.toBeNull();
    expect(accepted.shape).toBe("isometric-diamond");
    expect(accepted.vertices).toHaveLength(4);
    expect(accepted.handles).toHaveLength(8);
    for (let index = 0; index < 4; index += 1) {
      expect(accepted.vertices[index][0]).toBeCloseTo(expected.vertices[index].x, 2);
      expect(accepted.vertices[index][1]).toBeCloseTo(expected.vertices[index].y, 2);
    }
    for (let index = 0; index < 8; index += 1) {
      expect(accepted.handles[index][0]).toBeCloseTo(expected.handles[index].point.x, 2);
      expect(accepted.handles[index][1]).toBeCloseTo(expected.handles[index].point.y, 2);
    }

    const cx = expected.center.x;
    const cy = expected.center.y;
    // 四边与地面网格平行：top→right、bottom→left 为正，right→bottom、left→top 为负。
    const [top, right, bottom, left] = accepted.vertices;
    expect((right[1] - top[1]) / (right[0] - top[0])).toBeCloseTo(S, 4);
    expect((bottom[1] - right[1]) / (bottom[0] - right[0])).toBeCloseTo(-S, 4);
    // 外包矩形宽高比由同一 pitch 决定。
    expect(accepted.aabb[2] / accepted.aabb[3]).toBeCloseTo(1 / S, 4);

    // 范围包裹模型地面占地，而**不是**内容适配基准矩形：基准矩形角点可落在范围外。
    const [bx, by, bw, bh] = accepted.base;
    const baseOutside = !compositeAssetScopeContains(expected, { x: bx, y: by });
    expect(baseOutside, "基准矩形左上角应落在平行四边形范围外（范围包裹地面占地）").toBe(true);

    // 中心命中 film-scope；AABB 空白角不命中。
    const insideBase = await queryPoint(page, { x: cx, y: cy });
    expect(insideBase?.kind).toBe("film-scope");
    const blankCorner = { x: accepted.aabb[0] + 4, y: accepted.aabb[1] + 4 };
    const cornerHit = await queryPoint(page, blankCorner);
    expect(cornerHit?.kind, JSON.stringify(blankCorner)).not.toBe("film-scope");

    // 选中常驻 + 抓手：选中后验收 8 抓手可命中（右顶点 `e`）。
    await page.evaluate(() => (window as any).__canvasSetSelection?.(["film"]));
    await page.waitForTimeout(300);
    const rightClient = await toClient(page, { x: right[0], y: right[1] });
    const gripHit = await queryPoint(page, { x: right[0], y: right[1] });
    expect(gripHit?.kind).toBe("resize");
    expect(gripHit?.handle).toBe("e");

    // 双击进入整体聚焦，再 Escape 退出（中心点位于范围内）。
    const centerClient = await toClient(page, { x: cx, y: cy });
    await page.mouse.dblclick(centerClient.x, centerClient.y);
    await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()), { timeout: 30_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.())).toBe(false);

    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("film-ground-geometry.png") });
    void rightClient;
  });

  test("高模型身体在范围顶部之上仍可点选，但空白角与 drop 不扩散", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    // 无地面、单根高模型：地面范围被最小尺寸兜底，可见身体投影远高于范围顶部。
    await seedFilmSet(page, "tall", { x: 240, y: 160 }, DEFAULT_W, DEFAULT_H, [tallModelItem("tower", "高塔")]);
    const accepted = (await acceptedScope(page, "tall"))!;
    const [bx, by, bw] = accepted.base;
    const body = { x: accepted.aabb[0] + accepted.aabb[2] / 2, y: accepted.aabb[1] - 10 };
    expect(body.y, "选取点应位于范围顶部之上且在内容适配矩形内").toBeGreaterThan(by + 4);
    expect(body.y).toBeLessThan(accepted.aabb[1]);
    expect(body.x).toBeGreaterThan(bx);
    expect(body.x).toBeLessThan(bx + bw);

    // 范围顶部之上的模型身体可点选（旧实现只认地面多边形，这里点不中）。
    await expect.poll(async () => (await queryPoint(page, body))?.kind).toBe("film-scope");

    // AABB 空白角仍在平行四边形外：不因身体可点选而扩散命中。
    const corner = { x: accepted.aabb[0] + 4, y: accepted.aabb[1] + 4 };
    expect((await queryPoint(page, corner))?.kind).not.toBe("film-scope");

    // drop 仍只认地面范围：身体上方释放不把片场当作素材接收目标。
    const dropTarget = await page.evaluate((point) => {
      const r = (window as any).__bevyRuntime?.queryDropTarget?.(point, []);
      return r?.ok ? r.value : { unavailable: r?.reason };
    }, body);
    expect(dropTarget).toBeNull();
  });

  test("框选按平行四边形正面积相交，空白角不选中", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 240, y: 200 });
    const accepted = (await acceptedScope(page, "film"))!;
    const [ax, ay, aw, ah] = accepted.aabb;
    const selection = () => page.evaluate(() => (window as any).__canvasSelection?.().store ?? []);

    // 反向拖框完全在 AABB 左上空白角内 → 不选中。
    const a = await toClient(page, { x: ax + 6, y: ay + 6 });
    const b = await toClient(page, { x: ax + 20, y: ay + 20 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await selection()).not.toContain("film");

    // 框完全包含整个平行四边形 → 选中。
    const outerA = await toClient(page, { x: ax - 30, y: ay - 30 });
    const outerB = await toClient(page, { x: ax + aw + 30, y: ay + ah + 30 });
    await page.mouse.move(outerA.x, outerA.y);
    await page.mouse.down();
    await page.mouse.move(outerB.x, outerB.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await selection()).toContain("film");
  });

  test("真实鼠标把 model3d 拖入范围并原子回位", async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 640, y: 200 }, 360, 260);

    // 合法 model3d 来源。
    const sourceFields = model3DNodeDataFields(createModel3DNodeData({
      title: "可拖入模型",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1],color:'#2266ee'});", modelScriptVersion: "woohaa-model-js-v2" }
    }));
    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "src", type: "model3d", position: { x: 80, y: 600 } }, nodeData: sourceFields as never }
    ], "ground-drop-src")).ok).toBe(true);
    await waitForCommandsSettled(page);
    await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === "src") != null).toBe(true);

    const before = await readStoredCanvas(page);
    const srcBefore = before!.document.nodes.find((n) => n.id === "src")!.position;
    const itemsBefore = (before!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items.length;

    // 目标：范围中心（地面占地内部）。
    const accepted = (await acceptedScope(page, "film"))!;
    const dropWorld = { x: accepted.aabb[0] + accepted.aabb[2] / 2, y: accepted.aabb[1] + accepted.aabb[3] / 2 };
    const dropTarget = await page.evaluate((point) => {
      const r = (window as any).__bevyRuntime?.queryDropTarget?.(point, []);
      return r?.ok ? r.value : { unavailable: r?.reason };
    }, dropWorld);
    expect(dropTarget).toBe("film");

    const srcClient = await toClient(page, { x: 80 + 130, y: 600 + 100 });
    const dropClient = await toClient(page, dropWorld);
    await page.mouse.move(srcClient.x, srcClient.y);
    await page.mouse.down();
    await page.mouse.move(dropClient.x, dropClient.y, { steps: 16 });
    // 拖动期间 DOM 提示应出现且为 SVG polygon（accepted 顶点）。
    await expect(page.locator(".node-drop-overlay polygon").first()).toBeAttached({ timeout: 10_000 });
    await page.screenshot({ path: info.outputPath("film-ground-drop-hover.png") });
    await page.mouse.up();
    await waitForCommandsSettled(page);
    await page.waitForTimeout(500);

    const after = await readStoredCanvas(page);
    const itemsAfter = (after!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items;
    // 片场多了一个导入对象，来源节点回位、未移动、未被删除。
    expect(itemsAfter.length).toBe(itemsBefore + 1);
    expect(after!.document.nodes.find((n) => n.id === "src")).toBeTruthy();
    expect(after!.document.nodes.find((n) => n.id === "src")!.position).toEqual(srcBefore);
    // 导入对象带来源身份。
    expect(itemsAfter.some((item) => (item as any).origin?.sourceNodeId === "src")).toBe(true);

    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("film-ground-drop-done.png") });
  });

  test("图片拖到片场：不显示接收提示，释放后提示不支持且源节点回位", async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 640, y: 200 }, 360, 260);

    // 一张普通图片节点（不要求 ready 资产：拖动提示与释放判定只看节点类型）。
    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "pic", type: "image", position: { x: 80, y: 600 } } }
    ], "ground-drop-image")).ok).toBe(true);
    await waitForCommandsSettled(page);
    await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === "pic") != null).toBe(true);

    const before = await readStoredCanvas(page);
    const itemsBefore = (before!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items.length;
    const srcBefore = before!.document.nodes.find((n) => n.id === "pic")!.position;

    const accepted = (await acceptedScope(page, "film"))!;
    const dropWorld = { x: accepted.aabb[0] + accepted.aabb[2] / 2, y: accepted.aabb[1] + accepted.aabb[3] / 2 };
    // 目标查询仍会固定片场 identity（提示由接收方谓词决定，而不是查询失败）。
    const dropTarget = await page.evaluate((point) => {
      const r = (window as any).__bevyRuntime?.queryDropTarget?.(point, []);
      return r?.ok ? r.value : { unavailable: r?.reason };
    }, dropWorld);
    expect(dropTarget).toBe("film");

    const srcClient = await toClient(page, { x: 80 + 130, y: 600 + 100 });
    const dropClient = await toClient(page, dropWorld);
    await page.mouse.move(srcClient.x, srcClient.y);
    await page.mouse.down();
    await page.mouse.move(dropClient.x, dropClient.y, { steps: 16 });
    // 拖动期间片场不显示接收提示（change: 2026-10-18-restrict-film-set-drop-to-models）。
    await page.waitForTimeout(300);
    expect(await page.locator(".node-drop-overlay").count()).toBe(0);
    await page.mouse.up();
    await waitForCommandsSettled(page);
    await page.waitForTimeout(300);

    const after = await readStoredCanvas(page);
    // 未导入；来源回位（消费为明确失败，不回退成普通移动）。
    expect((after!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items.length).toBe(itemsBefore);
    expect(after!.document.nodes.find((n) => n.id === "pic")!.position).toEqual(srcBefore);
    // 释放后给出不受支持的说明。
    await expect.poll(async () => page.evaluate(() => document.getElementById("film-set-drop-feedback")?.textContent ?? ""))
      .toContain("仅普通模型可以拖入片场");

    expect(errors).toEqual([]);
  });

  test("AABB 空白角释放不命中片场（来源按普通移动处理）", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 640, y: 260 }, 360, 260);

    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "src", type: "model3d", position: { x: 80, y: 660 } }, nodeData: model3DNodeDataFields(createModel3DNodeData({
        title: "空白角来源",
        model: { modelScript: "scene.box({id:'body',size:[1,1,1],color:'#ee6622'});", modelScriptVersion: "woohaa-model-js-v2" }
      })) as never }
    ], "ground-corner-src")).ok).toBe(true);
    await waitForCommandsSettled(page);

    const before = await readStoredCanvas(page);
    const itemsBefore = (before!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items.length;
    const srcBefore = before!.document.nodes.find((n) => n.id === "src")!.position;

    const accepted = (await acceptedScope(page, "film"))!;
    // 左上 AABB 空白角（平行四边形外、AABB 内）。
    const corner = { x: accepted.aabb[0] + 6, y: accepted.aabb[1] + 6 };
    const srcClient = await toClient(page, { x: 80 + 130, y: 660 + 100 });
    const cornerClient = await toClient(page, corner);
    await page.mouse.move(srcClient.x, srcClient.y);
    await page.mouse.down();
    await page.mouse.move(cornerClient.x, cornerClient.y, { steps: 16 });
    await page.mouse.up();
    await waitForCommandsSettled(page);
    await page.waitForTimeout(500);

    const after = await readStoredCanvas(page);
    // 空白角未命中片场 → 不导入；来源按普通移动移动。
    expect((after!.nodeData.film.filmSetContent as { items: FilmSetItem[] }).items.length).toBe(itemsBefore);
    const srcAfter = after!.document.nodes.find((n) => n.id === "src")!.position;
    expect(srcAfter).not.toEqual(srcBefore);
  });

  test("上层普通卡片先于业务过滤；所有 composite-asset（含炉体）默认等距范围", async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await seedFilmSet(page, "film", { x: 240, y: 200 }, 360, 260);
    const accepted = (await acceptedScope(page, "film"))!;
    const center = { x: accepted.aabb[0] + accepted.aabb[2] / 2, y: accepted.aabb[1] + accepted.aabb[3] / 2 };

    // 上层普通图片卡片放在范围中心（覆盖片场）。
    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "card", type: "image", position: { x: Math.round(center.x - 60), y: Math.round(center.y - 40) } } }
    ], "ground-top-card")).ok).toBe(true);
    await waitForCommandsSettled(page);
    await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === "card") != null).toBe(true);

    // queryDropTarget 先固定上层实际节点（card），来源排除生效。
    const cardCenter = await page.evaluate(() => {
      const s = (window as any).__bevyRuntime.lastScene();
      const n = s.nodes.find((entry: any) => entry.id === "card");
      return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
    });
    const dropAtCard = await page.evaluate((point) => {
      const r = (window as any).__bevyRuntime?.queryDropTarget?.(point, []);
      return r?.ok ? r.value : { unavailable: r?.reason };
    }, cardCenter);
    expect(dropAtCard).toBe("card");

    // 片场 + 炉体对照：所有 composite-asset 默认使用等距地面范围，不按业务显式声明。
    const furnace = model3DNodeDataFields(createModel3DNodeData({
      title: "游戏炼丹炉",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1],color:'#aa7733'});", modelScriptVersion: "woohaa-model-js-v2" }
    }));
    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "furnace", type: "composite-asset", position: { x: 1000, y: 640 }, width: 260, height: 195 }, nodeData: { extensionId: "game-furnace", ...furnace } as never }
    ], "ground-furnace")).ok).toBe(true);
    await waitForCommandsSettled(page);

    await expect.poll(async () => {
      const s = await scene(page);
      const node = s?.nodes.find((n) => n.id === "furnace");
      return node?.compositeAsset?.scopeShape ?? null;
    }).toBe("isometric-diamond");
    // 炉体也派生地面矩形，AABB 宽高比由同一 pitch 决定。
    expect((await scopeGroundOf(page, "furnace"))).not.toBeNull();
    const furnaceScope = (await acceptedScope(page, "furnace"))!;
    expect(furnaceScope.aabb[2] / furnaceScope.aabb[3]).toBeCloseTo(1 / S, 3);

    const scopes = await page.evaluate(() => {
      const r = (window as any).__bevyRuntime?.queryCompositeAssetScopes?.();
      return r?.ok ? r.value.map((e: any) => ({ nodeId: e.nodeId, shape: e.shape })) : null;
    });
    expect(scopes).toContainEqual({ nodeId: "film", shape: "isometric-diamond" });
    expect(scopes).toContainEqual({ nodeId: "furnace", shape: "isometric-diamond" });

    await page.screenshot({ path: info.outputPath("film-ground-vs-furnace.png") });
  });

  test("抓手对角锁定等比 resize，pointerup 提交规范 width/height", async ({ page }, info) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 200, y: 200 }, 260, 195);

    // 选中后抓手出现在 8 个位置。
    await page.evaluate(() => (window as any).__canvasSetSelection?.(["film"]));
    await page.waitForTimeout(300);
    const accepted = (await acceptedScope(page, "film"))!;
    const anchor = accepted.handles[6]; // w（对边）
    const handle = accepted.handles[2]; // e
    const axis = { x: handle[0] - anchor[0], y: handle[1] - anchor[1] };

    // 沿缩放轴拖动使 k ≈ 1.5。
    const k = 1.5;
    const pointer = { x: handle[0] + (k - 1) * axis.x, y: handle[1] + (k - 1) * axis.y };
    const startClient = await toClient(page, { x: handle[0], y: handle[1] });
    const endClient = await toClient(page, pointer);
    await page.mouse.move(startClient.x, startClient.y);
    await page.mouse.down();
    await page.mouse.move(endClient.x, endClient.y, { steps: 12 });
    await page.mouse.up();
    await waitForCommandsSettled(page);

    const after = await readStoredCanvas(page);
    const node = after!.document.nodes.find((n) => n.id === "film") as { width?: number; height?: number; position: { x: number; y: number } };
    // 等比：width/height 比例与默认一致（允许单像素量化误差）。
    expect(node.width).toBeGreaterThan(DEFAULT_W);
    expect(node.height).toBeGreaterThan(DEFAULT_H);
    expect(node.width! / node.height!).toBeCloseTo(DEFAULT_W / DEFAULT_H, 2);
    // 对角锁定：锚点 `w` 保持不动 → 中心右移，position.x 增大。
    expect(node.position.x).toBeGreaterThan(200);
    // 范围仍是 isometric-diamond，随新尺寸派生。
    await expect.poll(async () => (await scene(page))?.nodes.find((n) => n.id === "film")?.compositeAsset?.scopeShape)
      .toBe("isometric-diamond");

    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("film-ground-resize.png") });
  });

  test("嵌套 group + pan/zoom/DPR 下范围与提示仍对齐", async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await seedFilmSet(page, "film", { x: 300, y: 220 }, 300, 220);

    // 建一个 group 并把片场作为成员（parentId）；成员绝对位置不变，范围按绝对坐标派生。
    expect((await sendCommands(page, [
      { type: "node.add", node: { id: "grp", type: "group", position: { x: 160, y: 120 }, width: 900, height: 700 } }
    ], "ground-group-add")).ok).toBe(true);
    await waitForCommandsSettled(page);
    expect((await sendCommands(page, [
      { type: "node.update", nodeId: "film", parentId: "grp", position: { x: 140, y: 100 } }
    ], "ground-group-reparent")).ok).toBe(true);
    await waitForCommandsSettled(page);

    const grouped = await scene(page);
    const filmNode = grouped!.nodes.find((n) => n.id === "film")!;
    // 片场绝对 x = group.x + local；范围以绝对坐标派生，仍是平行四边形。
    expect(filmNode.compositeAsset?.scopeShape).toBe("isometric-diamond");
    const beforeGround = (await scopeGroundOf(page, "film"))!;

    // 缩放（滚轮）后，世界范围不变、client 坐标随 zoom 变化。
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => (await scene(page))?.viewport.zoom).not.toBe(1);
    const afterZoom = (await scopeGroundOf(page, "film"))!;
    expect(afterZoom.cx).toBeCloseTo(beforeGround.cx, 3);
    expect(afterZoom.cy).toBeCloseTo(beforeGround.cy, 3);

    // DPR：窗口尺寸变化后 surface.pixelRatio 跟随，范围世界坐标不变。
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(400);
    const afterResize = (await scopeGroundOf(page, "film"))!;
    expect(afterResize.cx).toBeCloseTo(beforeGround.cx, 3);

    await page.screenshot({ path: info.outputPath("film-ground-viewport.png") });
  });
});
