/**
 * prepared model resource 单元测试
 * （change: optimize-model-scene-snapshot-hot-path，任务 1.1 / 1.2 / 1.4；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only）。
 */
import { describe, expect, it, vi } from "vitest";
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "./model-script.js";
import { modelPrepareRequest, prepareModelResource } from "./prepared-model.js";
import { v2SceneAabb, v2SceneExtent, type SceneV2Op } from "./scene-ir-v2.js";

const V2_OPS: SceneV2Op[] = [
  { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
];

describe("prepareModelResource", () => {
  it("V2 派生的 extent / AABB 与既有一致", () => {
    const resource = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: V2_OPS });
    expect(resource.extent).toBe(v2SceneExtent(V2_OPS));
    expect(resource.aabb).toEqual(v2SceneAabb(V2_OPS));
    expect(resource.sceneVersion).toBe(MODEL_SCRIPT_SCENE_IR_V2_VERSION);
    expect(resource.resourceKey).toBe(`${MODEL_SCRIPT_SCENE_IR_V2_VERSION}:${resource.signature}`);
  });

  it("相同内容得到相同 signature/resourceKey，节点 id 不进入 key", () => {
    const a = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: V2_OPS });
    const b = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: [...V2_OPS] });
    expect(a.signature).toBe(b.signature);
    expect(a.resourceKey).toBe(b.resourceKey);
    expect(a.resourceKey).not.toContain("node");
  });

  it("内容变化产生不同 signature；payload 是稳定 JSON round-trip", () => {
    const a = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: V2_OPS });
    const changed: SceneV2Op[] = V2_OPS.map((op) => (op.t === "sphere" ? { ...op, radius: 2 } : op));
    const b = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: changed });
    expect(a.signature).not.toBe(b.signature);
    const parsed = JSON.parse(a.payload) as { resourceKey: string; ops: unknown[]; signature: string };
    expect(parsed.resourceKey).toBe(a.resourceKey);
    expect(parsed.signature).toBe(a.signature);
    expect(parsed.ops).toHaveLength(V2_OPS.length);
    expect(JSON.stringify(parsed)).toBe(a.payload);
  });

  it("大型 fixture 一次 prepare 只遍历一次并派生一次（计数器）", () => {
    // 20,000 顶点 mesh：只调用一次 prepare，payload 只序列化一次。
    const vertices: [number, number, number][] = [];
    for (let index = 0; index < 20_000; index += 1) {
      vertices.push([index * 1.234567, Math.floor(index / 100) * 0.987654, (index % 7) * 3.141592]);
    }
    const faces: number[][] = [];
    for (let index = 0; index < 30_000 && index + 2 < vertices.length; index += 1) {
      faces.push([index, index + 1, index + 2]);
    }
    const big: SceneV2Op[] = [
      { t: "mesh", id: "hull", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#cccccc", vertices, faces }
    ];
    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      const resource = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: big });
      expect(resource.extent).toBeGreaterThan(0);
      expect(resource.payload.length).toBeGreaterThan(1_000_000);
      // 一次 prepare：内容 identity 序列化 1 次 + payload 序列化 1 次（均为 O(n) 一次）。
      expect(stringifySpy).toHaveBeenCalledTimes(2);
    } finally {
      stringifySpy.mockRestore();
    }
  });
});


describe("modelPrepareRequest", () => {
  it("只传一份几何，保留 Unicode 和高精度数值的规范 JSON", () => {
    const ops = [{ ...V2_OPS[0], id: "球", position: [0.123456789012345, 0, 0] }] as SceneV2Op[];
    const canonical = JSON.stringify(ops);
    const request = modelPrepareRequest({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops, opsJson: canonical });
    const decoded = JSON.parse(request);
    expect(decoded.ops).toEqual(ops);
    expect(decoded.opsJson).toBeUndefined();
    expect(request).toContain(`"ops":${canonical}`);
    expect(request.length - canonical.length).toBeLessThan(200);
  });

  it("大型几何低于容量上限时不会因重复序列化超限", () => {
    const vertices = Array.from({ length: 170_000 }, (_, i): [number, number, number] => [i / 7, i / 13, i / 17]);
    const ops = [{ t: "mesh", id: "large", parent: null, position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], material: null, color: "#cccccc", vertices, faces: [] }] as SceneV2Op[];
    const request = modelPrepareRequest({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops });
    const opsBytes = new TextEncoder().encode(JSON.stringify(ops)).length;
    const requestBytes = new TextEncoder().encode(request).length;
    expect(opsBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(requestBytes).toBeLessThan(16 * 1024 * 1024);
    expect(requestBytes).toBeLessThan(opsBytes + 200);
  });
});
