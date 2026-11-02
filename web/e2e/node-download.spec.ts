/**
 * 节点顶部横条「下载」端到端验收
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.2/3.3/3.9）。
 *
 * 迁移后下载入口是**画布内 Bevy 绘制的横条**（`canvas.node-action` 宿主贡献的数据描述），
 * 命中由 Rust `point_query` 判定：
 * - 原卡片下载热区不再返回 `download` 命中，邻近历史命中保持；
 * - 横条在节点上方保持同一**世界单位**间距，随 zoom 一起缩放（画布内 chrome）；
 * - 复用 `NodeDownloadService`：图片/视频保存原文件、model3d 导出静态 GLB；
 * - 下载不写画布，未就绪内容命中不触发下载，HTTP 失败不保存错误页。
 *
 * 交互走真实输入路径：在 Rust 命中矩形中心的屏幕坐标 `mouse.click` → 指针处理 → `onNodeAction`
 * → 下载。断言只用真实运行时镜像（`__bevyRuntime.lastScene()` / `queryPoint`）与真实下载事件。
 *
 * 需要真实 GPU；无 GPU 环境标记「待人工验证」。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { readFile } from "node:fs/promises";
import { bevyNodeHistoryActionRect, createModel3DNodeData, model3DNodeDataFields, type CanvasCommand } from "@woohaa3/contracts";
import { installPageHelpers, readStoredCanvas, resetCanvasStorage, sendCommands, uploadMedia, waitForCanvasSession, waitForCommandsSettled } from "./helpers.js";

/** 通过运行时镜像选中单个节点（等价于点击选中）。 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.([id]);
  }, nodeId);
}

/** 节点当前屏幕矩形（世界坐标 × 当前视口 + canvas 外框偏移）。 */
async function nodeScreenRect(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((entry: any) => entry.id === id), v = scene.viewport;
    const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return {
      left: rect.left + node.x * v.zoom + v.x,
      top: rect.top + node.y * v.zoom + v.y,
      width: node.width * v.zoom,
      height: node.height * v.zoom
    };
  }, nodeId);
}

/** 世界坐标 → client 坐标（与 `nodeScreenRect` 同一公式）。 */
async function worldToClient(page: Page, world: { x: number; y: number }) {
  return page.evaluate((point) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const v = scene.viewport;
    const rect = document.querySelector("#bevy-canvas")!.getBoundingClientRect();
    return { x: rect.left + point.x * v.zoom + v.x, y: rect.top + point.y * v.zoom + v.y };
  }, world);
}

async function queryWorld(page: Page, point: { x: number; y: number }) {
  return page.evaluate((p) => (window as any).__bevyRuntime.queryPoint({ x: p.x, y: p.y, zoom: 1 }), point);
}

/**
 * 在节点上方探测横条命中：沿节点中轴从节点顶边向上采样，返回第一个 `node-action` 命中及其世界
 * 中心（同时覆盖「顶部碰撞改放下方」时改由调用方传 `below`）。
 */
async function probeBarAction(page: Page, nodeId: string, actionId: string, opts: { menu?: boolean; below?: boolean } = {}) {
  return page.evaluate(({ id, actionId, menu, below }) => {
    const scene = (window as any).__bevyRuntime.lastScene();
    const node = scene.nodes.find((entry: any) => entry.id === id);
    const centerX = node.x + node.width / 2;
    // 世界单位横条高约 36；从节点边缘向横条方向逐步采样宽度覆盖横条。
    const baseY = below ? node.y + node.height : node.y;
    const step = below ? 2 : -2;
    for (let offset = 6; Math.abs(offset) <= 60; offset += Math.abs(step)) {
      for (const dx of [0, -20, 20, -60, 60, -100, 100, -140, 140, -180, 180]) {
        const point = { x: centerX + dx, y: baseY + Math.sign(step) * offset };
        const hit = (window as any).__bevyRuntime.queryPoint({ x: point.x, y: point.y, zoom: 1 })?.value;
        if (hit && hit.kind === "node-action" && hit.actionId === actionId && hit.menu === menu && hit.nodeId === id) {
          return point;
        }
      }
    }
    return null;
  }, { id: nodeId, actionId, menu: opts.menu === true, below: opts.below === true });
}

test("节点顶部横条下载原媒体与静态 GLB，命中由 Rust 判定且不写画布", async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const png = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 40;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#dd5577"; ctx.fillRect(0, 0, 64, 40);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  const video = await readFile(new URL("./fixtures/video-live-preview-fixture.webm", import.meta.url));
  const commands: CanvasCommand[] = [];
  for (const [id, mediaKind, bytes, contentType, x] of [
    ["image", "image", png, "image/png", 120], ["video", "video", video, "video/webm", 450]
  ] as const) {
    const upload = await uploadMedia(page, [...bytes], contentType);
    expect(upload.status).toBe(201);
    const { storageKey, checksum, url, size } = upload.body as { storageKey: string; checksum: string; url: string; size: number };
    commands.push({ type: "asset.upsert", asset: {
      id: `asset-${id}`, title: id, mediaKind, source: "uploaded", status: "ready",
      createdAt: new Date().toISOString(), url, metadata: { storageKey, checksum, contentType, size }
    } }, { type: "node.add", node: { id, type: mediaKind, position: { x, y: 180 }, width: 248, height: 232 },
      nodeData: { title: id === "image" ? "参考图" : "动作.webm", outputAssetId: `asset-${id}`, resourceKind: mediaKind } });
  }
  commands.push({ type: "node.add", node: { id: "model", type: "model3d", position: { x: 800, y: 180 }, width: 248, height: 232 },
    nodeData: model3DNodeDataFields(createModel3DNodeData({ title: "人物", model: { modelScriptVersion: "woohaa-model-js-v2",
      modelScript: `scene.group({id:'root',position:[3,2,1],rotation:[0,90,0]});
        scene.box({id:'body',parent:'root',size:[1,2,1],color:'#ed6938'});
        scene.sphere({id:'head',parent:'root',radius:.5,position:[0,1.5,0],color:'#ffc077'});` } })) },
    { type: "node.add", node: { id: "empty", type: "image", position: { x: 120, y: 500 } } });
  expect((await sendCommands(page, commands)).ok).toBe(true); await waitForCommandsSettled(page);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.find((node: any) => node.id === "model")?.model?.resourceKey)).toBeTruthy();
  const before = await readStoredCanvas(page);

  // 旧卡片内下载热区已移除：原位置回落为节点主体命中，且不再返回 download；历史命中保持。
  const node = await page.evaluate((id) => (window as any).__bevyRuntime.lastScene().nodes.find((entry: any) => entry.id === id), "image");
  const historyRect = bevyNodeHistoryActionRect(node);
  const formerDownload = { x: node.x + node.width - 21, y: node.y + 22 };
  expect((await queryWorld(page, formerDownload)).value).toMatchObject({ kind: "node", nodeId: "image" });
  expect((await queryWorld(page, { x: historyRect.x + historyRect.width / 2, y: historyRect.y + historyRect.height / 2 })).value)
    .toMatchObject({ kind: "history", nodeId: "image" });

  for (const [id, filename, expected] of [["image", "参考图.png", png], ["video", "动作.webm", video], ["model", "人物.glb", null]] as const) {
    await selectNode(page, id);
    // 横条由 Bevy 绘制：Rust 在节点上方的动作矩形内返回 node-action 命中。
    await expect.poll(() => probeBarAction(page, id, "node-download"), { message: `横条下载命中 ${id}` }).not.toBeNull();
    const point = (await probeBarAction(page, id, "node-download"))!;
    const client = await worldToClient(page, point);
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    await page.mouse.click(client.x, client.y);
    await expect(page.getByTestId("node-download-status"), `download ${id}`).toContainText("已交给浏览器下载");
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    const path = await download.path(); expect(path).toBeTruthy();
    const bytes = await readFile(path!);
    if (expected) expect(bytes).toEqual(expected);
    else {
      expect(bytes.toString("ascii", 0, 4)).toBe("glTF"); expect(bytes.readUInt32LE(4)).toBe(2);
      expect(bytes.readUInt32LE(8)).toBe(bytes.length);
      const json = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
      expect(json.nodes.map((node: any) => node.name)).toEqual(expect.arrayContaining(["root", "head", "body"]));
      expect(json.meshes).toHaveLength(2); expect(json.buffers[0].byteLength).toBeGreaterThan(1000);
      const root = json.nodes.find((node: any) => node.name === "root");
      expect(root.translation ?? root.matrix?.slice(12, 15)).toEqual([3, 2, 1]);
    }
  }
  // 下载不修改持久画布（节点、资产、连接、历史全部不变）。
  expect((await readStoredCanvas(page))!.document).toEqual(before!.document);
  expect((await readStoredCanvas(page))!.assets).toEqual(before!.assets);

  // 内容未就绪：仍返回 node-action 命中（Rust 只按描述布局），但宿主不触发下载（不保存错误文件）。
  await selectNode(page, "empty");
  const emptyPoint = await probeBarAction(page, "empty", "node-download");
  expect(emptyPoint).not.toBeNull();
  const emptyClient = await worldToClient(page, emptyPoint!);
  await page.mouse.click(emptyClient.x, emptyClient.y);
  await expect(page.getByTestId("node-download-status")).toHaveCount(0);

  // HTTP 失败不得把错误页当文件保存；重试仍用同一横条动作。
  const url = (await readStoredCanvas(page))!.assets.find(asset => asset.id === "asset-image")!.url!;
  await page.route(`**${url}`, route => route.fulfill({ status: 503, contentType: "text/html", body: "unavailable" }));
  await selectNode(page, "image");
  const imagePoint = (await probeBarAction(page, "image", "node-download"))!;
  const imageClient = await worldToClient(page, imagePoint);
  await page.mouse.click(imageClient.x, imageClient.y);
  await expect(page.getByTestId("node-download-status")).toContainText("HTTP 503");
  await page.unroute(`**${url}`);

  // 缩放后横条随 zoom 一起缩放：同一世界单位间距，屏幕间距按 zoom 放大。
  await page.getByRole("slider", { name: "缩放", exact: true }).fill("120");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene().viewport.zoom)).toBeCloseTo(1.2);
  const zoomedPoint = await probeBarAction(page, "image", "node-download");
  expect(zoomedPoint).not.toBeNull();
  const zoomedNode = await nodeScreenRect(page, "image");
  const zoomedClient = await worldToClient(page, zoomedPoint!);
  // 命中点在节点上方且仍在屏幕内（随 zoom 缩放后位置随节点投影变化）。
  expect(zoomedClient.y).toBeLessThan(zoomedNode.top);

  const retry = page.waitForEvent("download");
  await page.mouse.click(zoomedClient.x, zoomedClient.y);
  expect((await retry).suggestedFilename()).toBe("参考图.png");
  await page.screenshot({ path: info.outputPath("node-action-toolbar-download.png") });
  expect(errors).toEqual([]);
});
