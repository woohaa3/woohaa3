import { test, expect } from "./review-browser.js";
import { waitForBevyReady } from "./helpers.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("static and dynamic shooting ignore global light while the canvas stays lit", async ({ page }, info) => {
  test.skip(!process.env.WOOHAA_REVIEW_CDP_URL && !process.env.ATC_REVIEW_CDP_URL, "hardware review CDP required");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("./");
  await waitForBevyReady(page);
  await page.keyboard.press("Escape");
  const base = await page.evaluate(() => (window as any).__bevyRuntime.lastScene());
  const frame = page.frames().find(frame => frame.url().includes("renderer.html"))!;
  const hardware = await frame.evaluate(async base => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter || /swiftshader|llvmpipe|lavapipe|basic render/i.test(JSON.stringify(adapter.info))) throw new Error("hardware GPU required");
    const wasm = performance.getEntriesByType("resource").find(row => row.name.includes("_bg.wasm"))!.name;
    const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, "0")).join("");
    const url = performance.getEntriesByType("resource").find(row => row.name.includes("/bevy-wasm/woohaa_bevy_canvas.js"))!.name;
    const mod = await import(/* @vite-ignore */ url);
    const model = JSON.parse(mod.prepare_and_register_model_resource(JSON.stringify({
      resourceVersion: "woohaa-prepared-model-resource-v1", sceneVersion: "woohaa-model-scene-ir-v2", ops: [
        { t: "box", id: "floor", size: [8, .2, 8], position: [0, -.1, 0], color: "#aaaaaa" },
        { t: "group", id: "joint", position: [0, 1.8, 0] },
        { t: "box", id: "cube", parent: "joint", size: [2, 2, 2], position: [0, 0, 0], color: "#dddddd" }
      ]
    })));
    const instance = { id: "target", type: "model", x: -1000, y: -1000, width: 248, height: 232, model,
      chrome: { kind: "none" }, sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "target",
        transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } };
    const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "shooting", settingsVersion: "v1",
      position: { u: -5, v: -5, h: 5 }, rotation: [-.27984814233312133, .11591689595929515, -.3647051996310009, .8804762392171493],
      projection: { kind: "perspective", verticalFovRadians: .9, nearMeters: .1, farMeters: 100 },
      captureMode: { kind: "static" }, aspect: { width: 1, height: 1 }, boundInstanceId: "target" };
    const scene = { ...base, revision: base.revision + 100, nodes: [instance,
      { id: "lens", type: "node", x: 400, y: -450, width: 300, height: 300, worldCamera: camera }],
      edges: [], selection: { nodes: [], edge: null }, viewport: { x: 550, y: 500, zoom: 1 }, globalLightEnabled: true,
      modelFocus: null, modelEditor: null, animationPlayback: null, worldCameraEdit: null };
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const submit = async () => { scene.revision++; mod.set_scene(JSON.stringify(scene)); await delay(500); };
    let requestId = 900;
    const capture = async () => {
      const id = ++requestId;
      mod.request_world_capture(JSON.stringify({ requestId: id, generation: 1, cameraId: "shooting", width: 384, height: 384 }));
      for (let i = 0; i < 1000; i++) {
        await delay(16);
        const bytes: Uint8Array = mod.poll_world_capture(id, 1);
        if (!bytes.length) continue;
        if (new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(8, true)) throw new Error(new TextDecoder().decode(bytes.slice(12)));
        return bytes.slice(12);
      }
      throw new Error("capture timed out");
    };
    const png = async (bytes: Uint8Array) => {
      const canvas = new OffscreenCanvas(384, 384);
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(bytes), 384, 384), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return [...new Uint8Array(await blob.arrayBuffer())];
    };
    (window as any).shootingEvidence = { scene, camera, model, submit, capture, digest, png, delay };
    await submit();
    await delay(1200);
    return { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      wasmSha256: await digest(new Uint8Array(await (await fetch(wasm)).arrayBuffer())) };
  }, base);
  expect(hardware.wasmSha256).toBe(createHash("sha256").update(await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url))).digest("hex"));
  const clip = { x: 230, y: 180, width: 620, height: 550 };
  const before = await page.screenshot({ path: info.outputPath("canvas-before.png"), clip });
  const staticResult = await frame.evaluate(async () => {
    const e = (window as any).shootingEvidence;
    const boundOn = await e.capture();
    e.scene.globalLightEnabled = false; await e.submit();
    const boundOff = await e.capture();
    e.camera.boundInstanceId = null; await e.submit();
    const worldOff = await e.capture();
    e.scene.globalLightEnabled = true; await e.submit();
    const worldOn = await e.capture();
    const result = { boundOn: await e.digest(boundOn), boundOff: await e.digest(boundOff),
      worldOn: await e.digest(worldOn), worldOff: await e.digest(worldOff),
      on: await e.png(worldOn), off: await e.png(worldOff) };
    return result;
  });
  expect(staticResult.boundOn).toBe(staticResult.boundOff);
  expect(staticResult.worldOn).toBe(staticResult.worldOff);
  expect(staticResult.worldOn).toBe(staticResult.boundOn);
  await writeFile(info.outputPath("static-global-on.png"), new Uint8Array(staticResult.on));
  await writeFile(info.outputPath("static-global-off.png"), new Uint8Array(staticResult.off));
  const encoderUrl = new URL("src/cordis/plugins/world-cameras/world-camera-video-recorder.ts", String(info.project.use.baseURL)).href;
  // Use the production H.264/MP4 encoder over actual GPU frames. The canvas
  // preference stays on throughout the recording; no canonical data is changed.
  const recording = frame.evaluate(async encoderUrl => {
    const e = (window as any).shootingEvidence;
    const { encodeWorldCameraVideo } = await import(/* @vite-ignore */ encoderUrl);
    e.camera.captureMode = { kind: "dynamic" }; await e.submit();
    e.recording = true;
    const hashes: string[] = [];
    async function* frames() {
      for (let i = 0; i < 8; i++) {
        const rgba = await e.capture(); hashes.push(await e.digest(rgba));
        yield rgba;
        await e.delay(200);
      }
    }
    const result = await encodeWorldCameraVideo({ width: 384, height: 384, fps: 8, frames: frames() });
    e.recording = false;
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    e.video = result.mp4;
    return { frames: result.frames, durationSeconds: result.durationSeconds, hashes, mp4: [...result.mp4], globalLightEnabled: e.scene.globalLightEnabled };
  }, encoderUrl);
  await frame.waitForFunction(() => (window as any).shootingEvidence.recording === true);
  const during = await page.screenshot({ path: info.outputPath("canvas-during.png"), clip });
  const video = await recording;
  expect(video.frames).toBe(8);
  expect(video.durationSeconds).toBe(1);
  expect(video.globalLightEnabled).toBe(true);
  expect(video.hashes.every(hash => hash === staticResult.worldOn)).toBe(true);
  await writeFile(info.outputPath("dynamic.mp4"), new Uint8Array(video.mp4));
  const decoded = await frame.evaluate(async () => {
    const blob = new Blob([(window as any).shootingEvidence.video], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video"); video.muted = true; video.src = url;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("MP4 cannot decode")); });
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  });
  expect(decoded.width).toBe(384);
  expect(decoded.height).toBe(384);
  expect(decoded.duration).toBeCloseTo(1, 1);
  const after = await page.screenshot({ path: info.outputPath("canvas-after.png"), clip });
  // Exact cropped screenshots also cover the main observer's real shadows.
  expect(during.equals(before)).toBe(true);
  expect(after.equals(before)).toBe(true);
  const pose = await frame.evaluate(async () => {
    const e = (window as any).shootingEvidence;
    e.model.partRotations = { joint: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] };
    await e.submit();
    return e.digest(await e.capture());
  });
  expect(pose).not.toBe(staticResult.worldOn);
  await writeFile(info.outputPath("verification.json"), JSON.stringify({ hardware,
    static: { boundOn: staticResult.boundOn, boundOff: staticResult.boundOff, worldOn: staticResult.worldOn, worldOff: staticResult.worldOff },
    video: { ...video, mp4: undefined, decoded }, canvasUnchangedDuringRecording: true, currentPoseChanged: true }, null, 2));
});
