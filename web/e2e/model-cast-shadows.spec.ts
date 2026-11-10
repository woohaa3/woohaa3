import { test, expect } from "./review-browser.js";
import { waitForBevyReady } from "./helpers.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { shadowGlbFixture } from "./model-shadow-fixtures.js";

// Real application renderer, ephemeral render scenes only: no canonical data is changed.
test("hardware canvas shadows and isolated shooting views survive view reuse", async ({ page }, info) => {
  test.skip(!process.env.WOOHAA_REVIEW_CDP_URL && !process.env.ATC_REVIEW_CDP_URL, "hardware review CDP required");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await page.exposeBinding("__shadowCollectGarbage", () => cdp.send("HeapProfiler.collectGarbage"));
  await page.addInitScript(() => {
    const records = new Map<WebGLTexture, { width: number; height: number; layers: number; format: number }>();
    const bound = new Map<number, WebGLTexture>();
    const proto = WebGL2RenderingContext.prototype;
    const bind = proto.bindTexture;
    proto.bindTexture = function(target, texture) { if (texture) bound.set(target, texture); else bound.delete(target); return bind.call(this, target, texture); };
    const remove = proto.deleteTexture;
    proto.deleteTexture = function(texture) { if (texture) records.delete(texture); return remove.call(this, texture); };
    const storage2 = proto.texStorage2D;
    proto.texStorage2D = function(target, levels, format, width, height) { const texture = bound.get(target); if (texture) records.set(texture, { width, height, layers: 1, format }); return storage2.call(this, target, levels, format, width, height); };
    const storage3 = proto.texStorage3D;
    proto.texStorage3D = function(target, levels, format, width, height, layers) { const texture = bound.get(target); if (texture) records.set(texture, { width, height, layers, format }); return storage3.call(this, target, levels, format, width, height, layers); };
    // Weak references keep instrumentation from retaining the textures it measures.
    const gpuRecords = new Map<number, { ref: WeakRef<GPUTexture>; width: number; height: number; layers: number; format: GPUTextureFormat }>();
    const gpuIds = new WeakMap<GPUTexture, number>();
    let gpuSequence = 0;
    let gpuUsed = false;
    if (typeof GPUDevice !== "undefined") {
      const create = GPUDevice.prototype.createTexture;
      GPUDevice.prototype.createTexture = function(descriptor) {
        gpuUsed = true;
        const texture = create.call(this, descriptor);
        const id = ++gpuSequence;
        gpuIds.set(texture, id);
        gpuRecords.set(id, { ref: new WeakRef(texture), width: texture.width, height: texture.height, layers: texture.depthOrArrayLayers, format: texture.format });
        return texture;
      };
      const destroy = GPUTexture.prototype.destroy;
      GPUTexture.prototype.destroy = function() { gpuRecords.delete(gpuIds.get(this)!); return destroy.call(this); };
    }
    (window as any).__shadowTextureStats = () => {
      for (const [id, row] of gpuRecords) if (!row.ref.deref()) gpuRecords.delete(id);
      return gpuUsed
        ? { backend: "webgpu", textures: gpuRecords.size, shadowMaps: [...gpuRecords.values()].filter(row => row.width === 2048 && row.height === 2048 && row.format.startsWith("depth")).map(({ ref, ...row }) => row) }
        : { backend: "webgl2", textures: records.size, shadowMaps: [...records.values()].filter(row => row.width === 2048 && row.height === 2048 && [33189, 33190, 36012].includes(row.format)) };
    };
  });
  const wasmResponse = page.waitForResponse(response => response.url().includes("_bg.wasm") && response.ok());
  await page.goto(process.env.WOOHAA_SHADOW_REVIEW_URL ?? "/");
  await waitForBevyReady(page);
  await page.keyboard.press("Escape");
  const wasmUrl = (await wasmResponse).url();
  const wasmSha256 = await page.evaluate(async url => {
    const bytes = await (await fetch(url)).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
  }, wasmUrl);
  const built = await readFile(new URL("../frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm", import.meta.url));
  expect(wasmSha256).toBe(createHash("sha256").update(built).digest("hex"));
  const base = await page.evaluate(() => (window as any).__bevyRuntime.lastScene());
  const frame = page.frames().find(frame => frame.url().includes("renderer.html"));
  expect(frame).toBeTruthy();
  const result = await frame!.evaluate(async ({ base, glb }) => {
    const realm = window as any;
    const url = performance.getEntriesByType("resource").map(row => row.name)
      .find(url => url.includes("/bevy-wasm/woohaa_bevy_canvas.js"))!;
    const mod = await import(/* @vite-ignore */ url);
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    let renderer = ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    if (!renderer && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      renderer = adapter && `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`;
    }
    if (!renderer || /swiftshader|llvmpipe|lavapipe|basic render/i.test(renderer)) throw new Error(`hardware GPU required: ${renderer}`);
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const box = (id: string, size: number[], position: number[], color = "#aaaaaa") => ({ t: "box", id, size, position, color });
    const register = (ops: unknown[]) => JSON.parse(mod.prepare_and_register_model_resource(JSON.stringify({
      resourceVersion: "woohaa-prepared-model-resource-v1", sceneVersion: "woohaa-model-scene-ir-v2", ops,
    })));
    const targetOps = [
      box("floor", [8, .2, 8], [0, -.1, 0]),
      { t: "group", id: "joint", position: [0, 1.8, 0] },
      { ...box("cube", [1.4, 1.4, 1.4], [0, 0, 0], "#dddddd"), parent: "joint" },
    ];
    const target = register(targetOps);
    const blocker = register([box("blocker", [3, 1, 3], [1.5, 3.3, 1.5], "#aa2222")]);
    const instance = (id: string, model: unknown) => ({
      id, type: "model", x: -1000, y: -1000, width: 248, height: 232, model,
      sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id,
        transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } },
    });
    const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "shadow-cam", settingsVersion: "v1",
      position: { u: -5, v: -5, h: 5 }, rotation: [-.27984814233312133, .11591689595929515, -.3647051996310009, .8804762392171493],
      projection: { kind: "perspective", verticalFovRadians: .9, nearMeters: .1, farMeters: 100 },
      captureMode: { kind: "static" }, aspect: { width: 1, height: 1 }, boundInstanceId: "target" };
    const lens = { id: "shadow-camera", type: "node", x: 200, y: -400, width: 300, height: 300, worldCamera: camera };
    const scene = { ...base, revision: base.revision + 100, nodes: [instance("target", target), instance("blocker", blocker), lens],
      edges: [], viewport: { x: 640, y: 450, zoom: 1 }, modelFocus: null, animationPlayback: null, worldCameraEdit: null };
    let revision = scene.revision;
    const submit = async () => { scene.revision = ++revision; mod.set_scene(JSON.stringify(scene)); await delay(700); };
    let requestId = 0;
    const capture = async () => {
      const id = ++requestId;
      mod.request_world_capture(JSON.stringify({ requestId: id, generation: 1, cameraId: "shadow-cam", width: 384, height: 384 }));
      for (let i = 0; i < 2000; i++) {
        await delay(16);
        const bytes: Uint8Array = mod.poll_world_capture(id, 1);
        if (!bytes.length) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
        if (view.getUint32(8, true)) throw new Error(new TextDecoder().decode(bytes.slice(12)));
        return bytes.slice(12);
      }
      throw new Error("world capture timed out");
    };
    const png = async (rgba: Uint8Array) => {
      const canvas = new OffscreenCanvas(384, 384), ctx = canvas.getContext("2d")!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), 384, 384), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(blob); });
    };
    const difference = (a: Uint8Array, b: Uint8Array) => {
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) changed++;
      return changed;
    };
    await submit();
    await delay(2000);
    const boundWithBlocker = await capture();
    scene.nodes = [instance("target", target), lens];
    await submit();
    const boundAlone = await capture();
    camera.boundInstanceId = null as any;
    scene.nodes = [instance("target", target), instance("blocker", blocker), lens];
    await submit();
    const world = await capture();
    // Restore the binding after a whole-world capture and lease release.
    camera.boundInstanceId = "target";
    await submit();
    const rebound = await capture();
    // Current joint pose reaches the same real geometry in preview and capture.
    (scene.nodes[0] as any).model.partRotations = { joint: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] };
    await submit();
    const animated = await capture();
    delete (scene.nodes[0] as any).model.partRotations;
    const fps = async () => {
      mod.set_idle_frame_pacing(false);
      const times: number[] = [];
      let previous = performance.now();
      for (let i = 0; i < 180; i++) await new Promise<void>(resolve => requestAnimationFrame(now => { if (i > 0) times.push(now - previous); previous = now; resolve(); }));
      times.sort((a, b) => a - b);
      return { samples: times.length, p50: times[Math.floor(times.length * .5)], p95: times[Math.floor(times.length * .95)] };
    };
    const gpuTiming = async () => {
      if (!gl) return { unavailable: "WebGPU timestamp queries are not instrumented by this fixture" };
      const extension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (!extension) return { unavailable: "EXT_disjoint_timer_query_webgl2 unavailable" };
      const times: number[] = [];
      for (let sample = 0; sample < 20; sample++) {
        const query = gl.createQuery()!;
        const before = JSON.parse(mod.runtime_health()).renders;
        gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
        for (let frame = 0; frame < 120; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (JSON.parse(mod.runtime_health()).renders > before) break;
        }
        gl.endQuery(extension.TIME_ELAPSED_EXT);
        for (let i = 0; i < 120 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); i++) await delay(16);
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(extension.GPU_DISJOINT_EXT)) {
          times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        }
        gl.deleteQuery(query);
      }
      times.sort((a, b) => a - b);
      return times.length ? { samples: times.length, p50: times[Math.floor(times.length * .5)], p95: times[Math.floor(times.length * .95)], unit: "ms GPU elapsed across an observed Bevy render" }
        : { unavailable: "GPU disjoint or query results unavailable" };
    };
    scene.nodes = [instance("target", target), lens];
    await submit();
    const single = await fps();
    const singleGpu = await gpuTiming();
    await realm.__shadowCollectGarbage();
    const singleResources = realm.__shadowTextureStats();
    const many: any[] = [];
    for (let i = 0; i < 16; i++) {
      const id = `many-${i}`;
      many.push(instance(id, target), { ...lens, id: `lens-${i}`, x: -600 + (i % 4) * 250, y: -400 + Math.floor(i / 4) * 200,
        width: 220, height: 180, worldCamera: { ...camera, cameraId: `camera-${i}`, boundInstanceId: id } });
    }
    scene.nodes = many;
    await submit();
    await delay(1500);
    const multiple = await fps();
    const multipleGpu = await gpuTiming();
    await realm.__shadowCollectGarbage();
    const diagnostics = JSON.parse(mod.canvas_work_diagnostics());
    const multipleResources = realm.__shadowTextureStats();
    scene.nodes = [instance("target", target), lens];
    await submit();
    const afterCollapse = await capture();
    const collapsedResources = realm.__shadowTextureStats();
    const reuseResources: unknown[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      scene.nodes = many;
      await submit();
      scene.nodes = [instance("target", target), lens];
      await submit();
      await realm.__shadowCollectGarbage();
      reuseResources.push(realm.__shadowTextureStats());
    }
    const floor = box("floor", [8, .2, 8], [0, -.1, 0]);
    const matrix: Record<string, Uint8Array> = {};
    const materialCase = async (name: string, ops: unknown[]) => {
      scene.nodes = [instance("target", register([floor, ...ops])), lens];
      await submit();
      matrix[name] = await capture();
    };
    await materialCase("floor-only", []);
    await materialCase("transparent", [
      { t: "material", id: "clear", alphaMode: "blend", opacity: 0 },
      { ...box("clear-caster", [2, 2, 2], [0, 2, 0]), material: "clear" },
    ]);
    await materialCase("unlit", [
      { t: "material", id: "flat", baseColor: "#dddddd", unlit: true },
      { ...box("flat-caster", [2, 2, 2], [0, 2, 0]), material: "flat" },
    ]);
    await materialCase("blend", [
      { t: "material", id: "glass", baseColor: "#dddddd", alphaMode: "blend", opacity: .4 },
      { ...box("glass-caster", [2, 2, 2], [0, 2, 0]), material: "glass" },
    ]);
    await materialCase("glb-double-sided", glb.ops);
    scene.nodes = [instance("target", target), lens];
    const nearPosition = { ...camera.position };
    camera.position = { u: -15, v: -15, h: 15 };
    await submit();
    matrix.distant = await capture();
    camera.position = nearPosition;
    scene.nodes = [lens];
    await submit();
    let missingBindingFailed = false;
    try { await capture(); } catch { missingBindingFailed = true; }
    scene.nodes = [instance("target", target), lens];
    await submit();
    const restored = await capture();
    const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");
    realm.shadowEvidence = { scene, submit, mod, register };
    return { renderer, single, multiple, singleGpu, multipleGpu, singleResources, multipleResources, collapsedResources, reuseResources, diagnostics,
      recovery: { scene, targetOps, hash: await hash(restored) }, missingBindingFailed, glbStats: glb.stats,
      differences: { isolated: difference(boundWithBlocker, boundAlone), rebound: difference(boundWithBlocker, rebound), world: difference(boundAlone, world), animated: difference(boundAlone, animated), collapsed: difference(boundAlone, afterCollapse), restored: difference(boundAlone, restored), transparent: difference(matrix["floor-only"], matrix.transparent) },
      images: { bound: await png(boundWithBlocker), world: await png(world), animated: await png(animated),
        ...Object.fromEntries(await Promise.all(Object.entries(matrix).map(async ([name, bytes]) => [name, await png(bytes)]))) } };
  }, { base, glb: shadowGlbFixture() });
  await writeFile(info.outputPath("hardware.json"), JSON.stringify({ ...result, wasmSha256, images: undefined }, null, 2));
  expect(result.renderer).toMatch(/NVIDIA|AMD|Apple|Intel/i);
  for (const stats of result.reuseResources as Array<{ textures: number }>) expect(stats.textures).toBeLessThanOrEqual(result.multipleResources.textures + 3);
  expect(result.differences.isolated).toBeLessThan(5);
  expect(result.differences.rebound).toBeLessThan(5);
  expect(result.differences.world).toBeGreaterThan(1000);
  expect(result.differences.collapsed).toBeLessThan(5);
  expect(result.differences.animated).toBeGreaterThan(100);
  expect(result.differences.restored).toBeLessThan(5);
  expect(result.differences.transparent).toBeLessThan(5);
  expect(result.missingBindingFailed).toBe(true);
  for (const [name, encoded] of Object.entries(result.images)) await writeFile(info.outputPath(`${name}.png`), Buffer.from(encoded, "base64"));
  // This is the default orthographic observer, not the offset capture camera.
  // Keep explicit evidence: headlight-aligned shadows were hidden in this view.
  await page.screenshot({ path: info.outputPath("main-canvas.png") });
  await page.screenshot({ path: info.outputPath("application.png") });
  // Normal Pad window and the existing focus/editor paths use the same plugin.
  await page.setViewportSize({ width: 1024, height: 768 });
  await frame!.evaluate(async () => {
    const { scene, submit } = (window as any).shadowEvidence;
    scene.worldCameraEdit = { nodeId: "shadow-camera", camera: scene.nodes[1].worldCamera };
    await submit();
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath("pad-camera-editor.png") });
  await frame!.evaluate(async () => {
    const { scene, submit } = (window as any).shadowEvidence;
    scene.worldCameraEdit = null;
    scene.modelFocus = { version: "woohaa-model-focus-v1", nodeId: "target", target: [0, 64, 0], yaw: -.785, pitch: -.615, distance: 600, fov: .9, radius: 400 };
    scene.theme = structuredClone(scene.theme);
    scene.theme.id = "shadow-review-dark";
    scene.theme.tokens.webBackdrop = "#181818";
    scene.theme.tokens.canvasNodeContent = "#181818";
    await submit();
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath("pad-focus-dark.png") });
  const previewLarge = await frame!.evaluate(async () => {
    const { scene, submit, mod, register } = (window as any).shadowEvidence;
    const model = register([
      { t: "box", id: "floor", size: [8, .2, 8], position: [0, -.1, 0], color: "#aaaaaa" },
      ...Array.from({ length: 12 }, (_, i) => ({ t: "sphere", id: `sphere-${i}`, radius: .4,
        position: [-1.5 + (i % 4), 1, -1 + Math.floor(i / 4)], color: "#dddddd" })),
    ]);
    scene.modelFocus = null;
    scene.nodes = [{ id: "preview", type: "model", x: -200, y: -200, width: 420, height: 380,
      model, modelPreview: { azimuth: .7, elevation: .6, distanceScale: 1 } }];
    await submit();
    return JSON.parse(mod.canvas_work_diagnostics()).models;
  });
  await page.screenshot({ path: info.outputPath("pad-preview-spatial-large.png") });
  const previewLow = await frame!.evaluate(async () => {
    const { scene, submit, mod } = (window as any).shadowEvidence;
    scene.nodes[0].width = 90;
    scene.nodes[0].height = 80;
    await submit();
    return JSON.parse(mod.canvas_work_diagnostics()).models;
  });
  await page.screenshot({ path: info.outputPath("pad-preview-spatial-low.png") });
  await writeFile(info.outputPath("preview-lod.json"), JSON.stringify({ large: previewLarge, low: previewLow }, null, 2));
  expect(previewLarge.batchedParts).toBeGreaterThan(0);
  expect(previewLow.low).toBeGreaterThan(0);
  // A page reload destroys the iframe/WASM device. Restore only current scene data.
  await page.reload();
  await waitForBevyReady(page);
  const rebuilt = page.frames().find(frame => frame.url().includes("renderer.html"))!;
  const rebuiltHash = await rebuilt.evaluate(async ({ scene, targetOps }) => {
    const url = performance.getEntriesByType("resource").map(row => row.name).find(url => url.includes("/bevy-wasm/woohaa_bevy_canvas.js"))!;
    const mod = await import(/* @vite-ignore */ url);
    scene.nodes[0].model = JSON.parse(mod.prepare_and_register_model_resource(JSON.stringify({
      resourceVersion: "woohaa-prepared-model-resource-v1", sceneVersion: "woohaa-model-scene-ir-v2", ops: targetOps,
    })));
    scene.revision += 1000;
    mod.set_scene(JSON.stringify(scene));
    await new Promise(resolve => setTimeout(resolve, 1500));
    mod.request_world_capture(JSON.stringify({ requestId: 501, generation: 1, cameraId: "shadow-cam", width: 384, height: 384 }));
    for (let i = 0; i < 2000; i++) {
      await new Promise(resolve => setTimeout(resolve, 16));
      const bytes: Uint8Array = mod.poll_world_capture(501, 1);
      if (!bytes.length) continue;
      if (new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(8, true)) throw new Error(new TextDecoder().decode(bytes.slice(12)));
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice(12)))].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    throw new Error("rebuilt renderer capture timed out");
  }, result.recovery);
  expect(rebuiltHash).toBe(result.recovery.hash);
  await writeFile(info.outputPath("renderer-rebuild.json"), JSON.stringify({ before: result.recovery.hash, after: rebuiltHash }, null, 2));
});
