/**
 * 模型聚焦目标解析测试（change: add-model-focus-viewing，任务 3.1；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only）。
 *
 * 覆盖：V2 解析、非模型节点跳过、无 Scene IR 跳过；placement 读取。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  prepareModelResource,
  type SceneV2Op,
  type ServerCanvas
} from "@woohaa3/contracts";
import { hasModelFocusTarget, resolveModelFocusTargets } from "./model-focus-targets.js";

const V2 = "woohaa-model-scene-ir-v2";

function v2Box(): SceneV2Op {
  return {
    t: "box",
    id: "b",
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#fff",
    size: [1, 1, 1]
  } as SceneV2Op;
}

function canvas(nodes: Array<{ id: string; type: string }>): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({ id: node.id, type: node.type, position: { x: 0, y: 0 } }))
    }
  } as ServerCanvas;
}

const base = { viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 1000, height: 800 } };

describe("resolveModelFocusTargets", () => {
  it("只对模型节点产出目标", () => {
    const c = canvas([
      { id: "m1", type: "model3d" },
      { id: "m2", type: "text" },
      { id: "m3", type: "image" }
    ]);
    const targets = resolveModelFocusTargets({
      canvas: c,
      ...base,
      scenesV2: new Map([["m1", [v2Box()]]])
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].nodeId).toBe("m1");
    expect(targets[0].sceneVersion).toBe(V2);
    expect(targets[0].canvas).toBe(c);
  });

  it("缺少 Scene IR 的节点不产出目标", () => {
    const c = canvas([{ id: "m1", type: "model3d" }, { id: "m2", type: "model3d" }]);
    const targets = resolveModelFocusTargets({
      canvas: c,
      ...base,
      scenesV2: new Map()
    });
    expect(targets).toEqual([]);
  });

  it("读取 nodeData.modelPlacement", () => {
    const c = canvas([{ id: "m1", type: "model3d" }]);
    const withPlacement = {
      ...c,
      nodeData: { m1: { modelPlacement: { offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 45 } } }
    } as unknown as ServerCanvas;
    const targets = resolveModelFocusTargets({
      canvas: withPlacement,
      ...base,
      scenesV2: new Map([["m1", [v2Box()]]])
    });
    expect(targets[0].placement).toEqual({ offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 45 });
  });

  it("画布为空返回空数组", () => {
    expect(resolveModelFocusTargets({ canvas: null, ...base, scenesV2: new Map() })).toEqual([]);
  });

  it("非 canonical 临时快照标记 nonCanonical（change: add-model-focus-editing，任务 3.4）", () => {
    const c = canvas([{ id: "m1", type: "model3d" }, { id: "m2", type: "model3d" }]);
    const targets = resolveModelFocusTargets({
      canvas: c,
      ...base,
      scenesV2: new Map([["m1", [v2Box()]], ["m2", [v2Box()]]]),
      nonCanonicalNodes: new Set(["m2"])
    });
    expect(targets.find((t) => t.nodeId === "m1")?.nonCanonical).toBeUndefined();
    expect(targets.find((t) => t.nodeId === "m2")?.nonCanonical).toBe(true);
  });

  it("prepared resource 优先：复用已派生 extent/AABB，不重新遍历 ops（change: optimize-model-scene-snapshot-hot-path）", () => {
    const c = canvas([{ id: "m1", type: "model3d" }]);
    const ops = [v2Box()];
    const resource = prepareModelResource({ sceneVersion: V2, ops });
    // 传空 ops 视图：若未走 prepared resource，则不会产出目标（证明资源优先）。
    const targets = resolveModelFocusTargets({
      canvas: c,
      ...base,
      resources: new Map([["m1", resource]]),
      scenesV2: new Map()
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].extent).toBe(resource.extent);
    expect(targets[0].aabb).toEqual(resource.aabb);
    expect(targets[0].sceneVersion).toBe(V2);
  });

  it("片场布局缓存命中时复用 prepared extent，不再遍历模型 ops", () => {
    const c = canvas([{ id: "film", type: "composite-asset" }]);
    c.nodeData = { film: { extensionId: "film-set" } } as ServerCanvas["nodeData"];
    const resource = prepareModelResource({ sceneVersion: V2, ops: [v2Box()] });
    let forbidReads = false;
    const ops = new Proxy(resource.ops, {
      get(target, property, receiver) {
        if (forbidReads) throw new Error("cached bounds must not traverse ops");
        return Reflect.get(target, property, receiver);
      }
    });
    const source = { canvas: c, ...base, resources: new Map([["film", { ...resource, ops }]]) };
    const first = resolveModelFocusTargets(source);
    forbidReads = true;
    expect(resolveModelFocusTargets(source)[0].aabb).toEqual(first[0].aabb);
    expect(hasModelFocusTarget(source, "film")).toBe(true);
  });

  it("无 prepared resource 时回退 ops 计算 extent", () => {
    const c = canvas([{ id: "m1", type: "model3d" }]);
    const targets = resolveModelFocusTargets({
      canvas: c,
      ...base,
      scenesV2: new Map([["m1", [v2Box()]]])
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].extent).toBeGreaterThan(0);
    expect(targets[0].aabb).toBeUndefined();
  });
});


describe("hasModelFocusTarget", () => {
  it("matches target membership without reading geometry, and observes resource removal", () => {
    const c = canvas([{ id: "m", type: "model3d" }, { id: "text", type: "text" }]);
    const resource = prepareModelResource({ sceneVersion: V2, ops: [v2Box()] });
    const resources = new Map([["m", resource], ["text", resource]]);
    const source = { canvas: c, resources };
    expect(hasModelFocusTarget(source, "m")).toBe(true);
    expect(hasModelFocusTarget(source, "text")).toBe(false);
    expect(hasModelFocusTarget(source, "missing")).toBe(false);
    resources.delete("m");
    expect(hasModelFocusTarget(source, "m")).toBe(false);
    expect(hasModelFocusTarget({ canvas: c, scenesV2: new Map([["m", []]]) }, "m")).toBe(true);
    expect(hasModelFocusTarget({ canvas: null, resources }, "m")).toBe(false);
  });
});

it("空脚本即使暂存旧资源也不建立聚焦，提交脚本后恢复真实 bounds", () => {
  const c = canvas([{ id: "empty", type: "model3d" }]);
  c.nodeData.empty = { modelScript: "" };
  const resource = prepareModelResource({ sceneVersion: V2, ops: [v2Box()] });
  const source = { canvas: c, ...base, resources: new Map([["empty", resource]]) };
  expect(hasModelFocusTarget(source, "empty")).toBe(false);
  expect(resolveModelFocusTargets(source)).toEqual([]);
  c.nodeData.empty.modelScript = "scene.box({id:'b'});";
  expect(hasModelFocusTarget(source, "empty")).toBe(true);
  expect(resolveModelFocusTargets(source)[0].aabb).toEqual(resource.aabb);
});
