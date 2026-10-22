import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { defaultSelfContained3DNodeData } from "@woohaa3/contracts";
import { installPageHelpers, resetCanvasStorage, seedYjsCanvas, uploadMedia, waitForBevyReady, waitForCanvasSession } from "./helpers.js";

test("图片、视频与 3D 模型共用加载状态，资源就绪后清除", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installPageHelpers(page);
  await resetCanvasStorage(page);
  await waitForBevyReady(page);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#2b6cb0";
    ctx.fillRect(0, 0, 64, 48);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return [...new Uint8Array(await blob!.arrayBuffer())];
  });
  const image = await uploadMedia(page, png, "image/png");
  const videoBytes = readFileSync(new URL("./fixtures/video-live-preview-fixture.webm", import.meta.url));
  const video = await uploadMedia(page, [...videoBytes], "video/webm");
  expect(image.status).toBe(201);
  expect(video.status).toBe(201);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/media/**", async route => {
    if (["image", "media"].includes(route.request().resourceType())) await held;
    await route.continue();
  });
  // 第一个模型已经准备完成；延迟其上报使后续模型排队，真实验证准备中的加载提示。
  await page.route("**/api/model-mcp/scripts/report", async route => {
    if (route.request().postDataJSON()?.nodeId === "model-0-ready") await held;
    await route.continue();
  });
  const now = new Date().toISOString();
  await seedYjsCanvas(page, "woohaa3-default-canvas", [], { canvas: {
    id: "woohaa3-default-canvas", title: "共享加载状态", revision: 1,
    document: { schemaVersion: "asset-canvas-v1", edges: [], updatedAt: now, nodes: [
      { id: "model-0-ready", type: "model3d", position: { x: 1060, y: 240 }, width: 260, height: 195 },
      { id: "image-loading", type: "image", position: { x: 100, y: 240 }, width: 260, height: 195 },
      { id: "video-loading", type: "video", position: { x: 420, y: 240 }, width: 260, height: 195 },
      { id: "model-loading", type: "model3d", position: { x: 740, y: 240 }, width: 260, height: 195 }
    ] },
    nodeData: {
      "model-0-ready": defaultSelfContained3DNodeData("model3d"),
      "model-loading": defaultSelfContained3DNodeData("model3d"),
      "image-loading": { outputAssetId: "image-asset" },
      "video-loading": { outputAssetId: "video-asset" }
    },
    assets: [
      { id: "image-asset", title: "图片", mediaKind: "image", source: "uploaded", status: "ready", url: image.body.url, createdAt: now,
        metadata: { storageKey: image.body.storageKey, contentType: "image/png", size: png.length } },
      { id: "video-asset", title: "视频", mediaKind: "video", source: "uploaded", status: "ready", url: video.body.url, createdAt: now,
        metadata: { storageKey: video.body.storageKey, contentType: "video/webm", size: videoBytes.length } }
    ], jobs: [], updatedAt: now
  } });
  await page.goto("/");
  await waitForCanvasSession(page);
  const states = () => page.evaluate(() => (window as unknown as {
    __bevyRuntime: { lastScene: () => { nodes: { id: string; mediaLoading?: boolean; busy: boolean }[] } }
  }).__bevyRuntime.lastScene().nodes.map(node => ({ id: node.id, loading: !!node.mediaLoading, busy: node.busy })));
  await expect.poll(async () => (await states()).filter(node => node.loading).map(node => node.id).sort())
    .toEqual(["image-loading", "model-loading", "video-loading"]);
  expect((await states()).every(node => !node.busy)).toBe(true);
  await page.screenshot({ path: "/tmp/woohaa-shared-node-loading.png" });
  release();
  await expect.poll(async () => (await states()).filter(node => node.loading)).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __bevyRuntime: { lastScene: () => { nodes: { id: string; model?: unknown }[] } }
  }).__bevyRuntime.lastScene().nodes.find(node => node.id === "model-loading")?.model != null)).toBe(true);
});
