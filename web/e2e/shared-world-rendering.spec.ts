import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "./base-test";
import { seedYjsCanvas, waitForCanvasSession, sendCommands, waitForCommandsSettled } from "./helpers";

const canvasId = "woohaa3-default-canvas";
const script = (color: string) => `scene.group({ id: "root", position: [0.2, 0, 0], rotation: [0, 20, 0] }); scene.box({ id: "body", parent: "root", size: [2, 2, 2], color: "${color}" });`;

async function pixels(page: import("@playwright/test").Page, png: Buffer) {
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(250, 450, 400, 240).data;
    let red = 0, green = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i] > data[i + 1] * 1.8 && data[i] > data[i + 2] * 1.8) red++;
      if (data[i + 1] > 100 && data[i + 1] > data[i] * 1.5 && data[i + 1] > data[i + 2] * 1.5) green++;
    }
    return { red, green, rgba: Array.from(data) };
  }, png.toString("base64"));
}

test("converted world instances survive card moves and reload on the hardware application", async ({ page }, info) => {
  if (!process.env.WOOHAA_E2E_CDP || !process.env.E2E_BASE_URL) throw new Error("explicit hardware target required");
  const nodes = ["red", "green"].map((id, i) => ({ id, type: "model3d", position: { x: 300 + i * 70, y: 200 } }));
  await seedYjsCanvas(page, canvasId, nodes, { canvas: {
    id: canvasId, title: "World fixture", revision: 0,
    document: { schemaVersion: "asset-canvas-v1", nodes, edges: [], updatedAt: "2026-09-24T00:00:00.000Z" },
    nodeData: Object.fromEntries(nodes.map((node, i) => [node.id, { modelScript: script(i ? "#00ff00" : "#ff0000"), modelScriptVersion: "woohaa-model-js-v2", modelScriptLanguage: "javascript", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" } }])),
    assets: [], jobs: [], updatedAt: "2026-09-24T00:00:00.000Z"
  } });
  const wasm = page.waitForResponse(response => response.url().endsWith(".wasm") && response.ok(), { timeout: 90_000 });
  await page.goto("/");
  await waitForCanvasSession(page);
  await page.keyboard.press("Escape");
  const frame = page.frameLocator('iframe[title="画布渲染预览"]');
  await expect(frame.locator("canvas")).toBeVisible();
  const renderer = await frame.locator("canvas").evaluate(canvas => {
    const gl = (canvas as HTMLCanvasElement).getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  });
  expect(renderer).toMatch(/NVIDIA.*4060/i);
  const response = await wasm;
  const downloaded = await frame.locator("canvas").evaluate(async (_canvas, url) => {
    const bytes = await (await fetch(url)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }, response.url());
  const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
  const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  expect(downloaded).toBe(hash(built));
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.filter((n: any) => n.model).length), { timeout: 30_000 }).toBe(2);
  expect(await page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.every((n: any) => !n.sharedWorldInstance))).toBe(true);
  await frame.locator("canvas").screenshot({ path: info.outputPath("legacy-before-conversion.png") });
  const prepare = await page.request.post(`/api/canvases/${canvasId}/world-conversion-prepare`, { data: { nodeIds: nodes.map(n => n.id) } });
  expect(prepare.status(), await prepare.text()).toBe(200);
  const prepared = await prepare.json();
  const commit = await page.request.post(`/api/canvases/${canvasId}/world-conversion-commit`, { data: {
    operationId: "hardware-world-fixture", sourceVersion: prepared.sourceVersion,
    targets: prepared.nodes.map((node: { nodeId: string; nodeVersion: string }) => ({ ...node, instanceId: `instance-${node.nodeId}` })).map(({ nodeId, nodeVersion, instanceId }: { nodeId: string; nodeVersion: string; instanceId: string }) => ({ nodeId, nodeVersion, instanceId }))
  } });
  expect(commit.status(), await commit.text()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as any).__canvasCanonical?.nodeData?.red?.sharedWorldInstance)).toBeTruthy();
  const original = await page.evaluate(() => (window as any).__canvasCanonical.nodeData.red.sharedWorldInstance);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "red")?.sharedWorldInstance)).toEqual(original);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.filter((n: any) => n.model && n.sharedWorldInstance).length), { timeout: 30_000 }).toBe(2);
  await page.waitForTimeout(1500);
  const before = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-before-card-move.png") }));
  expect(before.red).toBeGreaterThan(500);
  expect(before.green).toBeGreaterThan(500);
  const hits = await page.evaluate(() => {
    const runtime = (window as any).__bevyRuntime;
    const generation = runtime.interactionGeneration();
    const found: Record<string, { x: number; y: number; target: number[]; radius: number }> = {};
    for (let y = 450; y < 690; y += 8) for (let x = 250; x < 650; x += 8) {
      const result = runtime.queryModelPick({ generation, x, y, width: 1280, height: 720 });
      if (result?.ok && result.value?.nodeId) found[result.value.nodeId] = { x, y, target: result.value.target, radius: result.value.radius };
    }
    return found;
  });
  expect(Object.keys(hits)).toContain("red");
  expect(Object.keys(hits)).toContain("green");
  expect((await sendCommands(page, [{ type: "node.update", nodeId: "red", position: { x: 800, y: 600 } }])).ok).toBe(true);
  await waitForCommandsSettled(page);
  await expect.poll(() => page.evaluate(() => (window as any).__canvasCanonical.nodeData.red.sharedWorldInstance)).toEqual(original);
  const after = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-after-card-move.png") }));
  expect(after.rgba).toEqual(before.rgba);
  const gesture = await page.evaluate(() => {
    const controller = (window as any).__worldGroundPreview;
    const start = { x: 700, y: 400 }, end = { x: 750, y: 420 };
    const a = controller.queryWorldGround(start), b = controller.queryWorldGround(end);
    return { a, b, began: controller.beginWorldGroundPreview("red", start), updated: controller.updateWorldGroundPreview(end) };
  });
  expect(gesture.began && gesture.updated).toBe(true);
  expect(gesture.a && gesture.b).toBeTruthy();
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "red")?.sharedWorldInstance?.transform.position.u)).toBeCloseTo(original.transform.position.u + gesture.b.u - gesture.a.u);
  expect(await page.evaluate(() => (window as any).__bevyRuntime.lastScene().nodes.find((n: any) => n.id === "red").sharedWorldInstance.transform.position.h)).toBe(original.transform.position.h);
  await page.waitForTimeout(500);
  const moved = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-preview.png") }));
  expect(moved.rgba).not.toEqual(before.rgba);
  await page.evaluate(() => (window as any).__worldGroundPreview.cancelWorldGroundPreview());
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "red")?.sharedWorldInstance)).toEqual(original);
  await page.waitForTimeout(500);
  const cancelled = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-cancelled.png") }));
  expect(cancelled.rgba).toEqual(before.rgba);
  await page.mouse.dblclick(400, 300);
  await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.())).toBe(true);
  const focus = await page.evaluate(() => (window as any).__canvasModelFocus.projection());
  const camera = await page.evaluate(() => (window as any).__canvasModelFocusEdit.camera());
  expect(focus.nodeId).toBe("green");
  for (let i = 0; i < 3; i++) expect(camera.target[i]).toBeCloseTo(hits.green.target[i], 2);
  expect(focus.radius).toBeCloseTo(hits.green.radius, 2);
  expect(await page.evaluate(() => (window as any).__worldGroundPreview.queryWorldGround({ x: 500, y: 500 }))).toBeNull();
  expect(await page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "green")?.sharedWorldInstance)).toEqual(prepared.nodes.find((n: any) => n.nodeId === "green") && { kind: "world-instance", version: "shared-world-v1", instanceId: "instance-green", transform: prepared.nodes.find((n: any) => n.nodeId === "green").transform });
  const focusPixels = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-focus.png") }));
  expect(focusPixels.green).toBeGreaterThan(500);
  await page.keyboard.press("Escape");
  await page.reload();
  await waitForCanvasSession(page);
  expect(await page.evaluate(() => (window as any).__canvasCanonical.nodeData.red.sharedWorldInstance)).toEqual(original);
  await writeFile(info.outputPath("hardware.json"), JSON.stringify({ renderer, wasmSha256: hash(built), wasmBytes: built.length, url: page.url(), prepared, original, hits, gesture, focus, camera, pixelCounts: { red: before.red, green: before.green } }, null, 2));
});
