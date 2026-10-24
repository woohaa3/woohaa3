/**
 * Bevy 运行时 descriptor/payload 分离
 * （change: 2026-10-23-scale-canvas-media-residency，design D5 / 任务 5.1、5.2、5.3、6.1）。
 *
 * 从 `bevy-runtime.test.ts` 拆出（前端文件体积守卫），共用 `test-support/runtime-harness.ts`。
 * 覆盖：先声明后引用、payload 只在当前需求内准备、lease 幂等、资产 key 不被当成模型、
 * 淘汰后按需求重准备，以及准备并发/片段预算只由页面策略注入。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prepareModelResource } from "@woohaa3/contracts";
import { loadBevyRuntime } from "./bevy-runtime.js";
import { resetSceneDiagnostics, sceneDiagnostics } from "./scene-diagnostics.js";
import { MODEL_PAYLOAD_LIMIT, mockModule, sceneWith, v2Ops, type Calls } from "./test-support/runtime-harness.js";

describe("Bevy runtime descriptor/payload separation（change: 2026-10-23-scale-canvas-media-residency）", () => {
  beforeEach(() => {
    resetSceneDiagnostics();
  });

  it("先声明 descriptor 再提交引用场景；payload 只在当前需求内准备", async () => {
    const calls: Calls = [];
    const visible = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const offscreen = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(5) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    // 需求投影只准入可见模型。
    runtime.setModelPayloadLeases!([visible.resourceKey]);
    const scene = sceneWith(visible.resourceKey, visible.signature);
    scene.nodes.push({ ...scene.nodes[0], id: "m2", model: { ...scene.nodes[0].model!, resourceKey: offscreen.resourceKey, signature: offscreen.signature } });
    runtime.setScene(scene, new Map([[visible.resourceKey, visible], [offscreen.resourceKey, offscreen]]));

    const declares = calls.filter((call) => call.kind === "declare");
    const prepares = calls.filter((call) => call.kind === "prepare");
    // 两个模型都声明身份（场景引用才合法），但只有一个取得重型 payload。
    expect(declares).toHaveLength(2);
    expect(prepares).toHaveLength(1);
    expect(JSON.parse(prepares[0].value).expectedSignature).toBe(visible.signature);
    // 声明必须早于提交引用场景（descriptor ACK 之后才允许被引用）。
    const firstSubmit = calls.findIndex((call) => call.kind === "set_scene");
    expect(calls.findIndex((call) => call.kind === "declare")).toBeLessThan(firstSubmit);
    expect(sceneDiagnostics.modelDescriptors).toBe(2);
    expect(sceneDiagnostics.modelRegistrations).toBe(1);
  });

  it("离屏模型随后取得需求时才准备 payload，并只提交变化的 lease", async () => {
    const calls: Calls = [];
    const first = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const second = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(9) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    runtime.setModelPayloadLeases!([first.resourceKey]);
    const scene = sceneWith(first.resourceKey, first.signature);
    scene.nodes.push({ ...scene.nodes[0], id: "m2", model: { ...scene.nodes[0].model!, resourceKey: second.resourceKey, signature: second.signature } });
    const resources = new Map([[first.resourceKey, first], [second.resourceKey, second]]);
    runtime.setScene(scene, resources);
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);

    // 视口移动到第二个模型：权威账本报告第一份 payload 被淘汰、第二份需要准备。
    runtime.setModelPayloadLeases!([second.resourceKey]);
    const prepares = calls.filter((call) => call.kind === "prepare");
    expect(prepares).toHaveLength(2);
    expect(JSON.parse(prepares[1].value).expectedSignature).toBe(second.signature);

    // 需求未变化的静止帧不重复跨边界提交 lease。
    const leaseSubmits = calls.filter((call) => call.kind === "leases").length;
    runtime.setModelPayloadLeases!([second.resourceKey]);
    runtime.setModelPayloadLeases!([second.resourceKey]);
    expect(calls.filter((call) => call.kind === "leases")).toHaveLength(leaseSubmits);
    expect(sceneDiagnostics.modelLeaseSubmits).toBe(leaseSubmits);
  });

  it("资产/片场内容身份不会被当成模型 payload lease", async () => {
    const calls: Calls = [];
    const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(1) });
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    runtime.setModelPayloadLeases!(["asset:sha256-abc", "canvas:composite:node"]);
    const leases = calls.filter((call) => call.kind === "leases");
    expect(leases).toHaveLength(1);
    // 非模型内容身份被过滤，不会伪装成「有需求」而准备任何 payload。
    expect(JSON.parse(leases[0].value).keys).toEqual([]);
    runtime.setScene(sceneWith(resource.resourceKey, resource.signature), new Map([[resource.resourceKey, resource]]));
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(0);
    // 该模型真正取得需求后才准备。
    runtime.setModelPayloadLeases!(["asset:sha256-abc", resource.resourceKey]);
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);
  });

  it("payload 被预算淘汰后重新取得需求会重准备，且不报告为渲染失败", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const models = Array.from({ length: MODEL_PAYLOAD_LIMIT + 2 }, (_, index) =>
      prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(index + 1) }));
    const scene = sceneWith(models[0].resourceKey, models[0].signature);
    for (const [index, model] of models.entries()) {
      if (index === 0) continue;
      scene.nodes.push({ ...scene.nodes[0], id: `m${index}`, model: { ...scene.nodes[0].model!, resourceKey: model.resourceKey, signature: model.signature } });
    }
    const resources = new Map(models.map((model) => [model.resourceKey, model]));

    // 只准入第一份 payload；其余保持 cold（不准备）。
    runtime.setModelPayloadLeases!([models[0].resourceKey]);
    runtime.setScene(scene, resources);
    expect(calls.filter((call) => call.kind === "prepare")).toHaveLength(1);

    // 需求整体移动：准备新需求会超出条目上限，第一份 payload 被预算淘汰。
    // 每帧只推进策略允许的数量，其余由后续帧继续（任务 6.1 的主线程片段预算）。
    const later = models.slice(1).map((model) => model.resourceKey);
    runtime.setModelPayloadLeases!(later);
    const afterLeaseMove = calls.filter((call) => call.kind === "prepare").length;
    expect(afterLeaseMove).toBeLessThan(1 + later.length);
    while (calls.filter((call) => call.kind === "prepare").length < 1 + later.length) {
      const before = calls.filter((call) => call.kind === "prepare").length;
      runtime.advanceModelPreparation!();
      expect(calls.filter((call) => call.kind === "prepare").length).toBeGreaterThan(before);
    }
    // 重新取得已淘汰内容时按需重准备（同样受每帧预算约束）。
    runtime.setModelPayloadLeases!([models[0].resourceKey]);
    for (let pass = 0; pass < later.length + 2; pass += 1) runtime.advanceModelPreparation!();
    expect(calls.filter((call) => call.kind === "prepare").length).toBe(2 + later.length);
    // 重新准备是正常路径，不是渲染错误。
    expect(runtime.getRenderIssues!()).toEqual([]);
  });

  it("缺少 declare_model_resource 或 set_model_payload_leases 时初始化明确失败", async () => {
    const missingDeclare = mockModule([]);
    delete missingDeclare.declare_model_resource;
    await expect(loadBevyRuntime({ importModule: async () => missingDeclare }))
      .rejects.toThrow(/缺少必需能力.*declare_model_resource/);

    const missingLeases = mockModule([]);
    delete missingLeases.set_model_payload_leases;
    await expect(loadBevyRuntime({ importModule: async () => missingLeases }))
      .rejects.toThrow(/缺少必需能力.*set_model_payload_leases/);
  });

  it("模型准备并发与片段预算由页面策略注入，且非法值不放宽默认预算", async () => {
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const models = Array.from({ length: 4 }, (_, index) =>
      prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(index + 1) }));
    const scene = sceneWith(models[0].resourceKey, models[0].signature);
    for (const [index, model] of models.entries()) {
      if (index === 0) continue;
      scene.nodes.push({ ...scene.nodes[0], id: `m${index}`, model: { ...scene.nodes[0].model!, resourceKey: model.resourceKey, signature: model.signature } });
    }
    const resources = new Map(models.map((model) => [model.resourceKey, model]));
    const prepares = () => calls.filter((call) => call.kind === "prepare").length;

    runtime.setModelPayloadLeases!(models.map((model) => model.resourceKey));
    // 页面策略：每帧最多 1 项 ⇒ 一帧只推进一个模型 payload。
    runtime.setModelPrepareBudget!({ concurrency: 1, budgetMs: 6 });
    runtime.setScene(scene, resources);
    const afterScene = prepares();
    expect(afterScene).toBeGreaterThanOrEqual(1);
    expect(afterScene).toBeLessThan(models.length);
    // 后续帧继续推进，且同样受并发预算约束（不是一次全部装配）。
    runtime.advanceModelPreparation!();
    expect(prepares()).toBe(2);
    runtime.advanceModelPreparation!();
    expect(prepares()).toBe(3);
    expect(prepares()).toBeLessThan(models.length);
    // 非法注入（0/负数）被忽略，不把并发写成 0 让准备永久停住。
    runtime.setModelPrepareBudget!({ concurrency: 0, budgetMs: -1 });
    runtime.advanceModelPreparation!();
    expect(prepares()).toBeGreaterThan(3);
  });
});
