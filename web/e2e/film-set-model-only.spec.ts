import { createModelSnapshot, defaultSelfContained3DNodeData, type FilmSetItem } from "@woohaa3/contracts";
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import {
  resetCanvasStorage,
  waitForCanvasSession,
  sendCommands,
  readStoredCanvas,
  waitForCommandsSettled,
} from "./helpers.js";

/** 片场节点的范围几何与卡片字段。 */
async function filmNode(page: Page, id: string) {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((n: any) => n.id === id);
    const view = scene.viewport;
    const canvas = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    const scope = node.compositeAsset;
    return {
      cardLabel: node.cardLabel,
      modelPreview: node.modelPreview,
      compositeAsset: scope,
      centerX: canvas.left + (scope.x + scope.width / 2) * view.zoom + view.x,
      centerY: canvas.top + (scope.y + scope.height / 2) * view.zoom + view.y,
      canvasId: node.id,
    };
  }, id);
}

test("纯模型片场：无卡片/端口、范围框 hover/选中、空片场可命中、整体聚焦、无连线", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);

  const script = `scene.box({id:'body',size:[1,1,.5],color:'#40ee50'});`;
  expect(
    (
      await sendCommands(page, [
        {
          type: "node.add",
          nodeData: defaultSelfContained3DNodeData("composite-asset"),
          node: { id: "filmset", type: "composite-asset", position: { x: 200, y: 120 }, width: 196, height: 64 },
        },
      ])
    ).ok,
  ).toBe(true);
  await waitForCommandsSettled(page);
  await expect
    .poll(async () => (await readStoredCanvas(page))!.document.nodes.length)
    .toBe(1);

  // 新片场只有可编辑、可删除的地面；模型必须作为独立 item 添加。
  const initial = (await readStoredCanvas(page))!.nodeData.filmset;
  expect(initial.extensionId).toBe("film-set");
  const initialContent = initial.filmSetContent as { schemaVersion: number; items: FilmSetItem[] };
  expect(initialContent.schemaVersion).toBe(3);
  expect(initialContent.items).toHaveLength(1);
  expect(initialContent.items[0].kind).toBe("ground");
  expect(initial).not.toHaveProperty("modelScript");
  const modelItem: FilmSetItem = {
    id: "film-model",
    kind: "model",
    name: "模型",
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: script, modelScriptVersion: "woohaa-model-js-v2" }),
  };
  expect((await sendCommands(page, [{
    type: "nodeData.patch",
    nodeId: "filmset",
    value: { filmSetContent: { schemaVersion: 4, items: [...initialContent.items, modelItem] } },
  }])).ok).toBe(true);
  await waitForCommandsSettled(page);
  await expect.poll(async () => ((await readStoredCanvas(page))!.nodeData.filmset.filmSetContent as { items: FilmSetItem[] }).items.map(item => item.id))
    .toEqual([initialContent.items[0].id, modelItem.id]);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.find((node: any) => node.id === "filmset")?.compositeAsset != null))
    .toBe(true);

  // 无顶部卡片分类名、无内嵌预览；带条件范围几何。
  const film = await filmNode(page, "filmset");
  expect(film.cardLabel).toBeUndefined();
  expect(film.modelPreview).toBeUndefined();
  expect(film.compositeAsset).toBeDefined();
  expect(film.compositeAsset.width).toBeGreaterThan(0);

  // 关键：在**真实 WASM** 上查询范围中心，必须命中 `film-scope` 而非卡片。此断言依赖
  // Rust 端正确反序列化 camelCase `filmSet` 键，可捕获键名不匹配缺陷
  // （change: 2026-10-08-make-film-set-model-only）。
  const hitAtScope = await page.evaluate(
    (point) =>
      (window as any).__bevyRuntime.queryPoint({
        x: point.x,
        y: point.y,
        zoom: 1,
        hoveredEdgeId: null,
      }),
    { x: film.compositeAsset.x + film.compositeAsset.width / 2, y: film.compositeAsset.y + film.compositeAsset.height / 2 },
  );
  expect(hitAtScope?.value ?? hitAtScope).toMatchObject({ kind: "film-scope" });

  // 双击范围进入整体聚焦。
  await page.mouse.dblclick(film.centerX, film.centerY);
  await expect
    .poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()))
    .toBe(true);
  await expect(page.locator(".model-editor-dock")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.()))
    .toBe(false);

  // 点击范围选择片场；节点未产生端口命中（纯模型）。
  await page.mouse.click(film.centerX, film.centerY);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().selection.nodes)).toContain("filmset");

  // Query both sides where card ports used to be, then perform an actual drag.
  for (const x of [film.compositeAsset.x, film.compositeAsset.x + film.compositeAsset.width]) {
    const hit = await page.evaluate(point => (window as any).__bevyRuntime.queryPoint(point), { x, y: film.compositeAsset.y + film.compositeAsset.height / 2, zoom: 1 });
    expect((hit?.value ?? hit)?.kind).not.toBe("port");
  }
  await page.mouse.move(film.centerX, film.centerY);
  await page.mouse.down();
  await page.mouse.move(film.centerX + 80, film.centerY + 40, { steps: 8 });
  await page.mouse.up();
  // The gesture may reposition the film set, but cannot start a connection.
  const edgesAfter = await page.evaluate(
    () => (window as any).__bevyRuntime.lastScene().edges.length,
  );
  expect(edgesAfter).toBe(0);

  // 删除地面/清空内容后仍可命中范围（空片场）。
  // 通过真实对象删除命令清空，包括显式地面；不使用已移除的顶层模型字段。
  expect(
    (
      await sendCommands(page, [...initialContent.items, modelItem].map(item => ({
        type: "filmSet.itemPatch" as const,
        nodeId: "filmset",
        itemId: item.id,
        op: { kind: "delete" as const },
      })))
    ).ok,
  ).toBe(true);
  await waitForCommandsSettled(page);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const node = (window as any).__bevyRuntime
          .lastScene()
          .nodes.find((n: any) => n.id === "filmset");
        return node.compositeAsset != null;
      }),
    )
    .toBe(true);

  await expect.poll(async () => {
    const canvas = await readStoredCanvas(page);
    return (canvas?.nodeData.filmset.filmSetContent as { items: FilmSetItem[] } | undefined)?.items;
  }).toEqual([]);
  const cleared = (await readStoredCanvas(page))!.nodeData.filmset;
  expect(cleared.filmSetAnimations).toMatchObject({ schemaVersion: 3, defaultClipId: null, clips: [] });
  expect(cleared).not.toHaveProperty("modelScript");
  const empty = await filmNode(page, "filmset");
  const emptyHit = await page.evaluate(point => (window as any).__bevyRuntime.queryPoint(point), { x: empty.compositeAsset.x + empty.compositeAsset.width / 2, y: empty.compositeAsset.y + empty.compositeAsset.height / 2, zoom: 1 });
  expect(emptyHit?.value ?? emptyHit).toMatchObject({ kind: "film-scope" });
  await page.mouse.dblclick(empty.centerX, empty.centerY);
  await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.())).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("film-set-model-only.png") });
});
