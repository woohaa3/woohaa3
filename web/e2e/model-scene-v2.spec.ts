/**
 * V2 连续人物 WASM 视觉回归
 * （change: enhance-model-scene-authoring-api，任务 9.1 / 9.2 / 9.4）。
 *
 * 在真实 Bevy WASM 运行时加载一个由 torso、sphere joints、box/capsule segments 与金属/发光
 * 材质构成的 V2 人形 fixture，然后：
 * - 通过权威提交接口写入 V2 modelScript；
 * - 对 `#bevy-canvas` 截图做像素采样，断言存在连续前景、无异常裁切/空白；
 * - 在桌面与移动视口、DPR 2 下运行，验证自动取景与无 NaN/panic；
 * - 验证父 group 动画会把整条手臂一起带动。
 *
 * 像素判定用容差（前景占比/连通区域/包围框），不以逐像素哈希相同为条件（design D13）。
 */
import { expect, test } from "./review-browser.js";
import type { Page } from "@playwright/test";
import { installPageHelpers, resetCanvasStorage, createNode, waitForCanvasSession, sendCommands, waitForCommandsSettled } from "./helpers.js";

const CANVAS = "woohaa3-default-canvas";

/** 标准 V2 人形 fixture：torso box、sphere joints、box/capsule segments、金属与发光材质。 */
const HUMANOID_V2 = `
const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
const glow = scene.material({ id: "glow", baseColor: "#101820", emissive: "#33ffaa", emissiveStrength: 3, roughness: 0.4 });
scene.box({ id: "torso", size: [0.9, 1.6, 0.5], position: [0, 1.9, 0], material: armor });
scene.sphere({ id: "chest-core", radius: 0.16, position: [0, 2.1, 0.26], material: glow });
const shoulder = [-0.65, 2.4, 0];
const elbow = [-1.05, 1.75, 0];
const wrist = [-1.05, 1.05, 0];
scene.sphere({ id: "shoulder", radius: 0.22, position: shoulder, material: armor });
scene.segment({ id: "upper-arm", from: shoulder, to: elbow, width: 0.26, shape: "box", material: armor });
scene.segment({ id: "forearm", from: elbow, to: wrist, width: 0.24, shape: "capsule", material: armor });
scene.sphere({ id: "hand", radius: 0.16, position: wrist, color: "#e8c39e" });
scene.segment({ id: "left-leg", from: [-0.25, 1.1, 0], to: [-0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
scene.segment({ id: "right-leg", from: [0.25, 1.1, 0], to: [0.25, 0.1, 0], width: 0.4, shape: "capsule", material: armor });
scene.sphere({ id: "head", radius: 0.34, position: [0, 3.05, 0], color: "#e8c39e" });
`;

type ForegroundStats = {
  width: number;
  height: number;
  ratio: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 前景像素的连通分量数量与最大分量占比（用 4-邻域在降采样网格上估算）。 */
  components: number;
  largestShare: number;
};

/** 通过权威 model MCP 提交接口写入 V2 脚本（服务端校验+持久化，浏览器订阅后渲染）。 */
async function submitModelScript(page: Page, nodeId: string, source: string): Promise<void> {
  const response = await page.request.post("/api/model-mcp/scripts", {
    data: { canvasId: CANVAS, nodeId, source, version: "woohaa-model-js-v2", requestId: `e2e-${nodeId}-${source}` }
  });
  expect(response.ok(), `submit_model_script 失败：${response.status()}`).toBe(true);
}

/** 等待节点权威脚本变为 V2 且被 Bevy 应用，然后留出渲染时间。 */
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

/**
 * 对 `#bevy-canvas` 截图做前景统计。
 *
 * 背景是浅灰绿网格（近中性色），模型材质是有色/发光像素；以饱和度（max-min）> 阈值并
 * 带 alpha 判定前景，避免把网格/卡片算进去。连通性在 4 倍降采样网格上做 4-邻域洪泛，
 * 用于「主要肢体连通」的语义断言（容忍抗锯齿带来的细微间隙）。
 */
async function foregroundStats(page: Page): Promise<ForegroundStats> {
  const buffer = await page.locator("#bevy-canvas").screenshot();
  const base64 = buffer.toString("base64");
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const width = bitmap.width;
    const height = bitmap.height;
    const mask = new Uint8Array(width * height);
    let count = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const maxChannel = Math.max(px[index], px[index + 1], px[index + 2]);
        const minChannel = Math.min(px[index], px[index + 1], px[index + 2]);
        if (px[index + 3] > 16 && maxChannel - minChannel > 24) {
          mask[y * width + x] = 1;
          count += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // 4-邻域连通分量（迭代洪泛，避免递归栈溢出）。
    const visited = new Uint8Array(width * height);
    let components = 0;
    let largest = 0;
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start += 1) {
      if (mask[start] === 0 || visited[start] === 1) continue;
      components += 1;
      let size = 0;
      stack.push(start);
      visited[start] = 1;
      while (stack.length > 0) {
        const current = stack.pop()!;
        size += 1;
        const x = current % width;
        const y = (current - x) / width;
        if (x > 0) { const n = current - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (x < width - 1) { const n = current + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (y > 0) { const n = current - width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (y < height - 1) { const n = current + width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }
      if (size > largest) largest = size;
    }

    return {
      width,
      height,
      ratio: count / (width * height),
      minX, maxX, minY, maxY,
      components,
      largestShare: count === 0 ? 0 : largest / count
    };
  }, base64);
}

/** 在前景统计上限定一个页面区域（用于观察单个模型是否运动）。 */
async function foregroundStatsIn(
  page: Page,
  region: { x: number; y: number; width: number; height: number }
): Promise<ForegroundStats> {
  const buffer = await page.screenshot({
    clip: { x: region.x, y: region.y, width: region.width, height: region.height }
  });
  const base64 = buffer.toString("base64");
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const width = bitmap.width;
    const height = bitmap.height;
    let count = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const maxChannel = Math.max(px[index], px[index + 1], px[index + 2]);
        const minChannel = Math.min(px[index], px[index + 1], px[index + 2]);
        if (px[index + 3] > 16 && maxChannel - minChannel > 24) {
          count += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      width,
      height,
      ratio: count / (width * height),
      minX, maxX, minY, maxY,
      components: 0,
      largestShare: 0
    };
  }, base64);
}

/** 取实际渲染节点中心，适配模型卡片居中布局。 */async function modelClientPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((entry: any) => entry.id === id);
    if (!node) throw new Error("node not found");
    const viewport = scene.viewport;
    const rect = (document.querySelector("#bevy-canvas") as HTMLCanvasElement).getBoundingClientRect();
    const worldX = (node.x + node.width / 2) * viewport.zoom + viewport.x;
    const worldY = (node.y + node.height / 2) * viewport.zoom + viewport.y;
    return { x: worldX + rect.left, y: worldY + rect.top };
  }, nodeId);
}

test.describe("V2 连续人物 WASM 视觉回归", () => {
  test("桌面视口：模型非空、主要肢体连通、正确取景", async ({ page }) => {
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    const created = await createNode(page, { nodeType: "model3d", position: { x: 380, y: 120 }, nodeId: "model-v2-e2e" });
    expect(created.ok).toBe(true);
    await submitModelScript(page, "model-v2-e2e", HUMANOID_V2);
    await waitForModelRendered(page, "model-v2-e2e");

    const stats = await foregroundStats(page);
    // 非空：有可识别前景。
    expect(stats.ratio).toBeGreaterThan(0.0015);
    // 主要肢体连通：最大连通分量占前景的绝大多数。
    expect(stats.largestShare).toBeGreaterThan(0.6);
    // 正确取景：包围框在画布内部，且没有贴满整屏（相机/缩放失控）。
    expect(stats.minX).toBeGreaterThanOrEqual(0);
    expect(stats.maxX).toBeLessThan(stats.width);
    expect(stats.ratio).toBeLessThan(0.5);
  });

  test("移动视口 + DPR 2：自动取景、无 NaN/panic", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 720 },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await installPageHelpers(page);
      await resetCanvasStorage(page);
      await waitForCanvasSession(page);

      const created = await createNode(page, { nodeType: "model3d", position: { x: 120, y: 80 }, nodeId: "model-v2-mobile" });
      expect(created.ok).toBe(true);
      await submitModelScript(page, "model-v2-mobile", HUMANOID_V2);
      await waitForModelRendered(page, "model-v2-mobile");

      const stats = await foregroundStats(page);
      expect(stats.ratio).toBeGreaterThan(0.001);
      // 无 NaN/panic 类页内异常。
      expect(errors.filter((message) => /NaN|panic|RuntimeError/i.test(message))).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("父 group 动画只在 hover 时播放、离开后静止（视觉回归）", async ({ page }) => {
    test.setTimeout(180_000); // SwiftShader 下多次全画布像素采样较慢。
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    const created = await createNode(page, {
      // 普通画布 free model 直接使用 model3d；hover 时播放动画。
      nodeType: "model3d",
      position: { x: 380, y: 120 },
      nodeId: "model-v2-anim"
    });
    expect(created.ok).toBe(true);

    const animated = `
      const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
      scene.sphere({ id: "torso", radius: 0.55, position: [0, 1.4, 0], material: armor });
      scene.group({ id: "arm", position: [0, 2.0, 0], rotation: [0, 0, -35] });
      scene.segment({ id: "upper", parent: "arm", from: [0, 0, 0], to: [0, -0.9, 0], width: 0.3, shape: "box", material: armor });
      scene.segment({ id: "fore", parent: "arm", from: [0, -0.9, 0], to: [0.25, -1.7, 0], width: 0.26, shape: "capsule", material: armor });
      scene.sphere({ id: "elbow", parent: "arm", radius: 0.2, position: [0, -0.9, 0], color: "#e8c39e" });
      scene.sphere({ id: "hand", parent: "arm", radius: 0.16, position: [0.25, -1.7, 0], color: "#e8c39e" });
      scene.rotate("arm", { axis: "z", speed: 1.5 });
    `;
    // 模型按节点矩形适配；使用足够大的矩形保持像素判定的信噪比。
    expect((await sendCommands(page, [{ type: "node.update", nodeId: "model-v2-anim", width: 320, height: 320 }])).ok).toBe(true);
    await waitForCommandsSettled(page);
    await submitModelScript(page, "model-v2-anim", animated);
    await waitForModelRendered(page, "model-v2-anim");

    // 未 hover：动画保持时间零点姿态，等待多个渲染帧后前景包围框稳定。
    await page.mouse.move(20, 600);
    await page.waitForTimeout(300);
    const idleA = await foregroundStats(page);
    expect(idleA.ratio).toBeGreaterThan(0.001);
    await page.waitForTimeout(900);
    const idleB = await foregroundStats(page);
    expect(idleB).toEqual(idleA);

    // hover 模型：前景包围框随时间变化（动画播放）。
    const point = await modelClientPoint(page, "model-v2-anim");
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(300);
    const hoveredA = await foregroundStats(page);
    await page.waitForTimeout(900);
    const hoveredB = await foregroundStats(page);
    const moved =
      hoveredA.minX !== hoveredB.minX ||
      hoveredA.maxX !== hoveredB.maxX ||
      hoveredA.minY !== hoveredB.minY ||
      hoveredA.maxY !== hoveredB.maxY ||
      Math.abs(hoveredA.ratio - hoveredB.ratio) > 1e-4;
    expect(moved).toBe(true);

    // 指针离开模型：回到稳定基线（与空闲帧一致，且不再随时间变化）。
    await page.mouse.move(20, 600);
    await page.waitForTimeout(600);
    const leftA = await foregroundStats(page);
    await page.waitForTimeout(900);
    const leftB = await foregroundStats(page);
    expect(leftB).toEqual(leftA);
    expect(leftA).toEqual(idleA);
  });

  test("A→B hover 互斥：只有 B 运动，A 恢复静止（change: play-model-animations-on-hover）", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installPageHelpers(page);
    await resetCanvasStorage(page);
    await waitForCanvasSession(page);

    const animated = (axis: string) => `
      const armor = scene.material({ id: "armor", baseColor: "#c06030", metallic: 0.5, roughness: 0.4 });
      scene.box({ id: "body", size: [0.8, 1.8, 0.6], position: [0, 1.4, 0], material: armor });
      scene.sphere({ id: "head", radius: 0.3, position: [0, 2.7, 0], color: "#e8c39e" });
      scene.rotate("body", { axis: "${axis}", speed: 3.0 });
    `;
    // 两个模型节点相距足够远，互不重叠。
    for (const [id, x, axis] of [
      ["anim-a", 200, "y"],
      ["anim-b", 900, "z"]
    ] as const) {
      const created = await createNode(page, { nodeType: "model3d", position: { x, y: 150 }, nodeId: id });
      expect(created.ok).toBe(true);
      expect((await sendCommands(page, [{ type: "node.update", nodeId: id, width: 320, height: 320 }])).ok).toBe(true);
      await waitForCommandsSettled(page);
      await submitModelScript(page, id, animated(axis));
      await waitForModelRendered(page, id);
    }

    // 两个节点都在视口内：整体前景是两个稳定模型。
    const pointA = await modelClientPoint(page, "anim-a");
    const pointB = await modelClientPoint(page, "anim-b");
    await page.mouse.move(20, 700);
    await page.waitForTimeout(400);
    const idle = await foregroundStats(page);

    // hover A：整体画面随时间变化（A 运动）。
    await page.mouse.move(pointA.x, pointA.y);
    await page.waitForTimeout(300);
    const a1 = await foregroundStats(page);
    await page.waitForTimeout(400);
    const a2 = await foregroundStats(page);
    expect(a2).not.toEqual(a1);

    // 切到 B：A 停止。以「左半区」采样证明 A 不再运动。
    await page.mouse.move(pointB.x, pointB.y);
    await page.waitForTimeout(500);
    const bLeft1 = await foregroundStatsIn(page, { x: 0, y: 0, width: 500, height: 900 });
    await page.waitForTimeout(500);
    const bLeft2 = await foregroundStatsIn(page, { x: 0, y: 0, width: 500, height: 900 });
    expect(bLeft2).toEqual(bLeft1);

    // 离开 B：画面恢复到两个静止模型。
    await page.mouse.move(20, 700);
    await page.waitForTimeout(600);
    const settled = await foregroundStats(page);
    await page.waitForTimeout(500);
    expect(await foregroundStats(page)).toEqual(settled);
    // 模型仍可见（未因切换被隐藏/删除）。
    expect(settled.ratio).toBeGreaterThanOrEqual(idle.ratio * 0.9);
  });
});
