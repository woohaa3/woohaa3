import { describe, expect, it } from "vitest";
import { serverCanvasToYDoc, yDocToServerCanvas } from "./yjs/index.js";
import {
  createEmptyWoohaa3ServerCanvas, type ServerCanvas, type CanvasCommand, type EditPlan,
  applyCanvasCommands, planCanvasEdit, createFilmSetSnapshot, canonicalFilmSetFields,
  createModel3DNodeData, model3DNodeDataFields, decodeFilmSetNodeData, filmSetAnimationsOf,
  filmSetItemEditHash, modelSourceHash, shotImageReferenceIdentity, shotReferenceContentIdentity,
  createFilmSetObjectResolver, filmSetObjectContainerData, filmSetObjectContainerId, resolveFilmSetObject, isFilmSetNode,
  isCanvasCommandSatisfied, decodeEditApplyCommand
} from "../index.js";

const NOW = "2026-10-24T00:00:00.000Z";
const containerId = filmSetObjectContainerId("film", "model");
function fixture(motion = 'motion.model.rotate("root", {speed:1});') {
  const canvas = createEmptyWoohaa3ServerCanvas("objects", NOW);
  const animation = createFilmSetSnapshot({ title: "片场", model: { modelScript: 'scene.box({id:"arm",size:[1,1,1]});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: motion, timeline: { duration: 3, loop: false } });
  animation.filmSetContent.items.find(item => item.id === "model")!.localTransform = { offset: { x: 2, y: 1, z: 4 }, scale: 2, yaw: 0.6 };
  canvas.document.nodes = [
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 320, height: 240 },
    { id: "source", type: "model3d", position: { x: 600, y: 0 } },
    { id: "image", type: "image", position: { x: 900, y: 0 } }
  ];
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  canvas.nodeData.source = model3DNodeDataFields(createModel3DNodeData({ title: "新模型", model: { modelScript: 'scene.sphere({id:"body",radius:1});', modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  return canvas;
}
function apply(canvas: ServerCanvas, commands: CanvasCommand[]) {
  const result = applyCanvasCommands(canvas, commands, { now: NOW });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.canvas;
}
function animation(canvas: ServerCanvas) {
  const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}
function entrance(canvas: ServerCanvas) {
  return apply(canvas, [{ type: "node.add", node: { id: containerId, type: "composite-asset", position: { x: 400, y: 100 }, width: 248, height: 232 }, nodeData: filmSetObjectContainerData("film", "model") }]);
}
function replacement(canvas: ServerCanvas): CanvasCommand {
  return { type: "filmSet.itemPatch", nodeId: "film", itemId: "model", op: {
    kind: "replace-model", sourceNodeId: "source", expectedSourceHash: modelSourceHash(String(canvas.nodeData.source.modelScript)),
    expectedModelHash: (canvas.nodeData.source.modelContentVersion as unknown as { contentHash: string }).contentHash,
    expectedItemHash: filmSetItemEditHash(animation(canvas).filmSetContent.items.find(item => item.id === "model")!), importedAt: NOW
  } };
}
function edit(canvas: ServerCanvas, plan: EditPlan["forward"]) {
  return apply(canvas, [{ type: "edit.apply", ...plan }]);
}

describe("片场对象容器", () => {
  it("一轮批量解析共享源快照，后续编辑使用新快照且不污染先前结果", () => {
    const canvas = entrance(fixture()), resolve = createFilmSetObjectResolver(canvas);
    const first = resolve(containerId)!;
    for (const node of canvas.document.nodes) {
      const target = resolve(node.id);
      if (target) expect(target.animation).toBe(first.animation);
    }
    const changed = apply(canvas, [replacement(canvas)]);
    const next = createFilmSetObjectResolver(changed)(containerId)!;
    expect(next.item).not.toEqual(first.item);
    expect(first.item).toEqual(resolve(containerId)!.item);
    expect(next.item).toEqual(resolveFilmSetObject(changed, containerId)!.item);
  });
  it("自动维护唯一归属，不被解码为独立场景；不保存第二份模型", () => {
    const canvas = entrance(fixture());
    expect(resolveFilmSetObject(canvas, containerId)?.item.id).toBe("model");
    expect(isFilmSetNode("composite-asset", canvas.nodeData[containerId])).toBe(false);
    expect(decodeFilmSetNodeData(canvas.nodeData[containerId]).ok).toBe(false);
    expect(Object.keys(canvas.nodeData[containerId]).sort()).toEqual(["compositeAssetRole", "extensionId", "filmSetObject"]);
    expect(applyCanvasCommands(canvas, [{ type: "node.add", node: { id: "forged", type: "composite-asset", position: { x: 0, y: 0 } }, nodeData: filmSetObjectContainerData("film", "model") }]).ok).toBe(false);
  });
  it("拒绝伪造归属、改写归属、注入模型及普通连线", () => {
    const canvas = entrance(fixture());
    for (const value of [{ title: "伪造" }, { filmSetObject: { schemaVersion: 1, filmSetNodeId: "film", itemId: "ground" } }, null]) {
      expect(applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: containerId, value: value as never }]).ok).toBe(false);
    }
    expect(applyCanvasCommands(canvas, [{ type: "edge.add", edge: { id: "bad", source: "source", target: containerId } }]).ok).toBe(false);
    expect(applyCanvasCommands(canvas, [{ type: "edge.add", edge: { id: "bad", source: containerId, target: "image" } }]).ok).toBe(false);
    const data = { ...filmSetObjectContainerData("film", "model"), modelScript: "scene.box({});" };
    expect(applyCanvasCommands(fixture(), [{ type: "node.add", node: { id: containerId, type: "composite-asset", position: { x: 0, y: 0 } }, nodeData: data as never }]).ok).toBe(false);
  });
  it("移动片场会带动容器，显式拖动容器不叠加位移", () => {
    const canvas = entrance(fixture());
    const moved = apply(canvas, [{ type: "node.update", nodeId: "film", position: { x: 100, y: 100 } }]);
    expect(moved.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: 500, y: 200 });
    const explicit = apply(canvas, [{ type: "node.update", nodeId: "film", position: { x: 100, y: 100 } }, { type: "node.update", nodeId: containerId, position: { x: 800, y: 300 } }]);
    expect(explicit.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: 800, y: 300 });
  });
  it("移除容器保留对象；删除对象或片场清理容器，撤销恢复原布局", () => {
    const canvas = entrance(fixture());
    expect(animation(apply(canvas, [{ type: "node.remove", nodeIds: [containerId] }])).filmSetContent.items.some(item => item.id === "model")).toBe(true);
    for (const command of [{ type: "filmSet.itemPatch", nodeId: "film", itemId: "model", op: { kind: "delete" } }, { type: "node.remove", nodeIds: ["film"] }] as CanvasCommand[]) {
      const plan = planCanvasEdit(canvas, [command]);
      expect(plan.ok).toBe(true); if (!plan.ok) continue;
      const removed = edit(canvas, plan.forward);
      expect(removed.document.nodes.some(node => node.id === containerId)).toBe(false);
      const restored = edit(removed, plan.inverse);
      expect(resolveFilmSetObject(restored, containerId)?.item.id).toBe("model");
      expect(restored.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: 400, y: 100 });
    }
  });
});

describe("对象容器默认显示和关闭", () => {
  it("旧片场首次写入补齐所有对象，隐藏持久化且不影响对象内容", () => {
    const canvas = apply(fixture(), [{ type: "nodeData.patch", nodeId: "film", value: {} }]);
    for (const item of animation(canvas).filmSetContent.items) expect(resolveFilmSetObject(canvas, filmSetObjectContainerId("film", item.id))?.item.id).toBe(item.id);
    const before = animation(canvas);
    const hidden = apply(canvas, [{ type: "nodeData.patch", nodeId: "film", value: { filmSetObjectContainersHidden: ["model"] } }]);
    expect(hidden.document.nodes.some(node => node.id === containerId)).toBe(false);
    expect(animation(hidden)).toEqual(before);
    const doc = serverCanvasToYDoc(hidden);
    try {
      const loaded = yDocToServerCanvas(doc, { now: NOW });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.canvas.nodeData.film.filmSetObjectContainersHidden).toEqual(["model"]);
    } finally { doc.destroy(); }
    const again = apply(hidden, [{ type: "nodeData.patch", nodeId: "film", value: { title: "重命名" } }]);
    expect(again.document.nodes.some(node => node.id === containerId)).toBe(false);
    const shown = apply(again, [{ type: "nodeData.patch", nodeId: "film", value: { filmSetObjectContainersHidden: [] } }]);
    expect(resolveFilmSetObject(shown, containerId)?.item.id).toBe("model");
  });
  it("关闭／显示可撤销重做，恢复容器原位置且保留其他容器", () => {
    const canvas = entrance(fixture());
    const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "film", value: { filmSetObjectContainersHidden: ["model"] } }]);
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const hidden = edit(canvas, plan.forward);
    expect(hidden.document.nodes.some(node => node.id === containerId)).toBe(false);
    const restored = edit(hidden, plan.inverse);
    expect(restored.document.nodes.find(node => node.id === containerId)).toEqual(canvas.document.nodes.find(node => node.id === containerId));
    expect(edit(restored, plan.forward).document.nodes.some(node => node.id === containerId)).toBe(false);
  });
  it("新建片场立即生成每个对象容器", () => {
    const source = fixture();
    const value = animation(source);
    value.filmSetContent.items.push({ ...structuredClone(value.filmSetContent.items[0]), id: "second" });
    source.nodeData.film = canonicalFilmSetFields(value) as never;
    const canvas = apply(createEmptyWoohaa3ServerCanvas("new", NOW), [{ type: "node.add", node: source.document.nodes[0], nodeData: source.nodeData.film }]);
    for (const item of animation(canvas).filmSetContent.items) expect(resolveFilmSetObject(canvas, filmSetObjectContainerId("film", item.id))?.item.id).toBe(item.id);
  });
  it("非法显示设置整批拒绝", () => {
    for (const value of [null, "model", [1], ["model", "model"]]) expect(applyCanvasCommands(entrance(fixture()), [{ type: "nodeData.patch", nodeId: "film", value: { filmSetObjectContainersHidden: value } as never }]).ok).toBe(false);
  });
});

describe("模型快照替换", () => {
  it("保留对象身份/摆放/整体动作；来源删除后副本独立，撤销重做恢复精确快照", () => {
    const canvas = entrance(fixture());
    const before = animation(canvas);
    const plan = planCanvasEdit(canvas, [replacement(canvas)]);
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    expect(decodeEditApplyCommand({ type: "edit.apply", ...plan.forward })).not.toBeNull();
    const replaced = edit(canvas, plan.forward);
    const item = animation(replaced).filmSetContent.items.find(item => item.id === "model")!;
    expect(item).toMatchObject({ id: "model", name: "片场", localTransform: before.filmSetContent.items.find(item => item.id === "model")!.localTransform, kind: "model", model: { modelScript: 'scene.sphere({id:"body",radius:1});' } });
    expect(filmSetAnimationsOf(animation(replaced)).clips[0].bindings[0].motion?.motionScript).toContain('"root"');
    expect(isCanvasCommandSatisfied(replaced, { type: "edit.apply", ...plan.forward })).toBe(true);
    const withoutSource = apply(replaced, [{ type: "node.remove", nodeIds: ["source"] }]);
    expect(animation(withoutSource).filmSetContent.items.find(item => item.id === "model")).toEqual(item);
    const undone = edit(withoutSource, plan.inverse);
    expect(animation(undone)).toEqual(before);
    expect(animation(edit(undone, plan.forward)).filmSetContent.items.find(item => item.id === "model")).toEqual(item);
  });
  it("不匹配的部件动作停用，撤销同时恢复动作与模型", () => {
    const canvas = fixture('motion.model.rotate("arm", {speed:1});');
    const before = animation(canvas);
    const plan = planCanvasEdit(canvas, [replacement(canvas)]);
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const changed = edit(canvas, plan.forward);
    expect(filmSetAnimationsOf(animation(changed)).clips[0].bindings[0].motion).toBeUndefined();
    expect(animation(edit(changed, plan.inverse))).toEqual(before);
  });
  it("来源改变、对象冲突或非模型来源整批拒绝", () => {
    const canvas = fixture(); const command = replacement(canvas);
    const changed = apply(canvas, [{ type: "nodeData.patch", nodeId: "source", value: { modelScript: 'scene.box({id:"new"});' } }]);
    expect(applyCanvasCommands(changed, [command]).ok).toBe(false);
    const moved = apply(canvas, [{ type: "filmSet.itemPatch", nodeId: "film", itemId: "model", op: { kind: "transform", localTransform: { offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 } } }]);
    expect(applyCanvasCommands(moved, [command]).ok).toBe(false);
    if (command.type === "filmSet.itemPatch" && command.op.kind === "replace-model") command.op.sourceNodeId = "image";
    expect(applyCanvasCommands(canvas, [command]).ok).toBe(false);
  });
  it("替换几何使图片/视频内容身份失效，不改变已有镜头身份", () => {
    const canvas = fixture(); const old = animation(canvas);
    const next = animation(apply(canvas, [replacement(canvas)]));
    expect(shotReferenceContentIdentity({ animation: old, clipId: "clip-1" })).not.toEqual(shotReferenceContentIdentity({ animation: next, clipId: "clip-1" }));
    for (const value of [old, next]) { const clip = filmSetAnimationsOf(value).clips[0]; clip.kind = "static"; clip.timeline = { duration: 0, loop: false }; clip.bindings = []; }
    expect(shotImageReferenceIdentity({ animation: old, clipId: "clip-1", assets: [], background: "#ffffff" })).not.toEqual(shotImageReferenceIdentity({ animation: next, clipId: "clip-1", assets: [], background: "#ffffff" }));
  });
});


it("容器随片场重设分组并保持相对距离，撤销恢复分组和位置", () => {
  const canvas = entrance(fixture());
  const grouped = apply(canvas, [{ type: "node.add", node: { id: "group", type: "group", position: { x: 1000, y: 500 }, width: 1200, height: 900 } }]);
  const plan = planCanvasEdit(grouped, [{ type: "node.update", nodeId: "film", parentId: "group", position: { x: 100, y: 100 } }]);
  expect(plan.ok).toBe(true); if (!plan.ok) return;
  const moved = edit(grouped, plan.forward);
  expect(moved.document.nodes.find(node => node.id === containerId)).toMatchObject({ parentId: "group", position: { x: 500, y: 200 } });
  const restored = edit(moved, plan.inverse);
  expect(restored.document.nodes.find(node => node.id === containerId)).toMatchObject({ position: { x: 400, y: 100 } });
  expect(restored.document.nodes.find(node => node.id === containerId)?.parentId).toBeUndefined();
});

it("地面对象也能替换为模型；撤销恢复原对象种类和摆放", () => {
  const canvas = fixture();
  const value = animation(canvas);
  const previous = value.filmSetContent.items.find(item => item.id === "model")!;
  value.filmSetContent.items = [{ id: previous.id, name: previous.name, kind: "ground", size: { width: 5, depth: 5 }, color: "#888888", localTransform: previous.localTransform }];
  for (const clip of filmSetAnimationsOf(value).clips) clip.bindings = [];
  canvas.nodeData.film = canonicalFilmSetFields(value) as never;
  const plan = planCanvasEdit(canvas, [replacement(canvas)]);
  expect(plan.ok).toBe(true); if (!plan.ok) return;
  const changed = edit(canvas, plan.forward);
  expect(animation(changed).filmSetContent.items[0]).toMatchObject({ kind: "model", id: previous.id, localTransform: previous.localTransform });
  expect(animation(edit(changed, plan.inverse))).toEqual(animation(canvas));
});

it("保护替换期间对象的完整动作闭包，拒绝覆盖并发新增的绑定", () => {
  const canvas = fixture();
  const plan = planCanvasEdit(canvas, [replacement(canvas)]);
  expect(plan.ok).toBe(true); if (!plan.ok) return;
  const addBinding = (current: ServerCanvas) => {
    const next = structuredClone(current), value = animation(next), collection = filmSetAnimationsOf(value);
    collection.clips.push({ ...structuredClone(collection.clips[0]), id: "concurrent", name: "新增镜头" });
    next.nodeData.film = canonicalFilmSetFields(value) as never;
    return next;
  };
  expect(applyCanvasCommands(addBinding(canvas), [{ type: "edit.apply", ...plan.forward }]).ok).toBe(false);
  const changed = edit(canvas, plan.forward);
  expect(applyCanvasCommands(addBinding(changed), [{ type: "edit.apply", ...plan.inverse }]).ok).toBe(false);
});

it("非法快照时间不写入对象来源", () => {
  const canvas = fixture(), command = replacement(canvas);
  if (command.type === "filmSet.itemPatch" && command.op.kind === "replace-model") command.op.importedAt = "invalid";
  expect(applyCanvasCommands(canvas, [command]).ok).toBe(false);
});


it("保存并重新加载 Yjs 快照后保留容器归属与已复制模型", () => {
  const canvas = entrance(fixture());
  const changed = apply(canvas, [replacement(canvas)]);
  const doc = serverCanvasToYDoc(changed);
  try {
    const loaded = yDocToServerCanvas(doc, { now: NOW });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(resolveFilmSetObject(loaded.canvas, containerId)?.item).toEqual(resolveFilmSetObject(changed, containerId)?.item);
    expect(loaded.canvas.nodeData[containerId]).toEqual(changed.nodeData[containerId]);
  } finally { doc.destroy(); }
});
