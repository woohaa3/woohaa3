import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "./base-test";
import { seedYjsCanvas, waitForCanvasSession, sendCommands, waitForCommandsSettled, uploadMedia } from "./helpers";
import { normalizeGlbModelReference } from "@woohaa3/contracts";

const canvasId = "woohaa3-default-canvas";
const script = (color: string) => `scene.group({ id: "root", position: [0.2, 0, 0], rotation: [0, 20, 0], scale: [1.2, 0.8, 1.1] }); scene.box({ id: "body", parent: "root", position: [0.1, 0.2, 0.3], rotation: [10, 0, 15], size: [2, 2, 2], color: "${color}" });`;

async function modelPose(page: import("@playwright/test").Page, id: string, focusNode: string | null) {
  const sequence = await page.evaluate(() => (window as any).__bevyRuntime.getWorkDiagnostics().modelPoses.sequence);
  await expect.poll(() => page.evaluate(({ sequence, focusNode }) => { const sample = (window as any).__bevyRuntime.getWorkDiagnostics().modelPoses; return sample.sequence > sequence && sample.focusNode === focusNode; }, { sequence, focusNode })).toBe(true);
  const sample = await page.evaluate(() => (window as any).__bevyRuntime.getWorkDiagnostics().modelPoses);
  return { sequence: sample.sequence, focusNode: sample.focusNode, ...sample.models.find((pose: any) => pose.nodeId === id) };
}

function uniqueGlb(): number[] {
  const vertices = new Float32Array([-2, 0, 0, 2, 0, 0, 2, 4, 0, -2, 4, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const doc = { asset: { version: "2.0", generator: `world-e2e-${Date.now()}` }, buffers: [{ byteLength: 60 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const json = Buffer.from(JSON.stringify(doc));
  const size = (json.length + 3) & ~3;
  const out = Buffer.alloc(20 + size + 8 + 60);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(size, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(32, 20, 20 + size); json.copy(out, 20);
  out.writeUInt32LE(60, 20 + size); out.writeUInt32LE(0x004e4942, 24 + size);
  Buffer.from(vertices.buffer).copy(out, 28 + size); Buffer.from(indices.buffer).copy(out, 76 + size);
  return [...out];
}

async function pixels(page: import("@playwright/test").Page, png: Buffer, full = false) {
  return page.evaluate(async ({ encoded, full }) => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
    const data = full ? ctx.getImageData(0, 0, image.width, image.height).data : ctx.getImageData(250, 450, 400, 240).data;
    let red = 0, green = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i] > data[i + 1] * 1.8 && data[i] > data[i + 2] * 1.8) red++;
      if (data[i + 1] > 100 && data[i + 1] > data[i] * 1.5 && data[i + 1] > data[i + 2] * 1.5) green++;
    }
    return { red, green, rgba: Array.from(data) };
  }, { encoded: png.toString("base64"), full });
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
  expect((await sendCommands(page, [{ type: "node.update", nodeId: "red", position: { x: 800, y: 600 }, zIndex: 20 }, { type: "node.update", nodeId: "green", zIndex: -20 }])).ok).toBe(true);
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
  const ordinaryPose = await modelPose(page, "green", null);
  expect(ordinaryPose?.parts?.root).toBeTruthy();
  expect(ordinaryPose?.parts?.body).toBeTruthy();
  [1.2, 0.8, 1.1].forEach((value, i) => expect(ordinaryPose.parts.root.scale[i]).toBeCloseTo(value, 4));
  expect(ordinaryPose.parts.root.rotation[1]).toBeCloseTo(Math.sin(Math.PI / 18), 4);
  [0.1, 0.2, 0.3].forEach((value, i) => expect(ordinaryPose.parts.body.translation[i]).toBeCloseTo(value, 4));
  await page.mouse.dblclick(400, 300);
  await expect.poll(() => page.evaluate(() => (window as any).__canvasModelFocus?.focused?.())).toBe(true);
  const focus = await page.evaluate(() => (window as any).__canvasModelFocus.projection());
  const camera = await page.evaluate(() => (window as any).__canvasModelFocusEdit.camera());
  expect(focus.nodeId).toBe("green");
  for (let i = 0; i < 3; i++) expect(camera.target[i]).toBeCloseTo(hits.green.target[i], 2);
  expect(focus.radius).toBeCloseTo(hits.green.radius, 2);
  await page.waitForTimeout(1000);
  const focusPose = await modelPose(page, "green", "green");
  expect(focusPose.sequence).toBeGreaterThan(ordinaryPose.sequence);
  for (const part of ["root", "body"]) for (const field of ["translation", "rotation", "scale", "globalMatrix"]) {
    expect(focusPose.parts[part][field]).toHaveLength(ordinaryPose.parts[part][field].length);
    ordinaryPose.parts[part][field].forEach((value: number, i: number) => expect(focusPose.parts[part][field][i]).toBeCloseTo(value, 4));
  }
  for (const field of ["translation", "rotation", "scale", "globalMatrix"]) ordinaryPose.root[field].forEach((value: number, i: number) => expect(focusPose.root[field][i]).toBeCloseTo(value, 4));
  expect(await page.evaluate(() => (window as any).__worldGroundPreview.queryWorldGround({ x: 500, y: 500 }))).toBeNull();
  expect(await page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "green")?.sharedWorldInstance)).toEqual(prepared.nodes.find((n: any) => n.nodeId === "green") && { kind: "world-instance", version: "shared-world-v1", instanceId: "instance-green", transform: prepared.nodes.find((n: any) => n.nodeId === "green").transform });
  const focusPixels = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-focus.png") }));
  expect(focusPixels.green).toBeGreaterThan(500);
  await page.keyboard.press("Escape");
  await page.reload();
  await waitForCanvasSession(page);
  expect(await page.evaluate(() => (window as any).__canvasCanonical.nodeData.red.sharedWorldInstance)).toEqual(original);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "green")?.model != null), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await pixels(page, await frame.locator("canvas").screenshot())).green, { timeout: 30_000 }).toBeGreaterThan(500);
  const reopened = await pixels(page, await frame.locator("canvas").screenshot({ path: info.outputPath("world-reopened.png") }));
  const reopenedHit = await page.evaluate(({ x, y }) => {
    const runtime = (window as any).__bevyRuntime;
    return runtime.queryModelPick({ generation: runtime.interactionGeneration(), x, y, width: 1280, height: 720 });
  }, hits.green);
  expect(reopenedHit?.value?.nodeId).toBe("green");
  await writeFile(info.outputPath("hardware.json"), JSON.stringify({ renderer, wasmSha256: hash(built), wasmBytes: built.length, url: page.url(), prepared, original, hits, gesture, focus, camera, ordinaryPose, focusPose, reopenedHit, pixelCounts: { red: before.red, green: before.green, reopenedGreen: reopened.green } }, null, 2));
});

test("world GLB recovers after its actual media request is released", async ({ page, browser }, info) => {
  if (!process.env.WOOHAA_E2E_CDP || !process.env.E2E_BASE_URL) throw new Error("explicit hardware target required");
  await page.goto("/");
  const bytes = uniqueGlb();
  const upload = await uploadMedia(page, bytes, "model/gltf-binary");
  expect(upload.status).toBe(201);
  const key = String(upload.body.storageKey), url = String(upload.body.url);
  const assetId = `asset-upload-${key.slice(7)}`;
  const reference = normalizeGlbModelReference({ assetId });
  if (!reference.ok) throw new Error("invalid GLB fixture reference");
  const node = { id: "delayed-glb", type: "model3d", position: { x: 400, y: 300 } };
  const now = new Date().toISOString();
  await seedYjsCanvas(page, canvasId, [], { canvas: {
    id: canvasId, title: "Delayed world GLB", revision: 0,
    document: { schemaVersion: "asset-canvas-v1", nodes: [], edges: [], updatedAt: now },
    nodeData: {}, assets: [], jobs: [], updatedAt: now
  } });
  await page.reload();
  await waitForCanvasSession(page);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let release!: () => void, signal!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { signal = resolve; });
  try {
    await context.route(`**${url}*`, async route => { signal(); await held; await route.continue(); });
    const delayed = await context.newPage();
    const wasm = delayed.waitForResponse(response => response.url().endsWith(".wasm") && response.ok(), { timeout: 90_000 });
    await delayed.goto(process.env.E2E_BASE_URL!);
    await waitForCanvasSession(delayed);
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "delayed-instance", transform: { version: "shared-world-v1", position: { u: 6, v: -5, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const result = await sendCommands(delayed, [
      { type: "asset.upsert", asset: { id: assetId, title: "fixture.glb", mediaKind: "file", source: "uploaded", status: "ready", createdAt: now, url, metadata: { storageKey: key, checksum: key.slice(7), contentType: "model/gltf-binary", modelFormat: "glb", size: bytes.length } } },
      { type: "node.add", node, nodeData: { modelSourceKind: "glb", modelAssetId: assetId, modelContentVersion: reference.value.contentVersion, modelPlacement: reference.value.placement, sharedWorldInstance: instance } }
    ]);
    expect(result.ok).toBe(true);
    await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error("GLB request did not reach gate")), 30_000))]);
    await expect.poll(() => delayed.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "delayed-glb")?.model == null)).toBe(true);
    const frame = delayed.frameLocator('iframe[title="画布渲染预览"]');
    const canvas = frame.locator("canvas");
    const renderer = await canvas.evaluate(element => { const gl = (element as HTMLCanvasElement).getContext("webgl2"); const ext = gl?.getExtension("WEBGL_debug_renderer_info"); return ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL); });
    expect(renderer).toMatch(/NVIDIA.*4060/i);
    const wasmUrl = (await wasm).url();
    const downloaded = await canvas.evaluate(async (_element, source) => { const bytes = await (await fetch(source)).arrayBuffer(); return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""); }, wasmUrl);
    const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
    expect(downloaded).toBe(createHash("sha256").update(built).digest("hex"));
    const heldPixels = await pixels(delayed, await canvas.screenshot({ path: info.outputPath("glb-held.png") }), true);
    release();
    await expect.poll(() => delayed.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.find((n: any) => n.id === "delayed-glb")?.model), { timeout: 30_000 }).toBeTruthy();
    await expect.poll(async () => (await pixels(delayed, await canvas.screenshot(), true)).green, { timeout: 30_000 }).toBeGreaterThan(heldPixels.green + 100);
    await canvas.screenshot({ path: info.outputPath("glb-ready.png") });
    const hit = await delayed.evaluate(() => { const r = (window as any).__bevyRuntime; const generation = r.interactionGeneration(); for (let y = 0; y < 720; y += 8) for (let x = 0; x < 1280; x += 8) { const value = r.queryModelPick({ generation, x, y, width: 1280, height: 720 }); if (value?.value?.nodeId === "delayed-glb") return { x, y, value }; } return null; });
    expect(hit).toBeTruthy();
    await waitForCommandsSettled(delayed);
    await delayed.reload();
    await waitForCanvasSession(delayed);
    await expect.poll(async () => (await pixels(delayed, await canvas.screenshot(), true)).green, { timeout: 30_000 }).toBeGreaterThan(heldPixels.green + 100);
    await canvas.screenshot({ path: info.outputPath("glb-reopened.png") });
    const reopenedHit = await delayed.evaluate(({ x, y }) => { const r = (window as any).__bevyRuntime; return r.queryModelPick({ generation: r.interactionGeneration(), x, y, width: 1280, height: 720 }); }, hit!);
    expect(reopenedHit?.value?.nodeId).toBe("delayed-glb");
    await writeFile(info.outputPath("glb-gate.json"), JSON.stringify({ key, url, instance, hit, reopenedHit, renderer, wasmSha256: createHash("sha256").update(built).digest("hex"), heldGreen: heldPixels.green }, null, 2));
  } finally { release(); await context.close(); }
});

test("interleaved surfaces retain depth when card order changes", async ({ page }, info) => {
  if (!process.env.WOOHAA_E2E_CDP || !process.env.E2E_BASE_URL) throw new Error("explicit hardware target required");
  const depthScript = (color: string, sign: number) => `scene.group({id:"parent",rotation:[0,0,0],scale:[1,1,1]});
    scene.box({id:"left",parent:"parent",position:[${-0.707 + sign * 0.612},${sign * 0.5},${0.707 + sign * 0.612}],size:[1.5,1.5,1.5],color:"${color}"});
    scene.box({id:"right",parent:"parent",position:[${0.707 - sign * 0.612},${-sign * 0.5},${-0.707 - sign * 0.612}],size:[1.5,1.5,1.5],color:"${color}"});`;
  const nodes = ["depth-red", "depth-green"].map(id => ({ id, type: "model3d", position: { x: 400, y: 300 } }));
  const now = new Date().toISOString();
  await seedYjsCanvas(page, canvasId, nodes, { canvas: { id: canvasId, title: "Depth fixture", revision: 0,
    document: { schemaVersion: "asset-canvas-v1", nodes, edges: [], updatedAt: now },
    nodeData: Object.fromEntries(nodes.map((node, i) => [node.id, { modelScript: depthScript(i ? "#00ff00" : "#ff0000", i ? -1 : 1), modelScriptVersion: "woohaa-model-js-v2", modelScriptLanguage: "javascript", modelContentVersion: { revision: 1, sourceHash: `depth-${i}`, contentHash: `depth-${i}` } }])), assets: [], jobs: [], updatedAt: now } });
  const wasm = page.waitForResponse(response => response.url().endsWith(".wasm") && response.ok(), { timeout: 90_000 });
  await page.goto("/"); await waitForCanvasSession(page); await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.filter((n: any) => n.model).length), { timeout: 30_000 }).toBe(2);
  const prepare = await page.request.post(`/api/canvases/${canvasId}/world-conversion-prepare`, { data: { nodeIds: nodes.map(n => n.id) } });
  expect(prepare.status(), await prepare.text()).toBe(200);
  const prepared = await prepare.json();
  const commit = await page.request.post(`/api/canvases/${canvasId}/world-conversion-commit`, { data: { operationId: "depth-interleave", sourceVersion: prepared.sourceVersion, targets: prepared.nodes.map((n: any) => ({ nodeId: n.nodeId, nodeVersion: n.nodeVersion, instanceId: `instance-${n.nodeId}` })) } });
  expect(commit.status(), await commit.text()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes?.filter((n: any) => n.sharedWorldInstance).length)).toBe(2);
  const canvas = page.frameLocator('iframe[title="画布渲染预览"]').locator("canvas");
  const renderer = await canvas.evaluate(element => { const gl = (element as HTMLCanvasElement).getContext("webgl2"); const ext = gl?.getExtension("WEBGL_debug_renderer_info"); return ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL); });
  expect(renderer).toMatch(/NVIDIA.*4060/i);
  const wasmUrl = (await wasm).url();
  const downloaded = await canvas.evaluate(async (_element, source) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await (await fetch(source)).arrayBuffer())), b => b.toString(16).padStart(2, "0")).join(""), wasmUrl);
  const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
  expect(downloaded).toBe(createHash("sha256").update(built).digest("hex"));
  await page.waitForTimeout(1000);
  const capture = async (name: string) => pixels(page, await canvas.screenshot({ path: info.outputPath(name) }));
  const combined = await capture("depth-combined.png");
  const isolate = async (id: string, name: string) => {
    const ok = await page.evaluate(id => { const c = (window as any).__worldGroundPreview; return c.beginWorldGroundPreview(id, { x: 650, y: 400 }) && c.updateWorldGroundPreview({ x: 1100, y: 400 }); }, id);
    expect(ok).toBe(true); await page.waitForTimeout(500);
    const image = await capture(name);
    await page.evaluate(() => (window as any).__worldGroundPreview.cancelWorldGroundPreview()); await page.waitForTimeout(500);
    return image;
  };
  const greenOnly = await isolate("depth-red", "depth-green-only.png");
  const redOnly = await isolate("depth-green", "depth-red-only.png");
  const red = (a: number[], i: number) => a[i] > 150 && a[i] > a[i + 1] * 1.8 && a[i] > a[i + 2] * 1.8;
  const green = (a: number[], i: number) => a[i + 1] > 100 && a[i + 1] > a[i] * 1.5 && a[i + 1] > a[i + 2] * 1.5;
  const points: Record<string, { x: number; y: number }> = {};
  for (let i = 100 * 400 * 4; i < combined.rgba.length; i += 4) if (red(redOnly.rgba, i) && green(greenOnly.rgba, i)) {
    if (red(combined.rgba, i) && !points.red) points.red = { x: 250 + (i / 4) % 400, y: 450 + Math.floor(i / 4 / 400) };
    if (green(combined.rgba, i) && !points.green) points.green = { x: 250 + (i / 4) % 400, y: 450 + Math.floor(i / 4 / 400) };
  }
  expect(points.red).toBeTruthy(); expect(points.green).toBeTruthy();
  const worlds = await page.evaluate(() => (window as any).__canvasCanonical.nodeData);
  const picks = async () => page.evaluate(points => { const r = (window as any).__bevyRuntime; const generation = r.interactionGeneration(); return Object.fromEntries(Object.entries(points).map(([key, p]: [string, any]) => [key, r.queryModelPick({ generation, ...p, width: 1280, height: 720 })])); }, points);
  const hitsBefore = await picks();
  expect((await sendCommands(page, [{ type: "node.update", nodeId: "depth-red", zIndex: 30, position: { x: 900, y: 550 } }, { type: "node.update", nodeId: "depth-green", zIndex: -30 }])).ok).toBe(true);
  await waitForCommandsSettled(page); await page.waitForTimeout(500);
  const reordered = await capture("depth-reordered.png");
  expect(reordered.rgba.slice(100 * 400 * 4)).toEqual(combined.rgba.slice(100 * 400 * 4));
  const afterWorlds = await page.evaluate(() => (window as any).__canvasCanonical.nodeData);
  for (const node of nodes) expect(afterWorlds[node.id].sharedWorldInstance).toEqual(worlds[node.id].sharedWorldInstance);
  const order = await page.evaluate(() => (window as any).__canvasCanonical.document.nodes.filter((n: any) => n.id.startsWith("depth-")).map((n: any) => ({ id: n.id, zIndex: n.zIndex })));
  expect(order).toEqual(expect.arrayContaining([{ id: "depth-red", zIndex: 30 }, { id: "depth-green", zIndex: -30 }]));
  const hitsAfter = await picks();
  for (const key of ["red", "green"]) {
    expect(hitsBefore[key].ok).toBe(true);
    expect(hitsAfter[key].ok).toBe(true);
    expect(hitsAfter[key].value).toEqual(hitsBefore[key].value);
  }
  await writeFile(info.outputPath("depth.json"), JSON.stringify({ renderer, wasmSha256: downloaded, prepared, points, order, hitsBefore, hitsAfter }, null, 2));
});
