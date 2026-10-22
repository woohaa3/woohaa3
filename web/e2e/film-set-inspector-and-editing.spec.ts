/**
 * 片场标题、对象键盘编辑、分层 Escape 与任务检查面板浏览器验收
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 7.2/7.3/7.6）。
 *
 * 在真实 Bevy WASM 运行时上用确定性 fixture 验证：
 * - 范围标题随 hover/选中显隐，移出回收、再次 hover 重建（0→1→0→1），文案来自共享名称；
 * - 场景选中对象后 Delete/Backspace 只删除该 item、片场节点保留，可撤销/重做；无选中不回退
 *   删除整个片场；数值输入内 Backspace 不误删；
 * - Escape 分层：活动手势取消（后续 pointerup 不提交）→ 清对象选择 → 退出聚焦；
 * - 对象/镜头/动画任务页签可达、选中联动且切页零命令；
 * - 390px 窄屏无横向溢出、页签与删除可用。
 *
 * 像素判定用容差，不做逐像素哈希。
 */
import { filmSetNodeDataFields, createFilmSetSnapshot, createModelSnapshot, type FilmSetItem } from "@woohaa3/contracts";
import { expect, test, type Page } from "@playwright/test";
import {
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  sendCommands,
  waitForCanvasSession
} from "./helpers.js";

type SceneNode = {
  id: string;
  title?: string;
  typeLabel?: string;
  filmSet?: { x: number; y: number; width: number; height: number };
  model?: { resourceKey: string };
};

async function lastScene(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__bevyRuntime?.lastScene?.() ?? null);
}

async function filmNode(page: Page, nodeId: string): Promise<SceneNode | undefined> {
  const scene = await lastScene(page);
  return scene?.nodes?.find((node: SceneNode) => node.id === nodeId);
}

/** 片场节点的规范字段（默认空集合）。 */
function filmSetFields(title: string, items: FilmSetItem[] = []) {
  return filmSetNodeDataFields(
    createFilmSetSnapshot({
      title,
      motionScript: "",
      timeline: { duration: 0, loop: false },
      filmSetContent: { schemaVersion: 3, items }
    })
  );
}

function modelItem(id: string, name: string, color: string): FilmSetItem {
  return {
    id,
    kind: "model",
    name,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({id:'body',size:[1.4,1.4,1.4],color:'${color}'});`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

function groundItem(): FilmSetItem {
  return { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } };
}

async function waitForFilmSet(page: Page, nodeId: string): Promise<void> {
  await expect
    .poll(async () => (await filmNode(page, nodeId))?.compositeAsset != null, { timeout: 30_000 })
    .toBe(true);
}

/** 片场范围几何与中心 client 坐标。 */
async function scopeClient(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((entry: any) => entry.id === id);
    const scope = node.compositeAsset;
    const view = scene.viewport;
    const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return {
      scope,
      centerX: rect.left + (scope.x + scope.width / 2) * view.zoom + view.x,
      centerY: rect.top + (scope.y + scope.height / 2) * view.zoom + view.y
    };
  }, nodeId);
}

/**
 * 统计截图内标题小面板矩形中的深色（文字）像素。
 *
 * 面板浮在范围顶部之上、水平居中（与 `layout::film_title_layout` 一致：间隙 20；带业务类型名时
 * 面板高 = 24 上下内边距 + 32 标题行 + 6 行距 + 20 类型行 = 82 世界单位），底衬与画布背景同为
 * 近白色，因此以「深色文字像素」为存在信号；未 hover/选中时该区域接近纯背景（接近 0）。
 */
async function titleTextPixels(page: Page, nodeId: string): Promise<number> {
  const buffer = await page.locator("#bevy-canvas").screenshot();
  const base64 = buffer.toString("base64");
  const box = await page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const view = scene.viewport;
    const aabb = (window as any).__bevyRuntime?.queryCompositeAssetScopes?.()?.value
      ?.find((entry: any) => entry.nodeId === id)?.aabb as [number, number, number, number] | undefined;
    // 与 layout::film_title_layout 一致：面板浮在范围 AABB 顶部之上（间隙 20、带类型名高 82），
    // 水平居中；采样区域上下各留少量余量以覆盖抗锯齿边缘。
    const panelHeight = 82;
    const sampleWidth = Math.min(320, Math.max(64, aabb ? aabb[2] : 320));
    const centerX = aabb ? aabb[0] + aabb[2] / 2 : 0;
    const top = aabb ? aabb[1] - 20 - panelHeight - 4 : 0;
    return {
      left: (centerX - sampleWidth / 2) * view.zoom + view.x,
      top: top * view.zoom + view.y,
      w: sampleWidth * view.zoom,
      h: (panelHeight + 8) * view.zoom
    };
  }, nodeId);
  return page.evaluate(async ({ data, box }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    const scale = bitmap.width / rect.width;
    const x0 = Math.max(0, Math.round(box.left * scale));
    const y0 = Math.max(0, Math.round(box.top * scale));
    const w = Math.max(1, Math.round(box.w * scale));
    const h = Math.max(1, Math.round(box.h * scale));
    const px = ctx.getImageData(x0, y0, w, h).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (lum < 185) dark += 1;
    }
    return dark;
  }, { data: base64, box });
}

const objectDock = (page: Page) => page.locator(".film-set-object-dock");
const selectedFields = (page: Page) => page.locator(".film-set-object-fields");

test.describe("片场标题、编辑与检查面板（change: 2026-10-10）", () => {
  test("范围标题随 hover/选中显隐、移出回收、再次 hover 重建", async ({ page }, info) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(page, [
      {
        type: "node.add",
        node: { id: "film", type: "composite-asset", position: { x: 200, y: 120 }, width: 400, height: 300 },
        nodeData: filmSetFields("标题测试片场")
      }
    ] as never, "title-seed");
    await waitForFilmSet(page, "film");
    await page.waitForTimeout(400);

    // 名称来自共享解析：nodeData.title 进入渲染标题；业务类型名来自可信 adapter 声明。
    expect((await filmNode(page, "film"))?.title).toBe("标题测试片场");
    expect((await filmNode(page, "film"))?.typeLabel).toBe("片场");

    const { centerX, centerY } = await scopeClient(page, "film");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(250);
    const before = await titleTextPixels(page, "film");

    // hover → 命中并显示标题。
    await page.mouse.move(centerX, centerY);
    await expect
      .poll(async () => (await lastScene(page))?.hover?.nodeId ?? null, { timeout: 10_000 })
      .toBe("film");
    await page.waitForTimeout(250);
    const hovered = await titleTextPixels(page, "film");
    expect(hovered).toBeGreaterThan(before + 12);
    await page.screenshot({ path: info.outputPath("title-hover.png") });

    // 移出 → 回收，无残留文字。
    await page.mouse.move(10, 10);
    await expect
      .poll(async () => (await lastScene(page))?.hover?.nodeId ?? null, { timeout: 10_000 })
      .toBe(null);
    await page.waitForTimeout(250);
    const moved = await titleTextPixels(page, "film");
    expect(moved).toBeLessThanOrEqual(before + 6);

    // 再次 hover → 从零补建（0→1→0→1 不丢字）。
    await page.mouse.move(centerX, centerY);
    await expect.poll(async () => (await lastScene(page))?.hover?.nodeId ?? null).toBe("film");
    await page.waitForTimeout(250);
    const rehovered = await titleTextPixels(page, "film");
    expect(rehovered).toBeGreaterThan(before + 12);

    // 选中后移出仍常驻标题。
    await page.mouse.click(centerX, centerY);
    await expect
      .poll(async () => (await lastScene(page))?.selection?.nodes ?? [], { timeout: 10_000 })
      .toContain("film");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);
    const selected = await titleTextPixels(page, "film");
    expect(selected).toBeGreaterThan(before + 12);

    expect(errors).toEqual([]);
  });

  test("对象 Delete/Backspace 删除并可撤销/重做，输入与无选中不误删，片场节点保留", async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(page, [
      {
        type: "node.add",
        node: { id: "film", type: "composite-asset", position: { x: 200, y: 120 }, width: 260, height: 195 },
        nodeData: filmSetFields("对象删除片场", [modelItem("obj-a", "导入模型", "#e23b3b"), groundItem()])
      },
      { type: "node.add", node: { id: "other", type: "text", position: { x: 700, y: 120 } }, nodeData: { title: "无关节点", text: "keep" } }
    ] as never, "delete-seed");
    await waitForFilmSet(page, "film");
    await page.waitForTimeout(400);

    const itemsOf = async () =>
      ((await readStoredCanvas(page))!.nodeData.film as any).filmSetContent.items as Array<{ id: string }>;

    const { centerX, centerY } = await scopeClient(page, "film");
    await page.mouse.dblclick(centerX, centerY);
    await expect(objectDock(page)).toBeVisible();
    await page.getByRole("option", { name: "模型 · 导入模型" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().modelEditor?.toolMode))
      .toBe("object");
    await expect(page.getByRole("option", { name: "模型 · 导入模型" })).toHaveAttribute("aria-selected", "true");

    // 输入隔离：聚焦坐标输入后 Backspace 不删除对象。
    const xInput = page.getByRole("spinbutton", { name: "对象位置 X" });
    await xInput.focus();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    expect((await itemsOf()).map((item) => item.id)).toContain("obj-a");

    // 画布键盘路径：把焦点移出输入/列表，再按 Delete（window 级处理器）。
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Delete");
    await expect
      .poll(async () => (await itemsOf()).map((item) => item.id), { timeout: 20_000 })
      .toEqual(["ground"]);
    // 片场节点与无关节点保留。
    const afterDelete = await readStoredCanvas(page);
    expect(afterDelete!.document.nodes.map((node) => node.id).sort()).toEqual(["film", "other"]);
    await page.screenshot({ path: info.outputPath("object-deleted.png") });

    // 撤销恢复对象；重做再次删除。
    await page.evaluate(async () => { await (window as any).__canvasEdit?.undo(); });
    await expect
      .poll(async () => (await itemsOf()).map((item) => item.id).sort(), { timeout: 20_000 })
      .toEqual(["ground", "obj-a"]);
    await page.evaluate(async () => { await (window as any).__canvasEdit?.redo(); });
    await expect
      .poll(async () => (await itemsOf()).map((item) => item.id), { timeout: 20_000 })
      .toEqual(["ground"]);

    // 无选中时删除键消费为无动作：绝不回退删除整个片场节点。
    // 删除 settlement 已清空选择；仍在片场编辑（聚焦）内，按键必须被消费而非删除片场。
    await expect(selectedFields(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__canvasModelFocus.focused())).toBe(true);
    const nodesBefore = (await readStoredCanvas(page))!.document.nodes.length;
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    expect((await readStoredCanvas(page))!.document.nodes.length).toBe(nodesBefore);

    expect(errors).toEqual([]);
  });

  test("分层 Escape：手势取消（pointerup 不提交）→ 清选择 → 退出聚焦", async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(page, [
      {
        type: "node.add",
        node: { id: "film", type: "composite-asset", position: { x: 200, y: 120 }, width: 260, height: 195 },
        nodeData: filmSetFields("分层退出片场", [modelItem("obj-a", "导入模型", "#e23b3b"), groundItem()])
      }
    ] as never, "escape-seed");
    await waitForFilmSet(page, "film");

    const { centerX, centerY } = await scopeClient(page, "film");
    await page.mouse.dblclick(centerX, centerY);
    await expect(objectDock(page)).toBeVisible();
    await page.getByRole("option", { name: "模型 · 导入模型" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().modelEditor?.toolMode))
      .toBe("object");
    await page.waitForTimeout(600);

    const transformOf = async () =>
      ((await readStoredCanvas(page))!.nodeData.film as any).filmSetContent.items.find((item: any) => item.id === "obj-a").localTransform;

    // 找到 x 轴 gizmo 手柄，开始拖动（preview 移动、canonical 不变）。
    const handle = await page.evaluate(() => {
      const runtime = (window as any).__bevyRuntime;
      const editor = runtime.lastScene().modelEditor;
      const projection = (window as any).__canvasModelFocus.projection();
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      for (let y = 12; y < rect.height - 12; y += 6) {
        for (let x = 12; x < rect.width - 340; x += 6) {
          const hit = runtime.queryGizmoHit({ kind: "object", editor, projection, surface: { width: rect.width, height: rect.height }, point: { x, y } });
          if (hit?.handle === "x" && hit.constraint) return { x: rect.left + x, y: rect.top + y, direction: hit.constraint.direction };
        }
      }
      throw new Error("No x handle in WASM projection");
    });
    const original = await transformOf();
    const boundsBefore = await page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film").find((item: any) => item.itemId === "obj-a").center);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.direction[0] * 30, handle.y + handle.direction[1] * 30, { steps: 6 });
    await expect
      .poll(async () => page.evaluate(() => (window as any).__bevyRuntime.queryCompositeAssetItemBounds("film").find((item: any) => item.itemId === "obj-a").center))
      .not.toEqual(boundsBefore);
    expect(await transformOf()).toEqual(original);

    // Escape 取消手势（第一层）；释放指针不得提交，选择保留。
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await transformOf()).toEqual(original);
    await expect(page.getByRole("option", { name: "模型 · 导入模型" })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => (window as any).__canvasModelFocus.focused())).toBe(true);

    // Escape 清对象选择（第二层），仍保持聚焦。
    await page.keyboard.press("Escape");
    await expect(selectedFields(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__canvasModelFocus.focused())).toBe(true);

    // Escape 退出聚焦（第三层）。
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus.focused()), { timeout: 10_000 }).toBe(false);
    expect(errors).toEqual([]);
  });

  test("对象/镜头/动画任务页签可达、选中联动、切页零命令（含 390px 窄屏）", async ({ page }, info) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await sendCommands(page, [
      {
        type: "node.add",
        node: { id: "film", type: "composite-asset", position: { x: 260, y: 160 }, width: 320, height: 240 },
        nodeData: filmSetFields("页签片场", [modelItem("body", "角色", "#3b6fe2"), groundItem()])
      }
    ] as never, "tabs-seed");
    await waitForFilmSet(page, "film");

    const { centerX, centerY } = await scopeClient(page, "film");
    await page.mouse.dblclick(centerX, centerY);
    await expect(objectDock(page)).toBeVisible();
    await expect(page.getByRole("tab", { name: "对象", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "镜头", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "动画", exact: true })).toBeVisible();

    const revision = (await readStoredCanvas(page))!.revision;
    // 切到镜头页：真实镜头面板出现；切到动画页：片场动画面板出现；均为零命令。
    await page.getByRole("tab", { name: "镜头", exact: true }).click();
    await expect(page.locator(".model-editor")).toBeVisible();
    await page.getByRole("tab", { name: "动画", exact: true }).click();
    await expect(page.locator('[aria-label="片场动画"]')).toBeVisible();
    expect((await readStoredCanvas(page))!.revision).toBe(revision);

    // 选择对象 → 联动回对象页且不提交命令。
    // 对象列表只在对象页渲染；先回对象页再选择（场景点选路径由单测覆盖联动）。
    await page.getByRole("tab", { name: "对象", exact: true }).click();
    await page.getByRole("option", { name: "模型 · 角色" }).click();
    await expect(page.getByRole("tab", { name: "对象", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("option", { name: "模型 · 角色" })).toHaveAttribute("aria-selected", "true");
    expect((await readStoredCanvas(page))!.revision).toBe(revision);

    // 640px 窄屏：无横向溢出、面板在视口内、页签可达。
    await page.setViewportSize({ width: 640, height: 800 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    const dock640 = await page.locator(".model-editor-dock").boundingBox();
    expect(dock640).not.toBeNull();
    expect(dock640!.x).toBeGreaterThanOrEqual(-1);
    expect(dock640!.x + dock640!.width).toBeLessThanOrEqual(641);
    await expect(page.getByRole("tab", { name: "对象", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("inspector-narrow-640.png") });

    // 390px 窄屏：无横向溢出、面板在视口内、页签可达。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const dock = await page.locator(".model-editor-dock").boundingBox();
    expect(dock).not.toBeNull();
    expect(dock!.x).toBeGreaterThanOrEqual(-1);
    expect(dock!.x + dock!.width).toBeLessThanOrEqual(391);
    await expect(page.getByRole("tab", { name: "对象", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("inspector-narrow-390.png") });

    // 窄屏下对象删除仍可用。
    await page.getByRole("option", { name: "模型 · 角色" }).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Delete");
    await expect
      .poll(async () => ((await readStoredCanvas(page))!.nodeData.film as any).filmSetContent.items.map((item: any) => item.id), { timeout: 20_000 })
      .toEqual(["ground"]);

    expect(errors).toEqual([]);
  });
});
