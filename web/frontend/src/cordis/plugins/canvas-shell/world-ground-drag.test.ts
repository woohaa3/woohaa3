/**
 * 共享世界模型直接地面拖动：纯规则回归。
 *
 * 关注三件事：命中筛选只认合法 `sharedWorldInstance`；增量只改地面 `u/v` 并保留高度、
 * 姿态与实例身份；无位移不提交（不产生空撤销记录）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createWorldAnimationScript, decodeSceneAreaData, executeWorldAnimationScript, type ServerCanvas } from "@woohaa3/contracts";
import {
  beginWorldGroundDrag,
  beginWorldGroundDragMany,
  planWorldGroundMoveWithAnimation,
  planWorldGroundMoveWithAnimationParts,
  isWorldDragTarget,
  planWorldGroundMove,
  worldGroundDelta,
  worldGroundMoved
} from "./world-ground-drag.js";

function canvasWith(instance: unknown, data: Record<string, unknown> = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m1", type: "model3d", position: { x: 0, y: 0 } }] },
    nodeData: { m1: { ...data, sharedWorldInstance: instance } }
  } as ServerCanvas;
}

const instance = {
  kind: "world-instance",
  version: "shared-world-v1",
  instanceId: "inst-1",
  transform: {
    version: "shared-world-v1",
    position: { u: 2, v: -3, h: 1.5 },
    rotation: [0, 0.3826834, 0, 0.9238795],
    scale: 1.25
  }
};

describe("世界模型地面拖动", () => {
  it("只把合法 sharedWorldInstance 当作拖动目标", () => {
    expect(isWorldDragTarget(canvasWith(instance), "m1")).toBe(true);
    expect(isWorldDragTarget(canvasWith({ ...instance, version: "shared-world-v2" }), "m1")).toBe(false);
    expect(isWorldDragTarget(canvasWith(undefined), "m1")).toBe(false);
    expect(isWorldDragTarget(canvasWith(instance), "missing")).toBe(false);
  });

  it("没有地面点（聚焦/过渡/模态）时不开手势", () => {
    expect(beginWorldGroundDrag(canvasWith(instance), "m1", null)).toBeNull();
    expect(beginWorldGroundDrag(canvasWith(instance), "m1", { u: Number.NaN, v: 0 })).toBeNull();
    expect(beginWorldGroundDrag(canvasWith(instance), "m1", { u: 0, v: 0 })).not.toBeNull();
  });

  it("位移只改地面 u/v，保留高度、姿态、尺度与实例身份", () => {
    const canvas = canvasWith(instance);
    const start = beginWorldGroundDrag(canvas, "m1", { u: 10, v: 10 })!;
    const delta = worldGroundDelta(start, canvas, { u: 12.5, v: 7 });
    expect(delta).toEqual({ u: 2.5, v: -3 });
    const commands = planWorldGroundMove(start, delta);
    expect(commands).toHaveLength(1);
    const command = commands![0] as unknown as { type: string; nodeId: string; value: { sharedWorldInstance: typeof instance } };
    expect(command.type).toBe("nodeData.patch");
    expect(command.nodeId).toBe("m1");
    const moved = command.value.sharedWorldInstance;
    expect(moved.instanceId).toBe("inst-1");
    expect(moved.transform.position).toEqual({ u: 4.5, v: -6, h: 1.5 });
    expect(moved.transform.rotation).toEqual(instance.transform.rotation);
    expect(moved.transform.scale).toBe(1.25);
  });

  it("无位移或亚厘米抖动不提交", () => {
    const canvas = canvasWith(instance);
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    expect(worldGroundMoved({ u: 0, v: 0 })).toBe(false);
    expect(worldGroundMoved({ u: 0.005, v: -0.009 })).toBe(false);
    expect(planWorldGroundMove(start, { u: 0, v: 0 })).toBeNull();
    expect(planWorldGroundMove(start, null)).toBeNull();
    expect(worldGroundMoved({ u: 0.02, v: 0 })).toBe(true);
  });

  it("实例在拖动期间被外部改写时手势失效", () => {
    const canvas = canvasWith(instance);
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    const changed = canvasWith({
      ...instance,
      transform: { ...instance.transform, position: { u: 9, v: 9, h: 9 } }
    });
    expect(worldGroundDelta(start, changed, { u: 1, v: 1 })).toBeNull();
  });

  it("多选时同一地面增量应用到全部世界实例", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const second = {
      ...instance,
      instanceId: "inst-2",
      transform: { ...instance.transform, position: { u: -1, v: 2, h: 0.5 } }
    };
    const canvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [
        { id: "m1", type: "model3d", position: { x: 0, y: 0 } },
        { id: "m2", type: "model3d", position: { x: 200, y: 0 } }
      ] },
      nodeData: { m1: { sharedWorldInstance: instance }, m2: { sharedWorldInstance: second } }
    } as ServerCanvas;
    const start = beginWorldGroundDragMany(canvas, ["m1", "m2"], "m1", { u: 0, v: 0 })!;
    expect(start.targets).toHaveLength(2);
    const delta = worldGroundDelta(start, canvas, { u: 1, v: 2 });
    expect(delta).toEqual({ u: 1, v: 2 });
    const commands = planWorldGroundMove(start, delta)!;
    expect(commands).toHaveLength(2);
    const positions = commands.map(command => {
      const value = (command as unknown as { value: { sharedWorldInstance: typeof instance } }).value.sharedWorldInstance;
      return [value.instanceId, value.transform.position];
    });
    expect(positions).toEqual([
      ["inst-1", { u: 3, v: -1, h: 1.5 }],
      ["inst-2", { u: 0, v: 4, h: 0.5 }]
    ]);
  });

  it("多选拖动中任一实例被外部改写时整批取消", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const second = { ...instance, instanceId: "inst-2" };
    const canvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [
        { id: "m1", type: "model3d", position: { x: 0, y: 0 } },
        { id: "m2", type: "model3d", position: { x: 200, y: 0 } }
      ] },
      nodeData: { m1: { sharedWorldInstance: instance }, m2: { sharedWorldInstance: second } }
    } as ServerCanvas;
    const start = beginWorldGroundDragMany(canvas, ["m1", "m2"], "m1", { u: 0, v: 0 })!;
    const changed = {
      ...canvas,
      nodeData: { ...canvas.nodeData, m2: { sharedWorldInstance: {
        ...second, transform: { ...second.transform, position: { u: 9, v: 9, h: 9 } }
      } } }
    } as ServerCanvas;
    expect(worldGroundDelta(start, changed, { u: 1, v: 1 })).toBeNull();
  });

  it("拖动动画实例时同步平移脚本的位置轨道", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const animationScript = createWorldAnimationScript({
      script: 'motion.instance.tween("inst-1", { property: "position", startTime: 0, endTime: 4, from: [2, -3, 1.5], to: [4, -3, 1.5], easing: "linear" });',
      duration: 4,
      loop: false,
      revision: 3
    });
    const canvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [
        { id: "m1", type: "model3d", position: { x: 0, y: 0 } },
        { id: "area", type: "scene-area", position: { x: 0, y: 0 } }
      ] },
      nodeData: {
        m1: { sharedWorldInstance: instance },
        area: { title: "导演区", sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } },
          animationOrigin: { u: 0, v: 0 },
          animationScript
        } }
      }
    } as unknown as ServerCanvas;
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    const commands = planWorldGroundMoveWithAnimation(canvas, start, { u: 1, v: 2 }, new Map([["area", 2]]))!;
    expect(commands).toHaveLength(2);
    const instancePatch = commands.find(command => command.type === "nodeData.patch" && command.nodeId === "m1") as unknown as {
      value: { sharedWorldInstance: { transform: { position: { u: number; v: number; h: number } } } };
    };
    // t=2 的采样位置是 [3,-3,1.5]；拖动后基础变换应落到可见位置 + delta，而不是旧基础 + delta。
    expect(instancePatch.value.sharedWorldInstance.transform.position).toEqual({ u: 4, v: -1, h: 1.5 });
    const areaPatch = commands.find(command => command.type === "nodeData.patch" && command.nodeId === "area") as unknown as {
      value: { sceneArea: { animationScript: { script: string; duration: number; loop: boolean; revision: number } } };
    };
    const decoded = decodeSceneAreaData(areaPatch.value.sceneArea);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const nextScript = decoded.value.animationScript!;
    expect(nextScript.revision).toBe(4);
    const executed = executeWorldAnimationScript(nextScript.script, { duration: nextScript.duration, loop: nextScript.loop });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    const track = executed.ir.instanceTracks.find(item => item.targetId === "inst-1" && item.property === "position")!;
    expect(track.from).toEqual([3, -1, 1.5]);
    expect(track.to).toEqual([5, -1, 1.5]);
  });

  it("移出动画所属导演区时提供解绑候选，确认后移除该实例轨道", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const animationScript = createWorldAnimationScript({
      script: 'motion.instance.tween("inst-1", { property: "position", startTime: 0, endTime: 4, from: [2, -3, 1.5], to: [4, -3, 1.5], easing: "linear" });',
      duration: 4,
      loop: false,
      revision: 1
    });
    const canvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [
        { id: "m1", type: "model3d", position: { x: 0, y: 0 } },
        { id: "area", type: "scene-area", position: { x: 0, y: 0 } }
      ] },
      nodeData: {
        m1: { sharedWorldInstance: instance },
        area: { title: "小导演区", sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: -5 }, max: { u: 5, v: -1 } },
          animationOrigin: { u: 0, v: 0 },
          animationScript
        } }
      }
    } as unknown as ServerCanvas;
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    const detected = planWorldGroundMoveWithAnimationParts(canvas, start, { u: 10, v: 0 }, new Map([["area", 0]]))!;
    expect(detected.unbindCandidates).toEqual([{ areaNodeId: "area", title: "小导演区" }]);
    const confirmed = planWorldGroundMoveWithAnimationParts(
      canvas, start, { u: 10, v: 0 }, new Map([["area", 0]]), new Set(["area"])
    )!;
    expect(confirmed.unbindCandidates).toEqual([]);
    const areaPatch = confirmed.forward.find(command => command.type === "nodeData.patch" && command.nodeId === "area") as unknown as {
      value: { sceneArea: { animationScript?: unknown } };
    };
    expect(areaPatch.value.sceneArea.animationScript).toBeUndefined();
    const instancePatch = confirmed.forward.find(command => command.type === "nodeData.patch" && command.nodeId === "m1") as unknown as {
      value: { sharedWorldInstance: { transform: { position: { u: number; v: number; h: number } } } };
    };
    expect(instancePatch.value.sharedWorldInstance.transform.position).toEqual({ u: 12, v: -3, h: 1.5 });
    const inverseArea = confirmed.inverse.find(command => command.type === "nodeData.patch" && command.nodeId === "area") as unknown as {
      value: { sceneArea: { animationScript?: { revision: number } } };
    };
    expect(inverseArea.value.sceneArea.animationScript?.revision).toBe(1);
  });

  it("不影响其它 nodeData 字段（脚本、内容身份等原样保留在 patch 之外）", () => {
    const canvas = canvasWith(instance, { modelScript: "scene.box({ id: 'body' });" });
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    const command = planWorldGroundMove(start, { u: 1, v: 0 })![0] as { value: Record<string, unknown> };
    expect(Object.keys(command.value)).toEqual(["sharedWorldInstance"]);
  });
});

function anchorCanvas(script = 'motion.part.tween("inst-1", "foot", { property: "rotation", startTime: 0, endTime: 4, from: [0,0,0], to: [20,0,0] });'): ServerCanvas {
  const canvas = canvasWith(instance);
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1", bounds: { min: { u: 0, v: -5 }, max: { u: 5, v: -1 } }, animationOrigin: { u: 0, v: 0 }, animationScript: createWorldAnimationScript({ script, duration: 4, loop: false, revision: 1 }) } } as never;
  return canvas;
}

it("part-only animation detects anchor crossing and unlinks all part tracks with full undo", () => {
  const canvas = anchorCanvas();
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
  const detected = planWorldGroundMoveWithAnimationParts(canvas, start, { u: 10, v: 0 })!;
  expect(detected.unbindCandidates).toHaveLength(1);
  const plan = planWorldGroundMoveWithAnimationParts(canvas, start, { u: 10, v: 0 }, undefined, new Set(["area"]))!;
  const patch = plan.forward.find(c => c.type === "nodeData.patch" && c.nodeId === "area") as any;
  expect(patch.value.sceneArea.animationScript).toBeUndefined();
  const undo = plan.inverse.find(c => c.type === "nodeData.patch" && c.nodeId === "area") as any;
  expect(undo.value.sceneArea).toEqual(canvas.nodeData.area.sceneArea);
});

it("uses frozen scaled and rotated anchor: origin outside is harmless; anchor crossing prompts", () => {
  const canvas = anchorCanvas();
  canvas.nodeData.m1.sharedWorldInstance = { ...instance, transform: { ...instance.transform, position: { u: 6, v: -3, h: 0 }, rotation: [0, 0, 1, 0], scale: 2 } } as never;
  // A half turn maps local x=1 into world u=-2: origin=6, anchor=4.
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 }, new Map([["m1", [1, 0, 0] as [number, number, number]]]))!;
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1, v: 0 })!.unbindCandidates).toEqual([]);
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1.1, v: 0 })!.unbindCandidates).toHaveLength(1);
});

it("unknown prepared anchor cancels animated move without guessing origin", () => {
  const canvas = anchorCanvas();
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 }, new Map([["m1", null]]))!;
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 10, v: 0 })).toBeNull();
});

it("unlink removes target cycles and preserves other instances, parts, and camera tracks", () => {
  const script = [
    'motion.instance.tween("inst-1", { property: "position", startTime: 0, endTime: 4, from: [2,-3,0], to: [3,-3,0] });',
    'motion.part.cycle("inst-1", "foot", { property: "rotation", startTime: 0, endTime: 4, period: 1, keyframes: [{time:0,value:[0,0,0]},{time:0.5,value:[20,0,0]},{time:1,value:[0,0,0]}] });',
    'motion.part.tween("other", "foot", { property: "rotation", startTime: 0, endTime: 4, from: [0,0,0], to: [20,0,0] });',
    'motion.instance.tween("other", { property: "position", startTime: 0, endTime: 4, from: [0,0,0], to: [1,0,0] });',
    'motion.camera.tween({ targetId: "camera", property: "position", startTime: 0, endTime: 4, from: [0,0,0], to: [1,0,0] });'
  ].join('\n');
  const canvas = anchorCanvas(script);
  const original = executeWorldAnimationScript(script, { duration: 4, loop: false });
  expect(original.ok).toBe(true);
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
  const plan = planWorldGroundMoveWithAnimationParts(canvas, start, { u: 10, v: 0 }, undefined, new Set(["area"]))!;
  const areaPatch = plan.forward.find(c => c.type === "nodeData.patch" && c.nodeId === "area") as any;
  const executed = executeWorldAnimationScript(areaPatch.value.sceneArea.animationScript.script, { duration: 4, loop: false });
  expect(executed.ok).toBe(true);
  if (!executed.ok || !original.ok) return;
  expect(executed.ir.instanceTracks).toEqual(original.ir.instanceTracks.filter(t => t.targetId === "other"));
  expect(executed.ir.partTracks).toEqual(original.ir.partTracks!.filter(t => t.targetId === "other"));
  expect(executed.ir.cameraTracks).toEqual(original.ir.cameraTracks);
});

it("anchor uses current sampled position, rotation and scale instead of stored base pose", () => {
  const canvas = anchorCanvas([
    'motion.instance.tween("inst-1", { property: "position", startTime: 0, endTime: 4, from: [6,-3,0], to: [6,-3,0] });',
    'motion.instance.tween("inst-1", { property: "rotation", startTime: 0, endTime: 4, from: [0,0,180], to: [0,0,180] });',
    'motion.instance.tween("inst-1", { property: "scale", startTime: 0, endTime: 4, from: [2], to: [2] });'
  ].join('\n'));
  canvas.nodeData.m1.sharedWorldInstance = { ...instance, transform: { ...instance.transform, rotation: [0,0,0,1], scale: 1 } } as never;
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 }, new Map([["m1", [1, 0, 0] as [number, number, number]]]))!;
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1, v: 0 })!.unbindCandidates).toEqual([]);
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1.1, v: 0 })!.unbindCandidates).toHaveLength(1);
});

it("composes animation rotation with a nonidentity base pose and overrides scale", () => {
  const canvas = anchorCanvas([
    'motion.instance.tween("inst-1", { property: "position", startTime: 0, endTime: 4, from: [0,-3,0], to: [0,-3,0] });',
    'motion.instance.tween("inst-1", { property: "rotation", startTime: 0, endTime: 4, from: [0,0,180], to: [0,0,180] });',
    'motion.instance.tween("inst-1", { property: "scale", startTime: 0, endTime: 4, from: [2], to: [2] });'
  ].join('\n'));
  canvas.nodeData.m1.sharedWorldInstance = { ...instance, transform: { ...instance.transform, rotation: [0,0,1,0], scale: 2 } } as never;
  // Two half turns compose to identity; sampled absolute scale 2 gives anchor u=4.
  const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 }, new Map([["m1", [2, 0, 0] as [number, number, number]]]))!;
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1, v: 0 })!.unbindCandidates).toEqual([]);
  expect(planWorldGroundMoveWithAnimationParts(canvas, start, { u: 1.1, v: 0 })!.unbindCandidates).toHaveLength(1);
});
