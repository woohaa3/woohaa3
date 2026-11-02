/**
 * Bevy 运行时 glue：模型资源注册与「先注册资源、后提交引用场景」顺序
 * （change: optimize-model-scene-snapshot-hot-path，任务 2.5 / 4.1）。
 *
 * 用 mock WASM 模块验证：幂等上传、注册失败隔离、重启清表与恢复时的调用顺序。
 * descriptor 与 payload 分离的用例见 `bevy-runtime-payload.test.ts`（同一份 harness）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_VIEWPORT_UPDATE_VERSION, CANVAS_OBSERVER_UPDATE_VERSION, MODEL_FOCUS_VERSION, DEFAULT_MODEL_PREVIEW, prepareModelResource, type CanvasRenderScene } from "@woohaa3/contracts";
import { loadBevyRuntime, frameCountersReadable } from "./bevy-runtime.js";
import { resetSceneDiagnostics, sceneDiagnostics } from "./scene-diagnostics.js";
import { mockModule, sceneWith, v2Ops, type Calls } from "./test-support/runtime-harness.js";

beforeEach(() => {
  resetSceneDiagnostics();
});

it("开发帧计数读取 Bevy render 完成数，旧模块与销毁实例不伪造帧数", async () => {
  const module = mockModule([]);
  let renders = 12;
  module.runtime_health = () => JSON.stringify({ version: "woohaa-runtime-health-v1", renders, updates: 15,
    appliedRevision: 1, appliedGeneration: 1, renderedGeneration: 1 });
  const runtime = await loadBevyRuntime({ importModule: async () => module });
  expect(runtime.getFrameCounters!()).toEqual({ generation: runtime.generation(), renders: 12, updates: 15 });
  renders = 72;
  expect(runtime.getFrameCounters!()?.renders).toBe(72);
  const health = module.runtime_health;
  for (const draws of [0, 321, null, -1, "321", 1.5]) {
    module.runtime_health = () => JSON.stringify({ ...JSON.parse(health()), drawCalls3d: draws });
    const counters = runtime.getFrameCounters!();
    expect(counters?.renders).toBe(72);
    expect(counters?.drawCalls3d).toBe(typeof draws === "number" && Number.isSafeInteger(draws) && draws >= 0 ? draws : undefined);
  }
  module.runtime_health = () => "{}";
  expect(runtime.getFrameCounters!()).toBeUndefined();
  delete module.runtime_health;
  expect(runtime.getFrameCounters!()).toBeUndefined();
  runtime.dispose();
  expect(runtime.getFrameCounters!()).toBeUndefined();
});

it("帧计数门禁：开发构建与桌面壳开放，浏览器生产构建不开放", () => {
  const desktop = { __WOOHAA_NATIVE__: { protocol: "woohaa-native-v1", token: "t" } } as unknown as typeof globalThis;
  // 打包桌面版按 `--mode desktop` 生产构建（dev=false），仍要能读 FPS/DC。
  expect(frameCountersReadable(false, desktop)).toBe(true);
  expect(frameCountersReadable(true, desktop)).toBe(true);
  // 浏览器生产 / preview 构建：不暴露帧计数。
  expect(frameCountersReadable(false, {} as typeof globalThis)).toBe(false);
  expect(frameCountersReadable(true, {} as typeof globalThis)).toBe(true);
  // 判定与原生 realm 选择同口径：只看宿主是否注入了 `__WOOHAA_NATIVE__`。
  expect(frameCountersReadable(false, { __WOOHAA_NATIVE__: undefined } as never)).toBe(false);
});

it("页面切换创建独立的模块与问题状态，旧 renderer 的故障不会带入新画布", async () => {
  const firstCalls: Calls = []; const nextCalls: Calls = [];
  const outgoing = await loadBevyRuntime({ importModule: async () => mockModule(firstCalls) });
  outgoing.reportRuntimeIssue!({ key: "old-texture", scope: "texture", operation: "upload",
    nodeId: "old-node", recoverable: true, message: "旧素材上传失败", detail: "old failure" });
  outgoing.dispose();
  const incoming = await loadBevyRuntime({ importModule: async () => mockModule(nextCalls) });
  expect(incoming).not.toBe(outgoing);
  expect(outgoing.isReady()).toBe(false);
  expect(incoming.isReady()).toBe(true);
  expect(incoming.getRuntimeIssues!()).toEqual([]);
  incoming.setScene(sceneWith("k", "s"));
  expect(firstCalls.filter(call => call.kind === "set_scene")).toHaveLength(0);
  expect(nextCalls.filter(call => call.kind === "set_scene")).toHaveLength(1);
  incoming.dispose();
});

describe("Bevy runtime interaction queries（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）", () => {
  it("旧 generation 查询返回 stale 且不返回旧几何", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    // 尚未接受任何场景。
    expect(runtime.interactionGeneration!()).toBe(0);
    const before = runtime.queryPoint!({ generation: 0, x: 10, y: 10, zoom: 1 });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toBe("unavailable");

    runtime.setScene(sceneWith("k", "s"));
    expect(runtime.interactionGeneration!()).toBe(1);
    // 传入旧 generation → stale。
    const stale = runtime.queryPoint!({ generation: 0, x: 10, y: 10, zoom: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale");
  });

  it("WASM 重启后 interaction generation 从 0 重新开始", async () => {
    const runtimeA = await loadBevyRuntime({ importModule: async () => mockModule([]) });
    runtimeA.setScene(sceneWith("k", "s"));
    expect(runtimeA.interactionGeneration!()).toBe(1);
    const runtimeB = await loadBevyRuntime({ importModule: async () => mockModule([]) });
    expect(runtimeB.interactionGeneration!()).toBe(0);
  });

  it("非法 scene 不推进 interaction generation（保留最近合法索引）", async () => {
    const calls: Calls = [];
    const module = mockModule(calls);
    module.set_scene = (json: string) => {
      if (json.includes("\"bad\"")) throw new Error("Invalid viewport zoom");
      calls.push({ kind: "set_scene", value: json });
      return 1;
    };
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    runtime.setScene(sceneWith("k", "s"));
    expect(runtime.interactionGeneration!()).toBe(1);
    // 非法帧抛错：generation 不变。
    const bad = { ...sceneWith("k", "s"), revision: 99, nodes: [{ ...sceneWith("k", "s").nodes[0], body: "bad" }] };
    expect(() => runtime.setScene(bad)).toThrow();
    expect(runtime.interactionGeneration!()).toBe(1);
  });
});

describe("Bevy runtime model resource registration", () => {
  it("模型被 Rust LRU 淘汰后在提交场景前补注册", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const module = mockModule(calls);
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    const scene = sceneWith(resource.resourceKey, resource.signature);
    const resources = new Map([[resource.resourceKey, resource]]);
    runtime.setScene(scene, resources);
    runtime.setModelPayloadLeases!([]);
    module.set_model_payload_leases = request => {
      expect(JSON.parse(request).keys).toEqual([resource.resourceKey]);
      return JSON.stringify({ retained: 0, evicted: 1, evictedKeys: [resource.resourceKey], residentKeys: [] });
    };
    runtime.setModelPayloadLeases!([resource.resourceKey]);
    runtime.setScene(scene, resources);
    expect(calls.filter(call => call.kind === "prepare")).toHaveLength(2);
    expect(calls.slice(-2).map(call => call.kind)).toEqual(["prepare", "set_scene"]);
  });
  it("先注册资源、后提交引用场景，且同一 key 幂等只上传一次", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    runtime.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));
    runtime.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));

    const registerIndex = calls.findIndex((call) => call.kind === "prepare");
    const submitIndices = calls.map((call, index) => (call.kind === "set_scene" ? index : -1)).filter((index) => index >= 0);
    expect(registerIndex).toBeGreaterThanOrEqual(0);
    // 每次 set_scene 之前都已完成资源注册。
    expect(registerIndex).toBeLessThan(submitIndices[0]);
    // 相同 key 只注册一次。
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);
    expect(sceneDiagnostics.modelRegistrations).toBe(1);
  });

  it("资源缺失仍发布节点卡片；资源到达后自动恢复预览和清除提示", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const scene = sceneWith(resource.resourceKey, resource.signature);
    runtime.setScene(scene, new Map());
    const first = JSON.parse(calls.find((c) => c.kind === "set_scene")!.value);
    expect(first.nodes[0].model).toBeUndefined();
    expect(first.nodes[0].id).toBe("m1");
    expect(runtime.getRenderIssues!()).toMatchObject([{ nodeId: "m1", retainedPreview: false }]);
    runtime.setScene(scene, new Map([[resource.resourceKey, resource]]));
    expect(runtime.getRenderIssues!()).toEqual([]);
    expect(JSON.parse(calls.filter((c) => c.kind === "set_scene").at(-1)!.value).nodes[0].model.resourceKey).toBe(resource.resourceKey);
  });

  it("失败资源只尝试一次，缩放/平移仍被接受；重试成功后自动清除提示", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const module = mockModule(calls, { failRegister: true });
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    const resources = new Map([[resource.resourceKey, resource]]);
    const scene = sceneWith(resource.resourceKey, resource.signature);
    runtime.setScene(scene, resources);
    runtime.setScene({ ...scene, viewport: { x: 80, y: 30, zoom: 0.6 } }, resources);
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);
    const submitted = calls.filter((call) => call.kind === "set_scene");
    expect(submitted).toHaveLength(2);
    expect(JSON.parse(submitted[1].value).viewport).toEqual({ x: 80, y: 30, zoom: 0.6 });
    expect(runtime.interactionGeneration!()).toBe(2);
    const subscribe = vi.fn();
    const unsubscribe = runtime.subscribeRenderIssues!(subscribe);
    module.prepare_and_register_model_resource = mockModule(calls).prepare_and_register_model_resource;
    runtime.retryFailedModels!();
    runtime.setScene(scene, resources);
    expect(runtime.getRenderIssues!()).toEqual([]);
    expect(subscribe).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("新模型失败时保留旧预览并继续发布其它节点，内容修改后可恢复", async () => {
    const calls: Calls = [];
    const old = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const next = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(2) });
    const healthy = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(3) });
    const module = mockModule(calls);
    const register = module.prepare_and_register_model_resource!;
    module.prepare_and_register_model_resource = (json) => {
      if (JSON.parse(json).expectedSignature === next.signature) throw new Error("Model resource payload too large");
      return register(json);
    };
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    runtime.setScene(sceneWith(old.resourceKey, old.signature), new Map([[old.resourceKey, old]]));
    const scene = sceneWith(next.resourceKey, next.signature);
    scene.nodes.push({ ...scene.nodes[0], id: "healthy", model: { ...scene.nodes[0].model!, resourceKey: healthy.resourceKey, signature: healthy.signature } });
    runtime.setScene(scene, new Map([[next.resourceKey, next], [healthy.resourceKey, healthy]]));
    const accepted = JSON.parse(calls.filter((c) => c.kind === "set_scene").at(-1)!.value);
    expect(accepted.nodes[0].model.resourceKey).toBe(old.resourceKey);
    expect(accepted.nodes[1].model.resourceKey).toBe(healthy.resourceKey);
    expect(runtime.getRenderIssues!()).toMatchObject([{ nodeId: "m1", retainedPreview: true, message: expect.stringContaining("超过预览容量") }]);
    runtime.setScene(sceneWith(healthy.resourceKey, healthy.signature), new Map([[healthy.resourceKey, healthy]]));
    expect(runtime.getRenderIssues!()).toEqual([]);
  });

  it("prepared-and-register 边界派生并注册（单一注册边界）", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    runtime.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);
    // 先准备/注册，后提交引用场景。
    expect(calls.findIndex((call) => call.kind === "prepare")).toBeLessThan(
      calls.findIndex((call) => call.kind === "set_scene")
    );
  });

  it("模型资源 key 不一致时隔离该模型并提示，不阻断画布", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const module = mockModule(calls);
    module.prepare_and_register_model_resource = () =>
      JSON.stringify({
        resourceVersion: "woohaa-prepared-model-resource-v1",
        resourceKey: "v2:different",
        sceneVersion: "woohaa-model-scene-ir-v2",
        signature: "different",
        extent: 2,
        aabb: null
      });
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    runtime.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));
    expect(runtime.getRenderIssues!()[0].detail).toMatch(/模型资源 key 不一致/);
    expect(calls.filter((call) => call.kind === "set_scene")).toHaveLength(1);
  });

  it("新 runtime generation 清空已注册集合，恢复时按顺序重放资源", async () => {
    const first: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const runtimeA = await loadBevyRuntime({ importModule: async () => mockModule(first) });
    const generationA = runtimeA.generation();
    runtimeA.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));

    // 模拟页面切换：释放旧 runtime 后重新装载（新 generation）。
    runtimeA.dispose();
    const second: Calls = [];
    const runtimeB = await loadBevyRuntime({ importModule: async () => mockModule(second) });
    expect(runtimeB.generation()).toBeGreaterThan(generationA);
    runtimeB.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));
    // 新 generation 必须重新注册（清表后重放）。
    expect(second.filter((call) => call.kind === "prepare")).toHaveLength(1);
    expect(second.findIndex((call) => call.kind === "prepare")).toBeLessThan(
      second.findIndex((call) => call.kind === "set_scene")
    );
  });
});

describe("Bevy runtime viewport capability（change: 2026-10-10-optimize-canvas-interaction-hot-path）", () => {
  it("缺少 set_viewport/base_scene_generation/viewport_capability 时初始化明确失败", async () => {
    const module = mockModule([]);
    delete module.set_viewport;
    await expect(loadBevyRuntime({ importModule: async () => module })).rejects.toThrow(/缺少必需能力/);
  });

  it("viewport 能力版本不匹配时明确失败（不静默回退旧接口）", async () => {
    const module = mockModule([]);
    module.viewport_capability = () => "woohaa-canvas-viewport-v0";
    await expect(loadBevyRuntime({ importModule: async () => module })).rejects.toThrow(/视口能力不匹配/);
  });

  it("缺少 scene_capability 或场景 wire 版本不匹配时初始化明确失败（change: 2026-10-15-add-film-set-overview-lod）", async () => {
    const missing = mockModule([]);
    delete missing.scene_capability;
    await expect(loadBevyRuntime({ importModule: async () => missing })).rejects.toThrow(/scene_capability/);
    const stale = mockModule([]);
    stale.scene_capability = () => "woohaa-canvas-render-scene-v36";
    await expect(loadBevyRuntime({ importModule: async () => stale })).rejects.toThrow(
      /场景能力不匹配：woohaa-canvas-render-scene-v36 != woohaa-canvas-render-scene-v37/
    );
  });

  it("缺少 drop 目标查询时初始化明确失败", async () => {
    const module = mockModule([]);
    delete module.query_drop_target;
    await expect(loadBevyRuntime({ importModule: async () => module })).rejects.toThrow(/缺少必需能力/);
  });

  it("setViewport 用 base 身份提交增量并推进 interaction generation，不改 base", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    runtime.setScene(sceneWith("k", "s"));
    expect(runtime.baseSceneGeneration!()).toBe(1);
    const generation = runtime.setViewport!({ baseSceneGeneration: runtime.baseSceneGeneration!(), viewport: { x: 10, y: 20, zoom: 1.5 } });
    expect(generation).toBe(2);
    // 纯视口不改 base 身份。
    expect(runtime.baseSceneGeneration!()).toBe(1);
    const sent = JSON.parse(calls.filter((c) => c.kind === "set_viewport").at(-1)!.value) as {
      version: string;
      baseSceneGeneration: number;
      viewport: { x: number; y: number; zoom: number };
    };
    expect(sent.version).toBe(CANVAS_VIEWPORT_UPDATE_VERSION);
    expect(sent.baseSceneGeneration).toBe(1);
    expect(sent.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(sceneDiagnostics.viewportSubmits).toBe(1);
    expect((globalThis as unknown as { __bevyRuntime: { lastScene(): CanvasRenderScene } }).__bevyRuntime.lastScene().viewport).toEqual(sent.viewport);
    expect(calls.filter(c => c.kind === "set_scene")).toHaveLength(1);
  });

  it("未接受完整场景（base=0）时 setViewport 被拒绝，保留合法画面", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    expect(() => runtime.setViewport!({ baseSceneGeneration: 0, viewport: { x: 0, y: 0, zoom: 1 } })).toThrow();
    expect(calls.filter((c) => c.kind === "set_viewport")).toHaveLength(0);
  });

  it("native 排队期间不发布接受代数或视口，真实回调后才更新镜像", async () => {
    const calls: Calls = []; const module = mockModule(calls);
    let accept!: (generation: number) => void;
    module.queue_viewport = vi.fn((_json, accepted) => { accept = accepted; });
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    runtime.setScene(sceneWith("k", "s"));
    const viewport = { x: 10, y: 20, zoom: 1.5 };
    runtime.queueViewport!({ baseSceneGeneration: 1, viewport });
    const mirror = () => (globalThis as unknown as { __bevyRuntime: { lastScene(): CanvasRenderScene } }).__bevyRuntime.lastScene();
    expect(runtime.interactionGeneration!()).toBe(1);
    expect(mirror().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(calls.filter(call => call.kind === "set_viewport")).toHaveLength(0);
    viewport.x = 1000; accept(2);
    expect(runtime.interactionGeneration!()).toBe(2);
    expect(runtime.baseSceneGeneration!()).toBe(1);
    expect(mirror().viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
    runtime.dispose(); accept(3);
    expect(runtime.interactionGeneration!()).toBe(2);
  });

  it("缺少 set_observer 时仍可装载，调度器视为无观察镜头增量", async () => {
    const module = mockModule([]);
    delete module.set_observer;
    delete module.observer_capability;
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    expect(runtime.setObserver).toBeUndefined();
  });

  it("setObserver 用 base 身份提交增量并推进 interaction generation，不改 base", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const scene = {
      ...sceneWith("k", "s"),
      modelFocus: {
        version: MODEL_FOCUS_VERSION, nodeId: "m1", target: [0, 0, 0] as [number, number, number],
        yaw: 0.1, pitch: -0.2, distance: 4, fov: 0.8, radius: 1
      },
      nodes: sceneWith("k", "s").nodes.map(node => node.id === "m1" ? { ...node, modelPreview: { ...DEFAULT_MODEL_PREVIEW } } : node)
    };
    runtime.setScene(scene);
    const generation = runtime.setObserver!({
      baseSceneGeneration: runtime.baseSceneGeneration!(),
      nodeId: "m1",
      preview: { ...DEFAULT_MODEL_PREVIEW, azimuth: 1.2 },
      yaw: 0.8, pitch: -0.3, distance: 5, target: [1, 2, 3]
    });
    expect(generation).toBe(2);
    expect(runtime.baseSceneGeneration!()).toBe(1);
    expect(sceneDiagnostics.observerSubmits).toBe(1);
    const sent = JSON.parse(calls.filter(c => c.kind === "set_observer").at(-1)!.value);
    expect(sent.version).toBe(CANVAS_OBSERVER_UPDATE_VERSION);
    expect(sent.nodeId).toBe("m1");
    const mirrored = (globalThis as unknown as { __bevyRuntime: { lastScene(): CanvasRenderScene } }).__bevyRuntime.lastScene();
    expect(mirrored.modelFocus).toMatchObject({ nodeId: "m1", yaw: 0.8, distance: 5, target: [1, 2, 3] });
    expect(mirrored.nodes.find(node => node.id === "m1")?.modelPreview?.azimuth).toBe(1.2);
  });
});

describe("Bevy runtime position capability", () => {
  it("rejects missing or mismatched position capability", async () => {
    const module = mockModule([]);
    delete module.set_positions;
    await expect(loadBevyRuntime({ importModule: async () => module })).rejects.toThrow(/set_positions/);
    const wrong = mockModule([]);
    wrong.position_capability = () => "wrong";
    await expect(loadBevyRuntime({ importModule: async () => wrong })).rejects.toThrow(/位置能力不匹配/);
  });

  it("interleaves position/viewport/full, preserves base and never re-registers resources", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const original = sceneWith("k", "s");
    runtime.setScene(original);
    const base = runtime.baseSceneGeneration!();
    expect(runtime.setPositions!({ baseSceneGeneration: base, positions: [{ id: "m1", x: 50, y: 60 }], viewport: { x: 10, y: 20, zoom: 2 } })).toBe(2);
    expect(runtime.interactionGeneration!()).toBe(2);
    expect(runtime.baseSceneGeneration!()).toBe(base);
    const mirror = () => (globalThis as unknown as { __bevyRuntime: { lastScene(): CanvasRenderScene } }).__bevyRuntime.lastScene();
    expect(mirror().nodes[0]).toMatchObject({ x: 50, y: 60 });
    expect(original.nodes[0]).toMatchObject({ x: 0, y: 0 });
    runtime.setViewport!({ baseSceneGeneration: base, viewport: { x: 30, y: 40, zoom: 0.5 } });
    runtime.setPositions!({ baseSceneGeneration: base, positions: [{ id: "m1", x: 0, y: 0 }] });
    expect(mirror().viewport).toEqual({ x: 30, y: 40, zoom: 0.5 });
    expect(sceneDiagnostics.positionSubmits).toBe(2);
    expect(calls.filter(c => c.kind === "prepare")).toHaveLength(0);
    expect(calls.filter(c => c.kind === "set_scene")).toHaveLength(1);
    runtime.setScene(original);
    const generation = runtime.interactionGeneration!();
    expect(() => runtime.setPositions!({ baseSceneGeneration: base, positions: [{ id: "m1", x: 90, y: 90 }] })).toThrow("stale-base");
    expect(runtime.interactionGeneration!()).toBe(generation);
    expect(mirror().nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(sceneDiagnostics.positionSubmits).toBe(2);
    expect(() => runtime.setPositions!({ baseSceneGeneration: generation, positions: [{ id: "m1", x: Infinity, y: 0 }] })).toThrow();
    runtime.dispose();
    expect(() => runtime.setPositions!({ baseSceneGeneration: generation, positions: [{ id: "m1", x: 1, y: 1 }] })).toThrow("disposed");
  });
});

describe("Bevy runtime Shot Camera capture boundary", () => {
  it("初始化缺失 capture 导出时明确失败（不伪装成截图超时）", async () => {
    const module = mockModule([]);
    delete module.request_shot_capture;
    await expect(loadBevyRuntime({ importModule: async () => module })).rejects.toThrow(/缺少必需能力/);
  });

  it("截图用 requestId/generation identity 匹配结果", async () => {
    const calls: Calls = [];
    const module = mockModule(calls);
    let requests = 0;
    module.request_shot_capture = (json: string) => {
      requests += 1;
      calls.push({ kind: "request_shot_capture", value: json });
    };
    module.poll_shot_capture = (requestId: number, generation: number) => {
      void generation;
      // 第一次轮询返回匹配 identity 的成功帧：[w][h][status=0][rgba]。
      if (requests === 0) return new Uint8Array();
      const out = new Uint8Array(12 + 4);
      const view = new DataView(out.buffer);
      view.setUint32(0, 1, true);
      view.setUint32(4, 1, true);
      view.setUint32(8, 0, true);
      out[12] = 1;
      void requestId;
      return out;
    };
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    const frame = await runtime.requestCapture!({ generation: 7, nodeId: "m1", width: 1, height: 1 });
    expect(frame).not.toBeNull();
    expect(frame!.width).toBe(1);
    expect(frame!.height).toBe(1);
    expect(frame!.rgba.length).toBe(4);
    const sent = JSON.parse(calls.find((c) => c.kind === "request_shot_capture")!.value) as {
      requestId: number;
      nodeId: string;
      generation: number;
    };
    expect(sent.nodeId).toBe("m1");
    expect(sent.generation).toBe(7);
    expect(sent.requestId).toBeGreaterThan(0);
  });

  it("失败 status 透传具体错误，不返回像素", async () => {
    const module = mockModule([]);
    module.request_shot_capture = () => undefined;
    module.poll_shot_capture = () => {
      const code = new TextEncoder().encode("camera-gone");
      const out = new Uint8Array(12 + code.length);
      const view = new DataView(out.buffer);
      view.setUint32(8, 1, true);
      out.set(code, 12);
      return out;
    };
    const runtime = await loadBevyRuntime({ importModule: async () => module });
    await expect(runtime.requestCapture!({ generation: 1, nodeId: "m1" })).rejects.toThrow("camera-gone");
  });
});

void sceneDiagnostics;


describe("Bevy 初始化与纹理故障恢复", () => {
  it("主动聚焦消费者能响应重试，异常订阅者不阻断，解绑后不再触发", async () => {
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule([]) });
    runtime.subscribeRuntimeRetry!(() => { throw new Error("observer failed"); });
    const refresh = vi.fn();
    const unsubscribe = runtime.subscribeRuntimeRetry!(refresh);
    expect(() => runtime.retryRuntimeIssues!()).not.toThrow();
    expect(refresh).toHaveBeenCalledOnce();
    expect(runtime.retryVersion!()).toBe(1);
    unsubscribe(); runtime.retryRuntimeIssues!();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("能力检查失败不启动 Bevy；失败加载不永久缓存 Promise", async () => {
    const broken = mockModule([], { prepare: false });
    const start = vi.fn(); broken.start = start;
    await expect(loadBevyRuntime({ importModule: async () => broken })).rejects.toThrow("prepare_and_register_model_resource");
    expect(start).not.toHaveBeenCalled();
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule([]) });
    expect(runtime.isReady()).toBe(true);
  });
  it("纹理上传拒绝可见且不影响其他资源与场景，重试后问题消失", async () => {
    const raw = mockModule([]);
    let rejected = true;
    const upload = vi.fn((id: string) => { if (id === "bad" && rejected) throw "Invalid texture"; });
    raw.set_texture = upload;
    const runtime = await loadBevyRuntime({ importModule: async () => raw });
    const pixels = new Uint8Array(4);
    expect(runtime.setTexture("bad", 1, 1, pixels)).toBe(false);
    expect(runtime.setTexture("bad", 1, 1, pixels)).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(runtime.setTexture("good", 1, 1, pixels, { sourceKey: "sha256-content" })).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    // 稳定内容身份随上传一起过界：Rust 侧据此共享同一 GPU 纹理（设计 D4 / 任务 4.4）。
    expect(upload.mock.calls[1]).toEqual(["good", 1, 1, pixels, "sha256-content"]);
    expect(runtime.getRuntimeIssues!()).toHaveLength(1);
    rejected = false; runtime.retryRuntimeIssues!();
    expect(runtime.setTexture("bad", 1, 1, pixels)).toBe(true);
    expect(runtime.getRuntimeIssues!()).toEqual([]);
    runtime.setScene(sceneWith("unused", "s"));
    expect(runtime.interactionGeneration!()).toBe(1);
  });
});

it("细节端口使用增量编码，清理及新 runtime 首批完整重传",async()=>{
  const upload=vi.fn();
  const module=mockModule([]);module.set_image_focus_details=upload;
  const frame={nodeId:"image",width:4096,height:3000,tiles:[{x:0,y:0,width:1,height:1,pixels:new Uint8Array([1,2,3,4])}]};
  const runtime=await loadBevyRuntime({importModule:async()=>module});
  runtime.setImageFocusDetails!(frame);expect(upload.mock.lastCall?.[1]).toHaveLength(4);
  runtime.setImageFocusDetails!({...frame});expect(upload.mock.lastCall?.[1]).toHaveLength(0);
  expect(JSON.parse(upload.mock.lastCall![0]).tiles[0].reuse).toBe(true);
  runtime.setImageFocusDetails!(null);runtime.setImageFocusDetails!(frame);
  expect(upload.mock.lastCall?.[1]).toHaveLength(4);runtime.dispose();
  const next=await loadBevyRuntime({importModule:async()=>module});
  next.setImageFocusDetails!(frame);expect(upload.mock.lastCall?.[1]).toHaveLength(4);next.dispose();
});

it("gizmo queries carry full transient identity, retry stale once and reject old generations", async () => {
  const module=mockModule([]);
  const requests: Array<Record<string,unknown>>=[];
  let stale=true;
  module.query_gizmo_hit=(json:string)=>{
    const request=JSON.parse(json);requests.push(request);
    return JSON.stringify(stale ? {available:false,reason:"stale"} : {available:true,generation:request.generation,handle:"scale",layoutId:"layout",epoch:7});
  };
  const runtime=await loadBevyRuntime({importModule:async()=>module});
  const input={kind:"object" as const,editor:{version:"woohaa-model-editor-v2" as const,nodeId:"film",itemId:"a",toolMode:"object" as const,objectTool:"scale" as const,
    focus:[0,0,0] as [number,number,number],radius:1,feedback:{epoch:7,hover:"scale" as const}},
    projection:{target:[0,0,0] as [number,number,number],yaw:0,pitch:0,distance:10},surface:{width:1024,height:768},point:{x:1,y:2}};
  expect(runtime.queryGizmoHit!(input)?.available).toBe(false);
  expect(requests).toHaveLength(2);
  expect(requests[0].editor).toEqual(input.editor);
  stale=false;expect(runtime.queryGizmoHit!(input)?.handle).toBe("scale");
  module.query_gizmo_hit=()=>JSON.stringify({available:true,generation:999,handle:"scale"});
  expect(runtime.queryGizmoHit!(input)).toBeNull();runtime.dispose();
});
