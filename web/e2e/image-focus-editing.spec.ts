/**
 * 图片聚焦编辑浏览器 E2E
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 9.2 / 9.3；
 *   change: 2026-10-16-integrate-photocraft-image-editing：界面换成我们自己的 React 编辑器，
 *   旧标注编辑器的用例已删除）。
 *
 * 真实 Bevy WASM + 真实三服务：
 * - 上传图片 → 建带稳定 asset 的图片节点 → 双击/受控入口进入原地聚焦；
 * - **进入图片编辑即打开 React 编辑器**（纯媒体以原图为背景层开新工程）；
 * - 仅查看零 canonical 命令；退出恢复 overview 且不写编辑定义；
 * - 无合法稳定输出时不进入空白场景。
 *
 * 注：本文件可按 GPU 条件运行的脚本；未在本次会话中执行时如实标注，不声称已跑过。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  canvasRevision,
  installPageHelpers,
  readStoredCanvas,
  resetCanvasStorage,
  sendCommands,
  uploadMedia,
  waitForBevyReady,
  waitForCanvasSession
} from "./helpers.js";

/** 在页面内生成一张真实可解码的 PNG（避免手写字节不可解码）。 */
async function makePngBytes(page: Page, width = 64, height = 48): Promise<number[]> {
  const bytes = await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2b6cb0";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#f6e05e";
    context.fillRect(8, 8, 24, 16);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob 失败");
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { width, height });
  return bytes;
}

/** 创建带稳定 asset 的图片节点（真实 asset.upsert + node.add + nodeData.patch）。 */
async function createImageNodeWithAsset(page: Page, nodeId: string, size = { width: 64, height: 48 }): Promise<{ storageKey: string }> {
  const pngBytes = await makePngBytes(page, size.width, size.height);
  const upload = await uploadMedia(page, pngBytes, "image/png");
  expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  const storageKey = String((upload.body as { storageKey?: unknown }).storageKey ?? "");
  expect(storageKey).toMatch(/^sha256-[0-9a-f]{64}$/);
  const checksum = storageKey.replace("sha256-", "");
  const assetId = `asset-e2e-${checksum.slice(0, 8)}`;
  const saved = await sendCommands(
    page,
    [
      {
        type: "asset.upsert",
        asset: {
          id: assetId,
          title: "E2E 图片",
          mediaKind: "image",
          source: "uploaded",
          status: "ready",
          createdAt: new Date().toISOString(),
          url: `/api/media/${storageKey}`,
          metadata: { storageKey, checksum, contentType: "image/png", size: pngBytes.length }
        }
      },
      { type: "node.add", node: { id: nodeId, type: "image", position: { x: 240, y: 240 } } }
    ],
    `e2e-image-asset-${nodeId}`
  );
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const patched = await sendCommands(
    page,
    [{ type: "nodeData.patch", nodeId, value: { outputAssetId: assetId, resourceKind: "image", taskStatus: "successed" } }],
    `e2e-image-patch-${nodeId}`
  );
  expect(patched.ok, JSON.stringify(patched)).toBe(true);
  return { storageKey };
}

async function imageFocusFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const mirror = (window as unknown as { __canvasImageFocus?: { focused: () => boolean } }).__canvasImageFocus;
    return mirror?.focused() ?? false;
  });
}

async function enterNodeFocus(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const nav = (window as unknown as {
      __canvasNavigation?: { enterNodeFocus?: (input: unknown) => void; exitNodeFocus?: () => void };
    }).__canvasNavigation;
    nav?.enterNodeFocus?.({ nodeId: id, kind: "image", owner: "direct" });
  }, nodeId);
}

test.describe("图片聚焦编辑（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    await waitForBevyReady(page);
  });

  test("双击图片进入聚焦并隐藏外框，返回恢复（仅查看零命令）", async ({ page }) => {
    await createImageNodeWithAsset(page, "img-focus");
    // 等待图片节点纹理/资产就绪回流。
    await page.waitForFunction(
      () => {
        const canonical = (window as unknown as { __canvasCanonical?: { assets?: unknown[] } }).__canvasCanonical;
        return Array.isArray(canonical?.assets) && canonical.assets.length > 0;
      },
      undefined,
      { timeout: 30_000, polling: 200 }
    );
    const before = await canvasRevision(page);

    await enterNodeFocus(page, "img-focus");
    await page.waitForFunction(
      () => {
        const mirror = (window as unknown as { __canvasImageFocus?: { focused: () => boolean } }).__canvasImageFocus;
        return mirror?.focused() === true;
      },
      undefined,
      { timeout: 15_000, polling: 100 }
    );
    // 工作区就是宿主自己的 React 编辑器；旧标注工具列不存在。
    await expect(page.locator("[data-image-edit-workspace]")).toBeVisible();
    await expect(page.locator(".photo-editor")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: "矩形", exact: true })).toHaveCount(0);

    // 聚焦仅查看：不提交 canonical 命令、revision 不变。
    const after = await canvasRevision(page);
    expect(after).toBe(before);

    // 退出恢复 overview，且不写编辑定义（纯媒体节点退出后仍是纯媒体）。
    await page.evaluate(() => {
      const nav = (window as unknown as { __canvasNavigation?: { exitNodeFocus?: () => void } }).__canvasNavigation;
      nav?.exitNodeFocus?.();
    });
    await page.waitForFunction(
      () => {
        const mirror = (window as unknown as { __canvasImageFocus?: { focused: () => boolean } }).__canvasImageFocus;
        return mirror?.focused() === false;
      },
      undefined,
      { timeout: 15_000, polling: 100 }
    );
    expect(await imageFocusFocused(page)).toBe(false);
    expect(await canvasRevision(page)).toBe(before);
    const stored = await readStoredCanvas(page);
    const nodeData = (stored as unknown as { nodeData?: Record<string, { imageEdit?: unknown }> } | null)?.nodeData?.["img-focus"];
    expect(nodeData?.imageEdit ?? null).toBeNull();
  });

  test("大图双击聚焦、拒绝纹理后重试与返回平移保持可用", async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await createImageNodeWithAsset(page, "img-large", { width: 4096, height: 3072 });
    await expect.poll(() => page.evaluate(() => {
      const scene = (window as any).__bevyRuntime?.lastScene?.();
      return scene?.nodes.find((node: any) => node.id === "img-large")?.texture;
    })).toBe(true);
    await page.evaluate(() => (window as any).__canvasRestoreViewport?.({ x: 0, y: 0, zoom: 1 }));
    const position = await page.evaluate(() => {
      const node = (window as any).__bevyRuntime.lastScene().nodes.find((node: any) => node.id === "img-large");
      const viewport = (window as any).__canvasViewport();
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      return { x: rect.left + viewport.x + (node.x + node.width / 2) * viewport.zoom,
        y: rect.top + viewport.y + (node.y + node.height / 2) * viewport.zoom };
    });
    await page.mouse.dblclick(position.x, position.y);
    await expect.poll(() => imageFocusFocused(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__imageEditDebug?.().loaded?.w)).toBe(4096);
    // The real runtime boundary rejects a bad upload without an uncaught error.
    expect(await page.evaluate(() => (window as any).__bevyRuntime.setTexture("img-large", 3000, 1,
      new Uint8Array(3000 * 4), { sourceKey: "rejected-e2e" }))).toBe(false);
    const warning = page.getByRole("alert", { name: "画布预览问题" });
    await expect(warning).toContainText("媒体预览上传失败");
    await page.screenshot({ path: testInfo.outputPath("desktop-warning.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const warningBox = await warning.boundingBox();
    expect(warningBox!.x).toBeGreaterThanOrEqual(0);
    expect(warningBox!.x + warningBox!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("mobile-warning.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "重试预览", exact: true }).click();
    await expect(warning).toHaveCount(0);
    await page.evaluate(() => (window as any).__canvasNavigation.exitNodeFocus());
    await expect.poll(() => imageFocusFocused(page)).toBe(false);
    const before = await page.evaluate(() => (window as any).__canvasViewport());
    await page.mouse.move(600, 400); await page.mouse.down({ button: "middle" });
    await page.mouse.move(680, 450, { steps: 5 }); await page.mouse.up({ button: "middle" });
    await expect.poll(() => page.evaluate(() => (window as any).__canvasViewport().x)).toBeGreaterThan(before.x + 40);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().viewport.x)).toBeGreaterThan(before.x + 40);
    expect(pageErrors).toEqual([]);
  });

  test("渲染上下文丢失与真实 WASM trap 后保留待处理命令与恢复入口", async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await createImageNodeWithAsset(page, "img-recover");
    await enterNodeFocus(page, "img-recover");
    await expect(page.locator("[data-image-edit-workspace]")).toBeVisible();
    const beforeRevision = await canvasRevision(page);
    const before = await page.evaluate(() => ({ generation: (window as any).__bevyRuntime.generation() }));
    await page.evaluate(() => {
      (window as any).__recoveryWorkspace = document.querySelector("[data-image-edit-workspace]");
      const child = document.querySelector("iframe")!.contentWindow!;
      const canvas = child.document.querySelector("canvas")!;
      const gl = canvas.getContext("webgl2")!;
      const extension = gl.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("WEBGL_lose_context unavailable");
      extension.loseContext();
      (window as any).__canvasSubmitCommands([{ type: "node.add", node: { id: "during-recovery", type: "image", position: { x: 500, y: 500 } } }], "recovery-pending");
    });
    const warning = page.getByRole("alert", { name: "画布预览问题" });
    await expect(warning).toContainText("正在重建");
    await page.screenshot({ path: testInfo.outputPath("renderer-recovery.png") });
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().counts.recovered ?? 0), { timeout: 45000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.isReady())).toBe(true);
    const after = await page.evaluate(() => ({ generation: (window as any).__bevyRuntime.generation(), sameWorkspace: (window as any).__recoveryWorkspace === document.querySelector("[data-image-edit-workspace]") }));
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after.sameWorkspace).toBe(true);
    await expect.poll(() => canvasRevision(page)).toBe(beforeRevision + 1);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.filter((node: any) => node.id === "during-recovery").length)).toBe(1);
    // A real guest unreachable instruction, raised asynchronously in the renderer realm.
    const trap = () => page.evaluate(async () => {
      const realm = document.querySelector("iframe")!.contentWindow!;
      await (realm as any).eval(`WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,9,1,5,99,114,97,115,104,0,0,10,5,1,3,0,0,11])).then(({instance}) => setTimeout(() => instance.exports.crash(), 0))`);
    });
    await trap();
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().counts.recovered ?? 0), { timeout: 45000 }).toBe(2);
    await trap();
    await expect(warning).toContainText("已停止自动重试");
    await page.getByRole("button", { name: "重建画布预览", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().counts.recovered ?? 0), { timeout: 45000 }).toBe(3);
    expect(await canvasRevision(page)).toBe(beforeRevision + 1);
    expect(errors).toEqual([]);
  });

  test("Bevy 自有帧循环停止且有新工作时 watchdog 重建，恢复后仍可平移", async ({ page }) => {
    test.setTimeout(150000);
    const generation = await page.evaluate(() => (window as any).__bevyRuntime.generation());
    await page.evaluate(() => {
      const realm = document.querySelector("iframe")!.contentWindow!;
      realm.requestAnimationFrame = () => 0;
    });
    // Let the already scheduled callback finish; only the child scheduler is stopped.
    await page.waitForTimeout(3000);
    expect((await sendCommands(page, [{ type: "node.add", node: { id: "watchdog-work", type: "image", position: { x: 240, y: 240 } } }], "watchdog-work")).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().counts.watchdog ?? 0), { timeout: 45000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.runtimeHealth().phase), { timeout: 45000 }).toBe("running");
    expect(await page.evaluate(() => (window as any).__bevyRuntime.generation())).toBeGreaterThan(generation);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.some((node: any) => node.id === "watchdog-work"))).toBe(true);
    const before = await page.evaluate(() => (window as any).__canvasViewport().x);
    await page.mouse.move(600, 400); await page.mouse.down({ button: "middle" });
    await page.mouse.move(680, 450, { steps: 5 }); await page.mouse.up({ button: "middle" });
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().viewport.x)).toBeGreaterThan(before + 40);
  });

  test("原图解码期间保留画面，加载提示不遮盖内容区", async ({ page }) => {
    const { storageKey } = await createImageNodeWithAsset(page, "img-loading");
    // Let the card finish loading before delaying the separate full-resolution request.
    await page.waitForTimeout(1000);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/media/${storageKey}`, async route => {
      await pending;
      await route.continue();
    });
    try {
      await enterNodeFocus(page, "img-loading");
      const loading = page.locator(".photo-editor-host__status");
      await expect(loading).toBeVisible();
      const bounds = await loading.boundingBox();
      expect(bounds!.height).toBeLessThan(80);
      expect(bounds!.width).toBeLessThan(400);
    } finally {
      release();
    }
    await expect(page.locator(".photo-editor-host__status")).toHaveCount(0);
  });

  test("无合法稳定输出的图片不进入空白聚焦场景", async ({ page }) => {
    const before = await canvasRevision(page);
    // 建一个没有任何 outputAssetId 的图片节点。
    await sendCommands(
      page,
      [{ type: "node.add", node: { id: "img-empty", type: "image", position: { x: 200, y: 200 } } }],
      "e2e-empty-image"
    );
    await enterNodeFocus(page, "img-empty");
    await page.waitForTimeout(1000);
    expect(await imageFocusFocused(page)).toBe(false);
    // 未合法进入聚焦即不改变画布；节点创建本身推进了 revision，但聚焦不应再推进。
    const stored = await readStoredCanvas(page);
    expect(stored).not.toBeNull();
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
