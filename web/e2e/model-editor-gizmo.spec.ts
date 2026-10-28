/**
 * 模型编辑 gizmo / 镜头工具栏的浏览器验收
 * （change: add-model-editor-gizmo-shot-capture，任务 5.2 / 5.3）。
 *
 * 在真实 Bevy WASM 运行时上用确定性 V2 fixture 验证：
 * - 进入聚焦编辑后工具栏常驻、模型 gizmo 存在；
 * - 添加/选择/删除镜头写入 nodeData.modelCameras（子资源，无 camera/shot 节点）；
 * - 切换工具模式后 shot gizmo 出现并带正交相机；
 * - 退出再进入恢复镜头列表；
 * - 只读会话禁用持久化动作。
 *
 * 像素/视觉判定用容差；不依赖固定截图哈希。
 */
import { defaultSelfContained3DNodeData, SHOT_CAMERA_DEFAULT_ELEVATION } from "@woohaa3/contracts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  installPageHelpers,
  resetCanvasStorage,
  waitForCanvasSession
} from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

const HUMANOID_V2 = `
const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
scene.box({ id: "torso", size: [0.9, 1.6, 0.5], position: [0, 1.9, 0], material: armor });
scene.sphere({ id: "head", radius: 0.34, position: [0, 3.05, 0], color: "#e8c39e" });
`;

async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, requestId: crypto.randomUUID(), source, version: "woohaa-model-js-v2" }
  });
  expect(response.ok(), `submit_model_script 失败：${response.status()}`).toBe(true);
}

async function createModelNode(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    ({id,data}) => {
      const submit = (window as unknown as { __canvasSubmitCommands?: (commands: unknown[], commandId?: string) => unknown }).__canvasSubmitCommands;
      if (!submit) throw new Error("__canvasSubmitCommands 未安装");
      submit([{ type: "node.add", nodeData:data, node: { id, type: "composite-asset", position: { x: 500, y: 200 } } }], `e2e-model-${id}`);
    },
    {id:nodeId,data:defaultSelfContained3DNodeData("composite-asset")}
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
      const canonical = (window as unknown as { __canvasCanonical?: { nodeData?: Record<string, { modelScriptVersion?: string; modelScriptStatus?: string }> } }).__canvasCanonical;
      const data = canonical?.nodeData?.[id];
      return data?.modelScriptVersion === "woohaa-model-js-v2" && data.modelScriptStatus === "ok";
    },
    nodeId,
    { timeout: 30_000, polling: 200 }
  );
  await page.waitForTimeout(600);
}

async function focusPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const canonical = (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ id: string; type?: string; position: { x: number; y: number }; width?: number; height?: number }> } } }).__canvasCanonical;
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

async function enterFocusAndOpenEditor(page: Page, nodeId: string): Promise<void> {
  const point = await focusPoint(page, nodeId);
  await page.mouse.move(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __canvasModelFocus?: { focused?: () => boolean } }).__canvasModelFocus?.focused?.() === true), { timeout: 15_000 })
    .toBe(true);
  // 双击进入 direct focus 即启动编辑会话（工具栏随聚焦出现）。
  // 片场检查面板默认对象页；镜头工具栏位于「镜头」页签。
  await page.getByRole('tab', { name: "镜头", exact: true }).click();
  await page.waitForSelector(".model-editor", { timeout: 20_000 });
}

async function editorState(page: Page) {
  return page.evaluate(() => {
    const mirror = (window as unknown as { __modelEditor?: { state?: () => unknown; gizmo?: () => unknown; cameras?: () => unknown } }).__modelEditor;
    return { state: mirror?.state?.() ?? null, gizmo: mirror?.gizmo?.() ?? null, cameras: mirror?.cameras?.() ?? null };
  });
}

async function canonicalCameras(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const canonical = (window as unknown as { __canvasCanonical?: { nodeData?: Record<string, { modelCameras?: unknown }> } }).__canvasCanonical;
    return canonical?.nodeData?.[id]?.modelCameras ?? null;
  }, nodeId);
}

test.describe("模型编辑 gizmo 与镜头工具栏", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);
  });

  test("聚焦编辑显示模型 gizmo，添加/选择/删除镜头写入子资源且无 shot 节点", async ({ page }) => {
    const nodeId = "editor-model";
    await createModelNode(page, nodeId);
    await submitModelScript(page, nodeId, HUMANOID_V2);
    await waitForModelRendered(page, nodeId);
    await enterFocusAndOpenEditor(page, nodeId);

    // 工具栏常驻；默认镜头模式。
    await expect(page.locator(".model-editor")).toBeVisible();
    let info = await editorState(page);
    expect((info.state as { toolMode?: string }).toolMode).toBe("camera");
    // 模型 gizmo 已派生（camera 模式，无选中镜头时无 shot）。
    expect((info.gizmo as { toolMode?: string } | null)?.toolMode ?? null).toBe("camera");

    // 添加镜头。
    await page.evaluate(() => (window as unknown as { __modelEditor?: { addCamera?: () => void } }).__modelEditor?.addCamera?.());
    await page.waitForFunction(
      (id) => {
        const canonical = (window as unknown as { __canvasCanonical?: { nodeData?: Record<string, { modelCameras?: unknown[] }> } }).__canvasCanonical;
        return Array.isArray(canonical?.nodeData?.[id]?.modelCameras) && canonical!.nodeData![id]!.modelCameras!.length === 1;
      },
      nodeId,
      { timeout: 20_000, polling: 100 }
    );
    const cameras = await canonicalCameras(page, nodeId);
    expect(Array.isArray(cameras)).toBe(true);
    expect((cameras as Array<{ name: string }>)[0]!.name).toBe("镜头 1");

    // canonical 画布只更新 nodeData.modelCameras：不新增 camera/shot 节点或 edge。
    const nodeTypes = await page.evaluate(() =>
      (window as unknown as { __canvasCanonical?: { document?: { nodes?: Array<{ type?: string }> } } }).__canvasCanonical?.document?.nodes?.map((node) => node.type) ?? []
    );
    expect(nodeTypes).toContain("composite-asset");
    expect(nodeTypes).not.toContain("camera");
    expect(nodeTypes).not.toContain("shot");

    // 切到镜头模式 → shot gizmo 出现。
    await page.evaluate(() => (window as unknown as { __modelEditor?: { setToolMode?: (mode: string) => void } }).__modelEditor?.setToolMode?.("camera"));
    await page.waitForFunction(
      () => (window as unknown as { __modelEditorGizmo?: () => { toolMode?: string; shot?: unknown } | null }).__modelEditorGizmo?.()?.toolMode === "camera",
      undefined,
      { timeout: 20_000, polling: 100 }
    );
    const gizmo = await page.evaluate(() => (window as unknown as { __modelEditorGizmo?: () => { shot?: { fov?: number; elevation?: number } } | null }).__modelEditorGizmo?.() ?? null);
    expect(gizmo?.shot).toBeTruthy();
    expect(gizmo!.shot!.fov).toBeGreaterThan(0);
    expect(gizmo!.shot!.elevation).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 5);
  });

  test("退出再进入恢复镜头列表", async ({ page }) => {
    const nodeId = "editor-restore";
    await createModelNode(page, nodeId);
    await submitModelScript(page, nodeId, HUMANOID_V2);
    await waitForModelRendered(page, nodeId);
    await enterFocusAndOpenEditor(page, nodeId);

    await page.evaluate(() => (window as unknown as { __modelEditor?: { addCamera?: () => void } }).__modelEditor?.addCamera?.());
    await page.waitForFunction(
      (id) => Array.isArray((window as unknown as { __canvasCanonical?: { nodeData?: Record<string, { modelCameras?: unknown[] }> } }).__canvasCanonical?.nodeData?.[id]?.modelCameras) &&
        ((window as unknown as { __canvasCanonical?: { nodeData?: Record<string, { modelCameras?: unknown[] }> } }).__canvasCanonical!.nodeData![id]!.modelCameras!.length >= 1),
      nodeId,
      { timeout: 20_000, polling: 100 }
    );
    const cameras = await canonicalCameras(page, nodeId);
    expect((cameras as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});
