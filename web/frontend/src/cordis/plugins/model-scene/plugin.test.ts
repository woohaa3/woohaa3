/**
 * Model Scene Plugin 测试
 * （change: enhance-model-scene-authoring-api，任务 5.4；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only；
 *  change: 2026-10-08-integrate-render-performance-and-model-preview —— 合并模型脚本串行/重读最新来源修复）。
 *
 * 覆盖：V2 执行、V1/未知版本稳定失败、单节点失败隔离
 * （不清除其它模型、不停止 2D 画布）、prepared resource 发布、串行 drain 与
 * 等待期间修改不被旧快照覆盖、上报失败不阻断其它模型。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import {
  createEmptyWoohaa3ServerCanvas,
  applyCanvasCommands,
  prepareModelResource,
  type ServerCanvas
} from "@woohaa3/contracts";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { modelSceneExtension, MODEL_SCENE_PLUGIN_ID, type ModelSceneExtensionOptions } from "./plugin.js";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

let runtime: FrontendRuntime | null = null;

const V2_SCRIPT = `const m = scene.material({ id: "m", baseColor: "#26343a" });
scene.segment({ id: "arm", from: [0,0,0], to: [0,1,0], width: 0.3, material: m });`;
const V2_SIMPLE = "scene.box({ id: 'b1', size: [1,1,1], color: '#ff0000' });";

/** 一个含 N 个 V2 model3d 节点的画布。 */
function canvasWith(nodes: Array<{ id: string; source: string; version: string }>) {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const result = applyCanvasCommands(base, [
    ...nodes.map((node) => ({
      type: "node.add" as const,
      node: { id: node.id, type: "model3d" as const, position: { x: 0, y: 0 }, width: 196, height: 64 },
      nodeData: {
        modelScript: node.source,
        modelScriptLanguage: "javascript",
        modelScriptVersion: node.version,
        modelContentVersion: { revision: 1, sourceHash: `src-${node.id}`, contentHash: `content-${node.id}` },
        modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }
    }))
  ]);
  if (!result.ok) throw new Error("fixture");
  return result.canvas;
}

type Harness = {
  runtime: FrontendRuntime;
  reports: Array<{ nodeId: string; status: string }>;
  registry: CompositeAssetRegistry;
};

async function makeHarness(
  reportHook?: (nodeId: string) => Promise<void>,
  options: ModelSceneExtensionOptions = {},
): Promise<Harness> {
  const reports: Array<{ nodeId: string; status: string }> = [];
  const registry = new CompositeAssetRegistry();
  const installPlatform = (ctx: Context) => {
    ctx.provide("canvasState" as never, { getCanvas: () => woohaa3CanvasStore.getState().canvas, subscribe: woohaa3CanvasStore.subscribe } as never);
    ctx.provide("compositeAssets" as never, registry as never);
    ctx.provide("canvasRemote" as never, {
      reportModelScript: async (report: { nodeId: string; status: string }) => {
        reports.push({ nodeId: report.nodeId, status: report.status });
        await reportHook?.(report.nodeId);
      }
    } as never);
  };
  const instance = await startFrontendRuntime({
    installPlatform,
    plugins: [{ id: MODEL_SCENE_PLUGIN_ID, required: true, plugin: modelSceneExtension({ schedule: (run) => run(), ...options }) }]
  });
  return { runtime: instance, reports, registry };
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  vi.restoreAllMocks();
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

describe("model-scene plugin version dispatch", () => {
  it("本地节点呈现键独立更新，重复失效复用资源，替换画布/实例重新准备", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const keys = new Map([["a", "1"], ["b", "1"]]);
    const prepare = vi.fn((_nodeId: string) => ({ resource: prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: [] }) }));
    harness.registry.register({ extensionId: "test-asset", owner: "test-asset", executionKey: (_data, id) => keys.get(id ?? "")!, prepare });
    const canvas = createEmptyWoohaa3ServerCanvas("c1");
    for (const id of keys.keys()) {
      canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 0, y: 0 } });
      canvas.nodeData[id] = { extensionId: "test-asset", extensionContentRef: { schemaVersion: 1, instanceId: id } } as never;
    }
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    await expect.poll(() => prepare.mock.calls.length).toBe(2);
    keys.set("a", "2"); harness.registry.invalidate();
    await expect.poll(() => prepare.mock.calls.length).toBe(3);
    harness.registry.invalidate();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls.at(-1)?.[0]).toBe("a");
    const replacement = structuredClone(canvas);
    replacement.nodeData.a.extensionContentRef = { schemaVersion: 1, instanceId: "new" };
    woohaa3CanvasStore.getState().applyRemoteCanvas(replacement);
    await expect.poll(() => prepare.mock.calls.length).toBe(4);
    woohaa3CanvasStore.getState().applyRemoteCanvas({ ...replacement, id: "c2" });
    await expect.poll(() => prepare.mock.calls.length).toBe(6);
  });
  it("重新加载已确认状态的模型仍准备资源，但不重复上报", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const canvas = canvasWith([{ id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" }]);
    canvas.nodeData.m1!.modelScriptStatus = "ok";
    canvas.nodeData.m1!.modelScriptError = null;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider;
    await expect.poll(() => provider.getResources().size).toBe(1);
    expect(harness.reports).toEqual([]);
    const changed = canvasWith([{ id: "m1", source: "scene.sphere({ id: 's', radius: -1 });", version: "woohaa-model-js-v2" }]);
    changed.nodeData.m1!.modelScriptStatus = "ok";
    changed.nodeData.m1!.modelScriptError = null;
    woohaa3CanvasStore.getState().applyRemoteCanvas(changed);
    await expect.poll(() => harness.reports.at(-1)?.status).toBe("failed");
  });

  it("首个上报一直未返回也不阻塞后续模型和聚合资产准备", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const harness = await makeHarness(async nodeId => { if (nodeId === "m0") await held; });
    runtime = harness.runtime;
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: [] });
    harness.registry.register({ extensionId: "test-asset", owner: "test-asset", executionKey: () => "v1", prepare: () => ({ resource }) });
    const canvas = canvasWith(Array.from({ length: 22 }, (_, i) => ({ id: `m${i}`, source: V2_SIMPLE, version: "woohaa-model-js-v2" })));
    canvas.document.nodes.push({ id: "asset", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.asset = { extensionId: "test-asset" } as never;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider;
    try {
      await expect.poll(() => provider.getResources().size, { timeout: 3000 }).toBe(23);
      expect(provider.getResources().get("asset")).toBe(resource);
      expect(provider.isLoading?.("m21")).toBe(false);
    } finally {
      release();
    }
  });

  it("旧失败上报等待期间的新成功结果仍会按序上报", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const harness = await makeHarness(async () => held);
    runtime = harness.runtime;
    const initial = canvasWith([{ id: "m1", source: "scene.sphere({ id: 's', radius: -1 });", version: "woohaa-model-js-v2" }]);
    initial.nodeData.m1!.modelScriptStatus = "ok";
    initial.nodeData.m1!.modelScriptError = null;
    woohaa3CanvasStore.getState().applyRemoteCanvas(initial);
    await expect.poll(() => harness.reports[0]?.status).toBe("failed");
    try {
      const next = canvasWith([{ id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" }]);
      next.nodeData.m1!.modelScriptStatus = "ok";
      next.nodeData.m1!.modelScriptError = null;
      woohaa3CanvasStore.getState().applyRemoteCanvas(next);
      const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider;
      await expect.poll(() => provider.getResources().size).toBe(1);
    } finally {
      release();
    }
    await expect.poll(() => harness.reports.map(report => report.status)).toEqual(["failed", "ok"]);
  });

  it("分批准备让出主线程后重读新来源，保留已就绪资源", async () => {
    let release!: () => void;
    let yields = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const harness = await makeHarness(undefined, { yieldToBrowser: () => ++yields === 1 ? held : Promise.resolve() });
    runtime = harness.runtime;
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 4);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" },
      { id: "m2", source: V2_SCRIPT, version: "woohaa-model-js-v2" },
    ]));
    await new Promise(resolve => setTimeout(resolve, 0));
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider;
    try {
      expect(yields).toBe(1);
      expect(provider.getResources().get("m1")?.ops).toHaveLength(2);
      expect(provider.isLoading?.("m2")).toBe(true);
      woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
        { id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" },
        { id: "m2", source: V2_SIMPLE, version: "woohaa-model-js-v2" },
      ]));
    } finally {
      release();
    }
    await expect.poll(() => provider.getResources().get("m2")?.ops.length).toBe(1);
  });

  it("V2 节点产出 V2 prepared resource", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([
        { id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" },
        { id: "m2", source: V2_SCRIPT, version: "woohaa-model-js-v2" }
      ]));

    // 等待异步 apply 完成。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("m1")?.ops).toHaveLength(1);
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("m2")?.ops).toHaveLength(2);
    // 两个节点都报告成功。
    expect(harness.reports.filter((r) => r.status === "ok")).toHaveLength(2);
  });

  it("已下线的 V1 版本稳定失败，不写入 store、不加载", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([{ id: "legacy", source: V2_SIMPLE, version: "woohaa-model-js-v1" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("legacy")).toBeUndefined();
    expect(harness.reports.find((r) => r.nodeId === "legacy")?.status).toBe("failed");
  });

  it("单节点失败隔离：非法节点不清除合法节点，且报告失败", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([
        { id: "ok", source: V2_SIMPLE, version: "woohaa-model-js-v2" },
        { id: "bad", source: "scene.sphere({ id: 's', radius: -1 });", version: "woohaa-model-js-v2" }
      ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 合法节点保留。
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("ok")?.ops).toHaveLength(1);
    // 失败节点不进入 store。
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("bad")).toBeUndefined();
    const badReport = harness.reports.find((r) => r.nodeId === "bad");
    expect(badReport?.status).toBe("failed");
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE as never) as unknown as ModelScenesProvider;
    expect(provider.isLoading?.("bad")).toBe(false);
  });

  it("未知版本稳定失败，不回退", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([{ id: "u", source: V2_SIMPLE, version: "woohaa-model-js-v9" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("u")).toBeUndefined();
    expect(harness.reports.find((r) => r.nodeId === "u")?.status).toBe("failed");
  });

  it("提供 modelScenes 服务并暴露 prepared resources", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE as never) as ModelScenesProvider | undefined;
    expect(provider).toBeDefined();
    expect(typeof provider!.getResources).toBe("function");
  });

  it("executor 成功后发布 prepared resource，内容 identity 稳定且 placement 不入 key", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([{ id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE as never) as ModelScenesProvider | undefined;
    expect(provider).toBeDefined();
    const resource = provider!.getResources().get("m1");
    expect(resource).toBeDefined();
    expect(resource!.resourceVersion).toBe("woohaa-prepared-model-resource-v1");
    expect(resource!.resourceKey).toBe(`woohaa-model-scene-ir-v2:${resource!.signature}`);
    expect(resource!.extent).toBeGreaterThan(0);
    expect(resource!.payload).toContain(resource!.signature);
    // 相同 source 回流不重新派生（resource identity 不变）。
    const before = resource!.resourceKey;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([{ id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider!.getResources().get("m1")!.resourceKey).toBe(before);
  });

  it("上报等待期间的新脚本不会被旧画布快照覆盖", async () => {
    let release!: () => void;
    const pendingReport = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const harness = await makeHarness(async (nodeId) => {
      if (nodeId === "m1" && !waiting) {
        waiting = true;
        await pendingReport;
      }
    });
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([
        { id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" },
        { id: "m2", source: V2_SCRIPT, version: "woohaa-model-js-v2" }
      ]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waiting).toBe(true);
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE as never) as unknown as ModelScenesProvider;
    expect(provider.isLoading?.("m1")).toBe(false); // 本地资源就绪即结束，不等待状态上报。
    await expect.poll(() => provider.isLoading?.("m2")).toBe(false);
    expect(provider.isLoading?.("m2")).toBe(false);
    expect(provider.getResources().get("m2")?.ops).toHaveLength(2);
    // 独立上报队列等待期间，m2 的新来源仍应立即重新准备。
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([
        { id: "m1", source: V2_SCRIPT, version: "woohaa-model-js-v2" },
        { id: "m2", source: V2_SIMPLE, version: "woohaa-model-js-v2" }
      ]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // m2 必须重读最新来源（1 op），而不是被旧快照（2 ops）覆盖。
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("m2")?.ops).toHaveLength(1);
    expect(provider.isLoading?.("m2")).toBe(false);
  });

  it("模型准备排队期间删除节点立即清除加载状态", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const harness = await makeHarness(async nodeId => { if (nodeId === "m1") await held; });
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" },
      { id: "m2", source: V2_SIMPLE, version: "woohaa-model-js-v2" }
    ]));
    await new Promise(resolve => setTimeout(resolve, 0));
    const provider = harness.runtime.ctx.get(MODEL_SCENES_SERVICE as never) as unknown as ModelScenesProvider;
    await expect.poll(() => provider.isLoading?.("m2")).toBe(false);
    expect(provider.isLoading?.("m2")).toBe(false);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" }
    ]));
    expect(provider.isLoading?.("m2")).toBe(false);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(provider.isLoading?.("m2")).toBe(false);
  });

  it("状态上报断网不阻断后续模型的本地预览", async () => {
    const harness = await makeHarness(async () => {
      throw new Error("offline");
    });
    runtime = harness.runtime;
    woohaa3CanvasStore
      .getState()
      .applyRemoteCanvas(canvasWith([
        { id: "m1", source: V2_SIMPLE, version: "woohaa-model-js-v2" },
        { id: "m2", source: V2_SCRIPT, version: "woohaa-model-js-v2" }
      ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("m1")?.ops).toHaveLength(1);
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("m2")?.ops).toHaveLength(2);
  });

  it("无模型的复合内容成功加载，缺少 adapter 仍失败", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const stop = harness.registry.register({ extensionId: "content-only", owner: "content-only", executionKey: () => "v1", prepare: () => ({}) });
    const canvas = createEmptyWoohaa3ServerCanvas("c1");
    canvas.document.nodes.push({ id: "asset", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.asset = { extensionId: "content-only" } as never;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    await expect.poll(() => harness.reports.at(-1)?.status).toBe("ok");
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().size).toBe(0);
    expect(harness.registry.projection("asset")).toEqual({});
    stop();
    await expect.poll(() => harness.reports.at(-1)?.status).toBe("failed");
  });

  it("第三种复合资产业务仅通过 adapter 接入并在释放后失效", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: [] });
    let calls = 0;
    const stop = harness.registry.register({ extensionId: "test-asset", owner: "test-asset", executionKey: data => String(data.contentRevision), prepare: () => { calls++; return { resource }; } });
    const canvas = createEmptyWoohaa3ServerCanvas("c1");
    canvas.document.nodes.push({ id: "asset", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.asset = { extensionId: "test-asset", contentRevision: 1 } as never;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("asset")).toBe(resource);
    stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("asset")).toBeUndefined();
    expect(harness.registry.resolve(canvas as ServerCanvas, "asset")).toBeNull();
  });

  it("缺失 adapter 保留已保存模型，业务身份改变时重新派生", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const canvas = canvasWith([{ id: "asset", source: V2_SIMPLE, version: "woohaa-model-js-v2" }]);
    canvas.document.nodes[0]!.type = "composite-asset";
    canvas.nodeData.asset = { ...canvas.nodeData.asset, extensionId: "unknown-asset" } as never;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((runtime!.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider).getResources().get("asset")?.ops).toHaveLength(1);
    expect(harness.registry.resolve(canvas, "asset")).toBeNull();
  });
});

it("空模型不注册资源，提交脚本后恢复，清空后释放而不回填", async () => {
  const harness = await makeHarness(); runtime = harness.runtime;
  const provider = runtime.ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider;
  const empty = canvasWith([{ id: "empty", source: "", version: "woohaa-model-js-v2" }]);
  woohaa3CanvasStore.getState().applyRemoteCanvas(empty);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(provider.getResources().has("empty")).toBe(false);
  const full = canvasWith([{ id: "empty", source: V2_SIMPLE, version: "woohaa-model-js-v2" }]);
  woohaa3CanvasStore.getState().applyRemoteCanvas(full);
  await expect.poll(() => provider.getResources().has("empty")).toBe(true);
  woohaa3CanvasStore.getState().applyRemoteCanvas(empty);
  await expect.poll(() => provider.getResources().has("empty")).toBe(false);
  expect(woohaa3CanvasStore.getState().canvas?.nodeData.empty.modelScript).toBe("");
});
