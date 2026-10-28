import { describe, expect, it } from "vitest";
import {
  buildCanvasRenderScene,
  createEmptyWoohaa3ServerCanvas,
  defaultGroupAppearance,
  executeModelScriptVersioned,
  prepareModelResource,
  type PreparedModelResource
} from "@woohaa3/contracts";
import { loadBevyRuntime } from "../plugins/canvas-runtime/bevy-runtime.js";
import { mockModule, v2Ops, type Calls } from "../plugins/canvas-runtime/test-support/runtime-harness.js";
import {
  CanvasResourceCoordinator,
  createContentIdentity,
  createResidencyCandidateCache,
  createResidencyProjector
} from "../plugins/canvas-runtime/residency/index.js";

function defaultResource() {
  const model = defaultGroupAppearance().model;
  const executed = executeModelScriptVersioned(model.modelScript, model.modelScriptVersion);
  if (!executed.ok) throw new Error("默认组模型执行失败");
  return prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: executed.scene.ops });
}

describe("组展示模型从资源准入到 WASM payload", () => {
  it.each(["scene-first", "leases-first"])("%s：异步就绪的组/嵌套组与片场实际准备几何", async order => {
    const canvas = createEmptyWoohaa3ServerCanvas("group-payload");
    canvas.document.nodes.push(
      { id: "group", type: "group", position: { x: 100, y: 100 }, width: 600, height: 500 },
      { id: "nested", type: "group", parentId: "group", position: { x: 40, y: 40 }, width: 300, height: 300 },
      { id: "film", type: "composite-asset", position: { x: 800, y: 100 }, width: 400, height: 400 }
    );
    const calls: Calls = [];
    const runtime = await loadBevyRuntime({ importModule: async () => mockModule(calls) });
    const resources = new Map<string, PreparedModelResource>();
    let version = 0;
    let viewport = { x: 0, y: 0, zoom: 1 };
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(createContentIdentity({
      modelResourceKey: id => resources.get(id)?.resourceKey ?? null
    }), () => version);
    const project = createResidencyProjector({
      coordinator, getCanvas: () => canvas, candidatesFor, contentVersion: () => version,
      viewport: () => viewport,
      surface: () => ({ width: 1600, height: 1000, pixelRatio: 1 }),
      interactive: () => [], pageVisible: () => true,
      onAdmittedContent: keys => runtime.setModelPayloadLeases!(keys),
      onFrame: () => runtime.advanceModelPreparation!()
    });
    const submit = () => runtime.setScene(buildCanvasRenderScene({ canvas, modelResources: resources }),
      new Map([...resources.values()].map(resource => [resource.resourceKey, resource])));
    try {
      project(); submit();
      expect(calls.filter(call => call.kind === "prepare")).toHaveLength(0);

      const groupResource = defaultResource();
      const filmResource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(3) });
      resources.set("group", groupResource);
      resources.set("nested", groupResource);
      resources.set("film", filmResource);
      version += 1;
      // 两种时序都必须准备 payload，不能停在只有 descriptor 的状态。
      if (order === "scene-first") { submit(); project(); }
      else { project(); submit(); }
      expect(coordinator.admittedNodeIds().sort()).toEqual(["film", "group", "nested"]);
      expect(coordinator.admittedContentKeys().sort()).toEqual([filmResource.resourceKey, groupResource.resourceKey].sort());
      expect(calls.filter(call => call.kind === "prepare").map(call => JSON.parse(call.value).expectedSignature).sort())
        .toEqual([groupResource.signature, filmResource.signature].sort());
      // 多组共用默认几何；静止/pan 不重新准备。
      project(); submit();
      viewport = { x: 20, y: 20, zoom: 1.1 };
      project(); submit();
      expect(calls.filter(call => call.kind === "prepare")).toHaveLength(2);
      // 替换一组外观：另一组仍持有共享默认几何，新的自定义内容按需求准备一次。
      const custom = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: v2Ops(7) });
      resources.set("group", custom);
      version += 1;
      if (order === "scene-first") { submit(); project(); }
      else { project(); submit(); }
      expect(calls.filter(call => call.kind === "prepare")).toHaveLength(3);
      expect(coordinator.admittedContentKeys().sort())
        .toEqual([filmResource.resourceKey, groupResource.resourceKey, custom.resourceKey].sort());
      // 删除两个组后，默认模型不能继续持有 lease；片场保持驻留。
      canvas.document.nodes = canvas.document.nodes.filter(node => node.id === "film");
      version += 1;
      project(); submit();
      expect(coordinator.admittedContentKeys()).toEqual([filmResource.resourceKey]);
      expect(JSON.parse(calls.filter(call => call.kind === "leases").at(-1)!.value).keys).toEqual([filmResource.resourceKey]);
    } finally {
      coordinator.dispose();
    }
  });

  it("仅徽章下缘进入视口时仍能准入 payload", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("group-footer");
    // 组框整体在视口上方（布局高 475），只有外置徽章的下缘进入顶部 4px。
    canvas.document.nodes.push({ id: "group", type: "group", position: { x: 100, y: -553 }, width: 500, height: 400 });
    canvas.document.nodes.push({ id: "member", type: "image", parentId: "group", position: { x: 40, y: 200 }, width: 200, height: 195 });
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(createContentIdentity({ modelResourceKey: () => "group-resource" }));
    try {
      const candidate = candidatesFor(canvas)[0]!;
      expect(candidate.y + candidate.height).toBe(4);
      createResidencyProjector({
        coordinator, getCanvas: () => canvas, candidatesFor,
        viewport: () => ({ x: 0, y: 0, zoom: 1 }),
        surface: () => ({ width: 1024, height: 768, pixelRatio: 1 }),
        interactive: () => [], pageVisible: () => true
      })();
      expect(coordinator.admittedNodeIds()).toEqual(["group"]);
      expect(coordinator.admittedContentKeys()).toEqual(["group-resource"]);
    } finally { coordinator.dispose(); }
  });

  it("可见组加载自身模型但不占离屏预览槽", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("group-slots");
    canvas.document.nodes.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `group-${index}`, type: "group" as const,
        position: { x: index * 40, y: 0 }, width: 200, height: 200
      })),
      { id: "model", type: "model3d", position: { x: 900, y: 0 }, width: 200, height: 200 }
    );
    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 1 } });
    const candidatesFor = createResidencyCandidateCache(createContentIdentity({ modelResourceKey: id => id }));
    try {
      const candidates = candidatesFor(canvas);
      expect(candidates.filter(candidate => candidate.previewSlot).map(candidate => candidate.nodeId)).toEqual(["model"]);
      createResidencyProjector({
        coordinator, getCanvas: () => canvas, candidatesFor,
        viewport: () => ({ x: 0, y: 0, zoom: 1 }),
        surface: () => ({ width: 1600, height: 1000, pixelRatio: 1 }),
        interactive: () => [], pageVisible: () => true
      })();
      expect(coordinator.admittedNodeIds()).toHaveLength(21);
    } finally {
      coordinator.dispose();
    }
  });
});
