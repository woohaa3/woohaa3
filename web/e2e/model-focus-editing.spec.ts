/**
 * 当前模型聚焦交互的浏览器回归（replace-model-node-focus-interactions）。
 * 本体拖动及 Shift 拖动不写 placement；gizmo 编辑由 model-editor-gizmo 覆盖。
 * 这里保留规范 placement patch、只读/pointercancel、连续手势与退出的像素检查。
 */
import { defaultSelfContained3DNodeData } from "@woohaa3/contracts";
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import {
  canvasRevision,
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  waitForCanvasSession
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

/** 标准 V2 人形 fixture（与 model-scene-v2 / focus-viewing 同源）。 */
const HUMANOID_V2 = `
const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
scene.box({ id: "torso", size: [0.9, 1.6, 0.5], position: [0, 1.9, 0], material: armor });
scene.sphere({ id: "head", radius: 0.34, position: [0, 3.05, 0], color: "#e8c39e" });
scene.segment({ id: "left-leg", from: [-0.25, 1.1, 0], to: [-0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
scene.segment({ id: "right-leg", from: [0.25, 1.1, 0], to: [0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
`;

async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, requestId: crypto.randomUUID(), source, version: "woohaa-model-js-v2" }
  });
  expect(response.ok(), `submit_model_script 失败：${response.status()}`).toBe(true);
}

/**
 * 通过浏览器命令出口创建一个 generate 节点，并等待 canonical 出现（不依赖 pending 结算，
 * 避免共享 E2E server 冷启动抖动）。
 */
async function createNode(page: Page, nodeId: string, position: { x: number; y: number }, nodeData?: unknown): Promise<void> {
  await page.evaluate(
    ({ id, pos, data }) => {
      const submit = (window as unknown as {
        __canvasSubmitCommands?: (commands: unknown[], commandId?: string) => unknown;
      }).__canvasSubmitCommands;
      if (!submit) throw new Error("__canvasSubmitCommands 未安装");
      submit(
        [{
          type: "node.add",
          node: { id, type: "composite-asset", position: pos },
          ...(data ? { nodeData: data } : {})
        }],
        `e2e-create-${id}`
      );
    },
    { id: nodeId, pos: position, data: { ...defaultSelfContained3DNodeData("composite-asset"), ...(nodeData as object ?? {}) } }
  );
  await page.waitForFunction(
    (id) => (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string }> } } }).__canvasCanonical?.document?.nodes?.some((node) => node.id === id) === true,
    nodeId,
    { timeout: 30_000, polling: 100 }
  );
}

async function waitForModelRendered(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const canonical = (window as unknown as {
        __canvasCanonical?: { nodeData?: Record<string, { modelScriptVersion?: string; modelScriptStatus?: string }> };
      }).__canvasCanonical;
      const data = canonical?.nodeData?.[id];
      return data?.modelScriptVersion === "woohaa-model-js-v2" && data.modelScriptStatus === "ok";
    },
    nodeId,
    { timeout: 30_000, polling: 200 }
  );
  await page.waitForTimeout(800);
}

/** 聚焦后复合资产（片场）范围的 client 中心坐标（共享世界模型没有卡片）。 */
async function focusPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const canonical = (window as unknown as {
      __canvasCanonical?: { document?: { nodes?: Array<{ id: string; type?: string; position: { x: number; y: number }; width?: number; height?: number }> } };
    }).__canvasCanonical;
    const node = canonical?.document?.nodes?.find((entry) => entry.id === id);
    if (!node) throw new Error("node not found");
    const viewport = (window as unknown as { __canvasViewport?: () => { x: number; y: number; zoom: number } }).__canvasViewport?.() ?? { x: 0, y: 0, zoom: 1 };
    const rect = (document.querySelector("#bevy-canvas") as HTMLCanvasElement).getBoundingClientRect();
    const legacyDefault = node.type === "composite-asset" && node.width === 260 && node.height === 195;
    const cardWidth = legacyDefault ? 196 : (node.width ?? 196);
    const cardHeight = legacyDefault ? 64 : (node.height ?? 64);
    const worldX = (node.position.x + cardWidth / 2) * viewport.zoom + viewport.x;
    const worldY = (node.position.y + cardHeight + 90) * viewport.zoom + viewport.y;
    return { x: worldX + rect.left, y: worldY + rect.top };
  }, nodeId);
}

async function focusState(page: Page) {
  return page.evaluate(() => {
    const mirror = (window as unknown as {
      __canvasModelFocus?: { focused?: () => boolean; nodeId?: () => string | null };
    }).__canvasModelFocus;
    return { focused: mirror?.focused?.() ?? false, nodeId: mirror?.nodeId?.() ?? null };
  });
}

async function placementPreview(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const mirror = (window as unknown as {
      __canvasModelPlacement?: { preview?: (nodeId: string) => unknown };
    }).__canvasModelPlacement;
    return mirror?.preview?.(id) ?? null;
  }, nodeId);
}

async function editable(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __canvasModelFocusEdit?: { editable?: () => boolean } }).__canvasModelFocusEdit?.editable?.() ?? false
  );
}

/** 读当前规范 placement。 */
async function canonicalPlacement(page: Page, nodeId: string) {
  const canvas = await readStoredCanvas(page);
  const nodeData = canvas?.nodeData as Record<string, { modelPlacement?: unknown }> | undefined;
  return nodeData?.[nodeId]?.modelPlacement ?? null;
}

/** 最近一次本地拒绝（诊断用）。 */
async function lastRejection(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __canvasStoreState?: () => { lastRejection?: unknown } }).__canvasStoreState?.()?.lastRejection ?? null
  );
}

/**
 * 等待 placement patch 落定：规范 placement 满足断言谓词，或出现拒绝。
 *
 * 比 `pendingCount === 0` 更贴近本能力的目标状态：blocked 批次会永久留在 pending，
 * 因此这里以「规范 placement 已更新 / 明确拒绝」为终止条件。
 */
async function waitForPlacement(
  page: Page,
  nodeId: string,
  predicate: (placement: unknown) => boolean,
  timeout = 20_000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const rejection = await lastRejection(page);
    if (rejection) throw new Error(`placement patch 被拒绝：${JSON.stringify(rejection)}`);
    const placement = await canonicalPlacement(page, nodeId);
    if (predicate(placement)) return;
    if (Date.now() - start > timeout) throw new Error(`等待 placement 超时：${JSON.stringify(placement)}`);
    await page.waitForTimeout(120);
  }
}

/** 前景像素统计（非中性色）与包围盒。 */
async function foreground(page: Page) {
  const buffer = await page.locator("#bevy-canvas").screenshot();
  const base64 = buffer.toString("base64");
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    let minX = bitmap.width, maxX = -1, minY = bitmap.height, maxY = -1;
    for (let y = 0; y < bitmap.height; y += 2) {
      for (let x = 0; x < bitmap.width; x += 2) {
        const i = (y * bitmap.width + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn > 40 && mx > 60) {
          count += 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { w: bitmap.width, h: bitmap.height, count, box: count ? { minX, minY, maxX, maxY } : null };
  }, base64);
}

async function enterFocus(page: Page, nodeId: string): Promise<void> {
  const point = await focusPoint(page, nodeId);
  await page.mouse.move(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(async () => (await focusState(page)).focused, { timeout: 15_000 }).toBe(true);
}

test.describe("聚焦模型 placement 编辑（change: add-model-focus-editing）", () => {
  test("主按钮拖动模型本体不写 placement 或节点位置", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, "edit-offset", { x: 520, y: 200 });
    await submitModelScript(page, "edit-offset", HUMANOID_V2);
    await waitForModelRendered(page, "edit-offset");
    await enterFocus(page, "edit-offset");

    const before = await readStoredCanvas(page);
    const point = await focusPoint(page, "edit-offset");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 160, point.y + 40, { steps: 6 });
    expect(await placementPreview(page, "edit-offset")).toBeNull();
    await page.mouse.up();
    const after = await readStoredCanvas(page);
    expect(after).toEqual(before);
    expect((await focusState(page)).focused).toBe(true);
    expect((await foreground(page)).count).toBeGreaterThan(300);
  });

  test("Shift 拖动模型本体不改规范 placement", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, "edit-yaw", { x: 520, y: 200 });
    await submitModelScript(page, "edit-yaw", HUMANOID_V2);
    await waitForModelRendered(page, "edit-yaw");
    await enterFocus(page, "edit-yaw");

    const before = await canonicalPlacement(page, "edit-yaw");
    const revision = await canvasRevision(page);
    const point = await focusPoint(page, "edit-yaw");
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(point.x + 120, point.y + 80, { steps: 6 });
    expect(await placementPreview(page, "edit-yaw")).toBeNull();
    await page.mouse.up();
    await page.keyboard.up("Shift");
    expect(await canonicalPlacement(page, "edit-yaw")).toEqual(before);
    expect(await canvasRevision(page)).toBe(revision);
  });

  test("规范 placement patch 只归零 offset，保留 scale/yaw", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(
      page,
      "edit-dom",
      { x: 460, y: 180 },
      // 旧越界 scale 仍可读（不自动迁移）。
      { modelPlacement: { offset: { x: 2, y: 1, z: 0 }, scale: 9, yaw: 30 } }
    );
    await submitModelScript(page, "edit-dom", HUMANOID_V2);
    await waitForModelRendered(page, "edit-dom");

    // 通过 E2E 出口直接提交「重置模型位置」等价命令，验证只归零 offset。
    await page.evaluate(() => {
      (window as unknown as { __canvasSubmitCommands?: (commands: unknown[], id?: string) => unknown }).__canvasSubmitCommands?.(
        [{ type: "nodeData.patch", nodeId: "edit-dom", value: { modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 9, yaw: 30 } } }],
        "e2e-reset-offset"
      );
    });
    await waitForPlacement(page, "edit-dom", (placement) => {
      const offset = (placement as { offset?: { x: number; y: number; z: number } } | null)?.offset;
      return offset?.x === 0 && offset?.y === 0 && offset?.z === 0;
    });
    const placed = await canonicalPlacement(page, "edit-dom") as { offset: { x: number; y: number; z: number }; scale: number; yaw: number };
    expect(placed.offset).toEqual({ x: 0, y: 0, z: 0 });
    // scale/yaw 原样保留。
    expect(placed.scale).toBeCloseTo(9, 4);
    expect(placed.yaw).toBeCloseTo(30, 4);
  });

  test("只读会话允许聚焦查看但禁用编辑；pointercancel 不提交", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, "edit-ro", { x: 400, y: 160 });
    await submitModelScript(page, "edit-ro", HUMANOID_V2);
    await waitForModelRendered(page, "edit-ro");
    await enterFocus(page, "edit-ro");

    const point = await focusPoint(page, "edit-ro");
    // 可写：编辑可用；pointercancel 取消不提交。
    const before = await canonicalPlacement(page, "edit-ro");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 120, point.y, { steps: 4 });
    await page.evaluate(() => {
      const canvas = document.querySelector("#bevy-canvas");
      canvas?.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
    });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await canonicalPlacement(page, "edit-ro");
    // 取消未产生净变化提交。
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // 断网 → 只读：相机仍可退出/查看，但编辑门禁关闭。
    await page.context().setOffline(true);
    await page.waitForTimeout(400);
    expect(await editable(page)).toBe(false);
    // 拖动不再改变权威 placement。
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 120, point.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const offlinePlacement = await canonicalPlacement(page, "edit-ro");
    expect(JSON.stringify(offlinePlacement)).toBe(JSON.stringify(before));
    // 聚焦视图仍在。
    expect((await focusState(page)).focused).toBe(true);
    await page.context().setOffline(false);
  });

  test("连续本体拖动不写规范状态，聚焦与退出画面保持非空", async ({ page }) => {
    // SwiftShader 每次 move/截图等待真实帧，保留完整 40 步手势。
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    await createNode(page, "edit-stress", { x: 520, y: 220 });
    await submitModelScript(page, "edit-stress", HUMANOID_V2);
    await waitForModelRendered(page, "edit-stress");
    await enterFocus(page, "edit-stress");

    // 单次连续手势内含大量高频 move（每步更新 ModelRoot transform / preview，不重建内容）。
    const point = await focusPoint(page, "edit-stress");
    const before = await canvasRevision(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    for (let step = 1; step <= 40; step += 1) {
      await page.mouse.move(point.x + step * 3, point.y + step, { steps: 1 });
    }
    expect(await placementPreview(page, "edit-stress")).toBeNull();
    // 高频预览期间画面持续非空（无资源增长导致的空白/崩溃）。
    const midStats = await foreground(page);
    expect(midStats.count).toBeGreaterThan(300);
    await page.mouse.up();

    const after = await canvasRevision(page);
    // 一次连续手势只提交一次 placement patch。
    expect(after).toBe(before);

    // 权威回流后画面仍非空（模型未闪回、未消失）。
    await expect.poll(async () => (await placementPreview(page, "edit-stress")) === null, { timeout: 6_000 }).toBe(true);
    const stats = await foreground(page);
    expect(stats.count).toBeGreaterThan(300);

    // 退出聚焦 → 普通画布仍渲染该模型（位置连续，不消失）。
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await focusState(page)).focused, { timeout: 10_000 }).toBe(false);
    await page.waitForTimeout(500);
    const canvasStats = await foreground(page);
    expect(canvasStats.count).toBeGreaterThan(200);
    expect(errors.filter((message) => /NaN|panic|RuntimeError/i.test(message))).toEqual([]);
  });
});

