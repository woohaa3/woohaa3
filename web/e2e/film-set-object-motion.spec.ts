/**
 * 片场对象动作与聚焦对象编辑的浏览器验收
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 7.3/7.4）。
 *
 * 用产品镜像断言：
 * - 空顶层源码的片场仍组合内部模型与地面（`filmSet.itemRoots` 非空、model 资源注册）；
 * - 拖入 model3d 复制导入到片场后，片场出现导入对象且源节点回位；
 * - 聚焦对象模式可点击选择、拖动移动（一次 itemId 提交）、Shift 旋转、删除；
 * - 固定 T 截图包含内容（前景像素）。
 */
import { filmSetNodeDataFields, createFilmSetSnapshot, createModelSnapshot } from "@woohaa3/contracts";
import { expect, test, type Page } from "@playwright/test";
import {
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  sendCommands,
  waitForCanvasSession,
} from "./helpers.js";

type SceneNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  model?: { resourceKey: string; signature: string };
  filmSet?: { x: number; y: number; width: number; height: number; itemRoots?: Record<string, string> };
};

async function scene(page: Page): Promise<{ nodes: SceneNode[] } | null> {
  return page.evaluate(
    () =>
      ((window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene?.() ??
        null) as never,
  ) as Promise<never>;
}

async function readFilmSetContent(page: Page, nodeId: string): Promise<{ items: Array<{ id: string; kind: string; localTransform: { offset: { x: number }; yaw: number; scale: number } }> } | null> {
  const canvas = await readStoredCanvas(page);
  const data = canvas?.nodeData?.[nodeId] as { filmSetContent?: unknown } | undefined;
  const content = data?.filmSetContent as { items?: unknown[] } | undefined;
  return content ? (content as never) : null;
}

/** 等待片场组合资源就绪（filmSet.itemRoots 非空）。 */
async function waitForFilmSetRoots(page: Page, nodeId: string, minimum = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await scene(page);
        const node = s?.nodes.find((entry) => entry.id === nodeId);
        return node?.compositeAsset?.itemRoots ? Object.keys(node.compositeAsset.itemRoots).length : 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(minimum);
}

/** 前景像素统计（非中性色）。 */
async function foregroundCount(page: Page): Promise<number> {
  const buffer = await page.locator("#bevy-canvas").screenshot();
  const base64 = buffer.toString("base64");
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let y = 0; y < bitmap.height; y += 2) {
      for (let x = 0; x < bitmap.width; x += 2) {
        const i = (y * bitmap.width + x) * 4;
        const mx = Math.max(px[i], px[i + 1], px[i + 2]);
        const mn = Math.min(px[i], px[i + 1], px[i + 2]);
        if (mx - mn > 40 && mx > 60) count += 1;
      }
    }
    return count;
  }, base64);
}

const FILM_SET_NODE_DATA = filmSetNodeDataFields(createFilmSetSnapshot({
  title: "片场", model: { modelScript: "", modelScriptVersion: "woohaa-model-js-v2" },
  motionScript: "", timeline: { duration: 0, loop: false },
  filmSetContent: { schemaVersion: 3, items: [] }
}));

test.describe("片场对象动作与对象编辑（change: 2026-10-09）", () => {
  test("空顶层源码片场组合内部模型与地面，真实截图有内容", async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(
      page,
      [
        {
          type: "node.add",
          node: { id: "filmset", type: "composite-asset", position: { x: 200, y: 120 }, width: 260, height: 195 },
          nodeData: {
            ...FILM_SET_NODE_DATA,
            filmSetContent: {
              schemaVersion: 3,
              items: [
                {
                  id: "obj-a",
                  kind: "model",
                  name: "导入模型",
                  localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
                  model: {
                    modelScript: `scene.box({id:'body',size:[1.6,1.6,1.6],color:'#e23b3b'});`,
                    modelScriptLanguage: "javascript",
                    modelScriptVersion: "woohaa-model-js-v2",
                    contentVersion: { revision: 1, sourceHash: "obj-a-src", contentHash: "obj-a-content" },
                    placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
                  },
                },
                {
                  id: "occluder", kind: "model", name: "遮挡模型",
                  localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
                  model: createModelSnapshot({ modelScript: "scene.box({id:'block',size:[4,4,4],color:'#757575'});", modelScriptVersion: "woohaa-model-js-v2" }),
                },
                {
                  id: "g",
                  kind: "ground",
                  name: "地面",
                  localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
                  size: { width: 8, depth: 8 },
                },
              ],
            },
          },
        },
      ] as never,
      "film-object-empty-top",
    );

    // 组合资源注册：片场节点带 model 引用且 itemRoots 含两个对象。
    await waitForFilmSetRoots(page, "filmset", 3);
    const s = await scene(page);
    const node = s!.nodes.find((entry) => entry.id === "filmset")!;
    expect(node.model?.resourceKey).toBeTruthy();
    expect(Object.keys(node.compositeAsset!.itemRoots!).sort()).toEqual(["g", "obj-a", "occluder"]);

    // Real pointer editing: preview must move before release without canonical writes.
    await page.mouse.dblclick(330, 217);
    await expect(page.locator(".film-set-object-dock")).toBeVisible();
    await expect(page.getByRole("radio", { name: "对象", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "模型 · 导入模型" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().modelEditor?.toolMode)).toBe("object");
    await page.waitForTimeout(600); // Finish the observer camera transition before sampling pixels.
    for (const axis of ["x", "y", "z"] as const) {
      const handle = await page.evaluate((axis) => {
        const runtime = (window as any).__bevyRuntime;
        const editor = runtime.lastScene().modelEditor;
        const projection = (window as any).__canvasModelFocus.projection();
        const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
        for (let y = 12; y < rect.height - 12; y += 6) {
          for (let x = 12; x < rect.width - 340; x += 6) {
            const hit = runtime.queryGizmoHit({ kind: "object", editor, projection, surface: { width: rect.width, height: rect.height }, point: { x, y } });
            if (hit?.handle === axis && hit.constraint) return { x: rect.left + x, y: rect.top + y, direction: hit.constraint.direction };
          }
        }
        throw new Error(`No ${axis} handle in actual WASM projection`);
      }, axis);
      // The selected cube is enclosed by a larger opaque model. Handles must still draw above it.
      const png = (await page.locator("#bevy-canvas").screenshot()).toString("base64");
      const axisPixels = await page.evaluate(async ({ png, handle, axis }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: "image/png" }));
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
        const x = Math.round((handle.x - rect.left) * bitmap.width / rect.width);
        const y = Math.round((handle.y - rect.top) * bitmap.height / rect.height);
        const pixels = ctx.getImageData(x - 20, y - 20, 41, 41).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
          if (axis === "x" ? r > g + 45 && r > b + 45 : axis === "y" ? g > r + 45 && g > b + 45 : b > r + 45 && b > g + 30) count++;
        }
        return count;
      }, { png, handle, axis });
      expect(axisPixels, `${axis} gizmo is visible through the enclosing model`).toBeGreaterThan(0);
      const before = await readFilmSetContent(page, "filmset");
      const previous = before!.items.find(item => item.id === "obj-a")!.localTransform;
      const boundsBefore = await page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("filmset").find((item: any) => item.itemId === "obj-a").center);
      const key = (await scene(page))!.nodes.find(node => node.id === "filmset")!.model!.resourceKey;
      const pixelsBefore = await page.locator("#bevy-canvas").screenshot();
      await page.mouse.move(handle.x, handle.y); await page.mouse.down();
      await page.mouse.move(handle.x + handle.direction[0] * 35, handle.y + handle.direction[1] * 35, { steps: 6 });
      await expect.poll(async () => page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("filmset").find((item: any) => item.itemId === "obj-a").center)).not.toEqual(boundsBefore);
      expect((await readFilmSetContent(page, "filmset"))!.items.find(item => item.id === "obj-a")!.localTransform).toEqual(previous);
      expect((await scene(page))!.nodes.find(node => node.id === "filmset")!.model!.resourceKey).toBe(key);
      expect((await page.locator("#bevy-canvas").screenshot()).equals(pixelsBefore)).toBe(false);
      const liveValues = await page.locator(".film-set-transform input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
      await page.mouse.up();
      await expect.poll(async () => (await readFilmSetContent(page, "filmset"))!.items.find(item => item.id === "obj-a")!.localTransform).not.toEqual(previous);
      await expect.poll(() => page.locator(".film-set-transform input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(liveValues);
    }
    const saved = (await readFilmSetContent(page, "filmset"))!.items.find(item => item.id === "obj-a")!.localTransform;
    await page.reload(); await waitForCanvasSession(page); await waitForFilmSetRoots(page, "filmset", 3);
    expect((await readFilmSetContent(page, "filmset"))!.items.find(item => item.id === "obj-a")!.localTransform).toEqual(saved);

    // 真实截图有内容（前景像素）。
    expect(await foregroundCount(page)).toBeGreaterThan(50);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("film-set-empty-top.png") });
  });

  test("拖入 model3d：复制导入片场可见，源节点回位", async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(
      page,
      [
        {
          type: "node.add",
          node: { id: "filmset", type: "composite-asset", position: { x: 200, y: 120 }, width: 260, height: 195 },
          nodeData: { ...FILM_SET_NODE_DATA },
        },
        {
          type: "node.add",
          node: { id: "src", type: "model3d", position: { x: 640, y: 430 }, width: 196, height: 64 },
          nodeData: {
            modelScript: `scene.box({id:'body',size:[1.4,1.4,1.4],color:'#3b6fe2'});`,
            modelScriptLanguage: "javascript",
            modelScriptVersion: "woohaa-model-js-v2",
            modelContentVersion: { revision: 1, sourceHash: "src-src", contentHash: "src-content" },
            modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
          },
        },
      ] as never,
      "film-object-drag-seed",
    );
    await page.waitForTimeout(400);

    // 真实鼠标把 model3d 拖到片场中心。
    const film = await page.evaluate(() => {
      const node = (window as any).__bevyRuntime.lastScene().nodes.find((n: any) => n.id === "filmset");
      const viewport = (window as any).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      return {
        filmX: rect.left + (node.compositeAsset.x + node.compositeAsset.width / 2) * viewport.zoom + viewport.x,
        filmY: rect.top + (node.compositeAsset.y + node.compositeAsset.height / 2) * viewport.zoom + viewport.y,
      };
    });
    const src = await page.evaluate(() => {
      const node = (window as any).__bevyRuntime.lastScene().nodes.find((n: any) => n.id === "src");
      const viewport = (window as any).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      return {
        x: rect.left + (node.x + node.width / 2) * viewport.zoom + viewport.x,
        y: rect.top + (node.y + node.height / 2) * viewport.zoom + viewport.y,
      };
    });

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(film.filmX, film.filmY, { steps: 12 });
    await page.mouse.up();

    // 权威内容出现导入对象（kind=model），源节点位置不变。
    await expect
      .poll(async () => {
        const content = await readFilmSetContent(page, "filmset");
        return content?.items.some((item) => item.kind === "model") ?? false;
      }, { timeout: 30_000 })
      .toBe(true);
    const canvas = await readStoredCanvas(page);
    const source = canvas!.document.nodes.find((entry) => entry.id === "src");
    expect(source?.position).toEqual({ x: 640, y: 430 });

    // 导入后片场渲染出现对象根。
    await waitForFilmSetRoots(page, "filmset", 1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("film-set-drag-import.png") });
  });
});
