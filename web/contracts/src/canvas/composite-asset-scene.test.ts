import { describe, expect, it } from "vitest";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { compositeAssetSceneOps } from "./composite-asset-scene.js";
import { v2SceneAabb } from "./scene-ir-v2.js";
const source = "scene.group({id:'parent'}); scene.box({id:'child',parent:'parent',size:[2,2,2]});";
describe("共同资产根", () => {
  it("根变换只作用于层级顶层且不改变作者源码或内部 parent", () => {
    const execution = executeModelScriptVersioned(source, "woohaa-model-js-v2");
    if (!execution.ok) throw new Error("fixture failed");
    const before = JSON.stringify(execution.scene.ops);
    const ops = compositeAssetSceneOps(execution.scene.ops, { offset: { x: 5, y: 0, z: 0 }, scale: 2, yaw: 0 });
    const child = ops.find(op => op.id === "child");
    expect(child && "parent" in child ? child.parent : undefined).toBe("parent");
    const bounds = v2SceneAabb(ops)!;
    const original = v2SceneAabb(execution.scene.ops)!;
    expect(bounds.min[0]).toBeCloseTo(original.min[0] * 2 + 5);
    expect(bounds.max[0]).toBeCloseTo(original.max[0] * 2 + 5);
    expect(JSON.stringify(execution.scene.ops)).toBe(before);
  });
});
