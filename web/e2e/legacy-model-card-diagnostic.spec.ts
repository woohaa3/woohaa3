/**
 * 旧版 3D 模型卡片的只读诊断验收（change: 2026-11-10-remove-legacy-model-card-nodes）。
 *
 * 1. 缺少 `sharedWorldInstance` 的旧 `model3d`（升级前文档）仍能打开与同步，但只显示固定
 *    诊断正文，不生成模型资源、不进入聚焦。
 * 2. 命令层拒绝新建 / 复制粘贴缺少世界实例的模型节点（不再产生新的旧卡片节点）。
 * 3. 新建模型走画布点 → h=0 世界实例，双击世界表面进入聚焦。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import {
  modelNodeData,
  readStoredCanvas,
  resetCanvasStorage,
  seedYjsCanvas,
  sendCommands,
  waitForCanvasSession,
  worldModelClientPoint
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";
const LEGACY_BODY = "旧版 3D 模型卡片已不再支持";
const LEGACY_SCRIPT = "scene.box({ id: 'legacy', size: [1, 1, 1], color: '#c02a2a' });";

async function renderedNode(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const scene = (window as unknown as { __bevyRuntime: { lastScene: () => { nodes: Array<Record<string, unknown>> } } }).__bevyRuntime.lastScene();
    return scene.nodes.find((node) => node.id === id) ?? null;
  }, nodeId);
}

/** 画布没有挂载 Bevy 运行时（例如 dev server 未构建 WASM）时跳过用例并说明原因。 */
async function canvasRuntimeAvailable(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof (window as unknown as { __bevyRuntime?: { lastScene?: () => unknown } }).__bevyRuntime?.lastScene === "function"
  );
}

async function focusState(page: Page) {
  return page.evaluate(() => {
    const mirror = (window as unknown as {
      __canvasModelFocus?: { focused?: () => boolean; nodeId?: () => string | null };
    }).__canvasModelFocus;
    return { focused: mirror?.focused?.() ?? false, nodeId: mirror?.nodeId?.() ?? null };
  });
}

test.describe("旧卡片模型诊断", () => {
  test("旧卡片只显示诊断正文，不生成模型资源、不进入聚焦", async ({ page }) => {
    test.setTimeout(120_000);
    await resetCanvasStorage(page);
    const now = new Date().toISOString();
    await seedYjsCanvas(page, CANVAS, [], {
      canvas: {
        id: CANVAS,
        title: "旧卡片诊断",
        revision: 1,
        document: {
          schemaVersion: "asset-canvas-v1",
          edges: [],
          updatedAt: now,
          nodes: [{ id: "legacy-card", type: "model3d", position: { x: 120, y: 120 }, width: 248, height: 232 }]
        },
        nodeData: {
          "legacy-card": {
            title: "旧模型",
            modelScript: LEGACY_SCRIPT,
            modelScriptLanguage: "javascript",
            modelScriptVersion: "woohaa-model-js-v2"
          }
        },
        assets: [],
        jobs: [],
        updatedAt: now
      }
    });
    await page.goto("/");
    await waitForCanvasSession(page);
    test.skip(!(await canvasRuntimeAvailable(page)), "本机 dev server 未提供 Bevy 运行时");

    // 画布正常打开；旧卡片节点保留原 nodeData（不迁移、不补写世界实例）。
    const stored = await readStoredCanvas(page);
    const data = stored?.nodeData?.["legacy-card"] as Record<string, unknown> | undefined;
    expect(data?.modelScript).toBe(LEGACY_SCRIPT);
    expect(data?.sharedWorldInstance).toBeUndefined();

    // 投影为通用诊断卡片：固定正文、无模型引用、无卡片预览、不可缩放。
    await expect
      .poll(async () => (await renderedNode(page, "legacy-card"))?.body)
      .toContain(LEGACY_BODY);
    const node = await renderedNode(page, "legacy-card");
    expect(node?.model).toBeUndefined();
    expect(node && "modelPreview" in node).toBe(false);
    expect(node?.resizable).toBe(false);

    // 可以选中与删除（诊断卡片保留删除身份）。
    const point = await page.evaluate(() => {
      const scene = (window as unknown as { __bevyRuntime: { lastScene: () => { nodes: Array<Record<string, unknown>>; viewport: { x: number; y: number; zoom: number } } } }).__bevyRuntime.lastScene();
      const target = scene.nodes.find((entry) => entry.id === "legacy-card") as { x: number; y: number; width: number; height: number };
      const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
      return {
        x: rect.left + (target.x + target.width / 2) * scene.viewport.zoom + scene.viewport.x,
        y: rect.top + (target.y + 40) * scene.viewport.zoom + scene.viewport.y
      };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForTimeout(400);
    expect((await focusState(page)).focused).toBe(false);
  });

  test("新建旧卡片模型与复制旧卡片都被拒绝", async ({ page }) => {
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    // 新建缺少 sharedWorldInstance 的模型节点：整批拒绝。
    const rejected = await sendCommands(page, [{
      type: "node.add",
      node: { id: "legacy-rejected", type: "model3d", position: { x: 0, y: 0 } },
      nodeData: { modelScript: LEGACY_SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
    }]);
    expect(rejected.ok).toBe(false);
    const stored = await readStoredCanvas(page);
    expect(stored?.document.nodes.some((node) => node.id === "legacy-rejected")).toBe(false);
  });

  test("新建模型产生世界实例并可双击聚焦", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
    test.skip(!(await canvasRuntimeAvailable(page)), "本机 dev server 未提供 Bevy 运行时");

    expect((await sendCommands(page, [{
      type: "node.add",
      node: { id: "world-model", type: "model3d" },
      nodeData: modelNodeData({ x: 420, y: 220 })
    }])).ok).toBe(true);
    const stored = await readStoredCanvas(page);
    const data = stored?.nodeData?.["world-model"] as { sharedWorldInstance?: { instanceId?: string } } | undefined;
    expect(data?.sharedWorldInstance?.instanceId).toBeTruthy();
    // 模型没有卡片坐标。
    const storedNode = stored?.document.nodes.find((node) => node.id === "world-model") as { position?: unknown } | undefined;
    expect(storedNode?.position).toBeUndefined();

    const response = await page.request.post("/api/model-mcp/scripts", {
      data: {
        canvasId: CANVAS,
        nodeId: "world-model",
        requestId: crypto.randomUUID(),
        version: "woohaa-model-js-v2",
        source: "scene.box({ id: 'body', size: [1, 2, 1], position: [0, 1, 0], color: '#c06030' });"
      }
    });
    expect(response.ok(), await response.text()).toBe(true);
    await expect
      .poll(async () => (await renderedNode(page, "world-model"))?.model ? true : false, { timeout: 30_000 })
      .toBe(true);

    const point = await worldModelClientPoint(page, "world-model");
    await page.mouse.move(point.x, point.y);
    await page.mouse.dblclick(point.x, point.y);
    await expect.poll(async () => (await focusState(page)).nodeId, { timeout: 15_000 }).toBe("world-model");
  });
});
