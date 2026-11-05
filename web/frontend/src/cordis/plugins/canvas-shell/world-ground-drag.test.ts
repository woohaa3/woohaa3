/**
 * 共享世界模型直接地面拖动：纯规则回归。
 *
 * 关注三件事：命中筛选只认合法 `sharedWorldInstance`；增量只改地面 `u/v` 并保留高度、
 * 姿态与实例身份；无位移不提交（不产生空撤销记录）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import {
  beginWorldGroundDrag,
  beginWorldGroundDragMany,
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

  it("不影响其它 nodeData 字段（脚本、内容身份等原样保留在 patch 之外）", () => {
    const canvas = canvasWith(instance, { modelScript: "scene.box({ id: 'body' });" });
    const start = beginWorldGroundDrag(canvas, "m1", { u: 0, v: 0 })!;
    const command = planWorldGroundMove(start, { u: 1, v: 0 })![0] as { value: Record<string, unknown> };
    expect(Object.keys(command.value)).toEqual(["sharedWorldInstance"]);
  });
});
