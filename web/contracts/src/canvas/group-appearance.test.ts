import { describe, expect, it } from "vitest";
import { executeModelScriptV2 } from "./model-executor-v2.js";
import { prepareModelResource } from "./prepared-model.js";
import {
  DEFAULT_GROUP_APPEARANCE_SCRIPT,
  decodeGroupAppearance,
  defaultGroupAppearance,
  readGroupAppearanceForNode,
} from "./group-appearance.js";

describe("groupAppearance", () => {
  it("默认节点组徽标能执行、准备完整包围盒并共享确定资源身份", () => {
    const result = executeModelScriptV2(DEFAULT_GROUP_APPEARANCE_SCRIPT);
    if (!result.ok) throw Error(result.message);
    const first = prepareModelResource({ sceneVersion: result.scene.version, ops: result.scene.ops });
    const second = prepareModelResource({ sceneVersion: result.scene.version, ops: result.scene.ops });
    expect(first.resourceKey).toBe(second.resourceKey);
    expect(first.aabb).not.toBeNull();
    expect(first.extent).toBeGreaterThan(0);
    expect(result.scene.ops.some(op => "id" in op && op.id === "group-folder-tab")).toBe(true);
    expect(result.scene.ops.some(op => "id" in op && op.id === "group-folder-pocket")).toBe(true);
    expect(defaultGroupAppearance().model.placement.yaw).toBe(30);
  });
  it("缺失时读取确定默认值且不修改输入", () => {
    const data = {} as { groupAppearance?: unknown };
    const before = JSON.stringify(data);
    const result = readGroupAppearanceForNode(data as never);
    expect(result.source).toBe("default");
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.model.modelScript).toBe(DEFAULT_GROUP_APPEARANCE_SCRIPT);
    expect(JSON.stringify(data)).toBe(before);
  });

  it("拒绝未知版本和外部资源字段", () => {
    const valid = defaultGroupAppearance();
    expect(decodeGroupAppearance({ ...valid, schemaVersion: 2 }).ok).toBe(false);
    expect(decodeGroupAppearance({ ...valid, model: { ...valid.model, externalUrl: "https://example.invalid/model.glb" } }).ok).toBe(false);
    expect(decodeGroupAppearance({ ...valid, model: { ...valid.model, externalAssetId: "asset-1" } }).ok).toBe(false);
  });

  it("读取合法自定义定义并保留内容身份", () => {
    const custom = defaultGroupAppearance();
    custom.model.modelScript = "scene.box({ id: 'custom', size: [1, 2, 1] });";
    const result = readGroupAppearanceForNode({ groupAppearance: custom } as never);
    expect(result.source).toBe("custom");
    expect(result.value.model.modelScript).toContain("custom");
  });
});

it("keeps unsupported stored data, rejects new invalid writes atomically and roundtrips appearance edits through history", async () => {
  const { createEmptyWoohaa3ServerCanvas, applyCanvasCommands, planCanvasEdit } = await import("../index.js");
  let canvas = createEmptyWoohaa3ServerCanvas("appearance-history", "2026-10-25");
  canvas.document.nodes = [{ id: "g", type: "group", position: { x: 0, y: 0 } }, { id: "child", type: "text", parentId: "g", position: { x: 40, y: 40 } }];
  canvas.nodeData = { g: { title: "Group" }, child: {} };
  const appearance = defaultGroupAppearance();
  appearance.model.modelScript = 'scene.box({id:"custom"});';
  const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "g", value: { groupAppearance: appearance } }]);
  if (!plan.ok) throw Error(plan.reason);
  const apply = (edit: typeof plan.forward) => {
    const result = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit }]);
    if (!result.ok) throw Error(result.rejection.message); canvas = result.canvas;
  };
  apply(plan.forward); expect(canvas.nodeData.g.groupAppearance?.model.modelScript).toContain("custom");
  apply(plan.inverse); expect(canvas.nodeData.g.groupAppearance).toBeUndefined();
  apply(plan.forward); expect(canvas.document.nodes).toHaveLength(2);
  const bad = applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "child", value: { title: "partial" } }, { type: "nodeData.patch", nodeId: "g", value: { groupAppearance: { schemaVersion: 8, model: {} } as never } }]);
  expect(bad.ok).toBe(false); expect(canvas.nodeData.child.title).toBeUndefined();
  const future = { schemaVersion: 8, model: { future: "preserved" } };
  canvas.nodeData.g.groupAppearance = future as never;
  const read = readGroupAppearanceForNode(canvas.nodeData.g);
  expect(read.source).toBe("unsupported"); expect(read.diagnostic).toBeTruthy();
  expect(canvas.nodeData.g.groupAppearance).toEqual(future);
  const rename = applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "g", value: { title: "Renamed" } }]);
  if (!rename.ok) throw Error(rename.rejection.message);
  expect(rename.canvas.nodeData.g.groupAppearance).toEqual(future);
});
