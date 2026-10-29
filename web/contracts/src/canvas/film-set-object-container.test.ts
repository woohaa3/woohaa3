import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, canonicalFilmSetFields, filmSetObjectContainerId, filmSetObjectContainerData, createFilmSetObjectResolver, readFilmSetGroupMarker, migrateLegacyFilmSetToGroup, type CanvasCommand } from "../index.js";

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("objects");
  const animation = createFilmSetSnapshot({ title: "片场", model: { modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 3, loop: false } });
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 100, y: 60 } }];
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return canvas;
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
  it("历史容器残留内容字段时就地收敛，不再让整张画布的所有命令失败", () => {
    const canvas = entrance(fixture());
    // 旧数据把片场/模型内容写在了容器上；严格拒绝会让与该容器无关的 node.add / edge.add 也全部失败
    // （用户表现：新建节点、连线、从端口拉线全部无效）。
    canvas.nodeData[containerId] = {
      ...(canvas.nodeData[containerId] as Record<string, unknown>),
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      sceneCamera: { azimuth: 0, elevation: 0.7853981633974483, distance: 4, aspect: "16:9" },
      filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] },
      animationSnapshotHash: "legacy",
      modelScriptStatus: "ok",
      modelScriptError: null
    } as never;
    const next = apply(canvas, [{ type: "node.add", node: { id: "probe", type: "text", position: { x: 10, y: 10 } } }]);
    expect(next.document.nodes.some(node => node.id === "probe")).toBe(true);
    expect(Object.keys(next.nodeData[containerId] as object).sort()).toEqual(["compositeAssetRole", "extensionId", "filmSetObject"]);
    // 不变式仍对新的写入生效：容器不能被普通 patch 改写。
    expect(applyCanvasCommands(next, [{ type: "nodeData.patch", nodeId: containerId, value: { modelScriptStatus: "failed" } as never }]).ok).toBe(false);
  });
  it("移动片场会带动容器，显式拖动容器不叠加位移", () => {
    const canvas = entrance(fixture());
    const moved = apply(canvas, [{ type: "node.update", nodeId: "film", position: { x: 100, y: 100 } }]);
    expect(moved.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: 500, y: 200 });
    const explicit = apply(canvas, [{ type: "node.update", nodeId: "film", position: { x: 100, y: 100 } }, { type: "node.update", nodeId: containerId, position: { x: 800, y: 300 } }]);
    expect(explicit.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: 800, y: 300 });
  });
  it("容器内真实 model3d 子节点不能被普通命令移动或改写", () => {
    const canvas = entrance(fixture());
    const modelId = filmSetObjectModelNodeId("film", "model");
    expect(applyCanvasCommands(canvas, [{ type: "node.update", nodeId: modelId, position: { x: 80, y: 40 } }]).ok).toBe(false);
    expect(applyCanvasCommands(canvas, [{ type: "node.update", nodeId: modelId, parentId: null }]).ok).toBe(false);
    expect(applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: modelId, value: { title: "伪造" } }]).ok).toBe(false);
    expect(canvas.document.nodes.find(node => node.id === modelId)?.position).toEqual({ x: 12, y: 12 });
  });
  it("模型卡片留出内边距，容器缩放、移动及撤销不改变相对位置", () => {
    const canvas = entrance(fixture());
    const modelId = filmSetObjectModelNodeId("film", "model");
    const card = canvas.document.nodes.find(node => node.id === modelId)!;
    expect(card).toMatchObject({ parentId: containerId, position: { x: 12, y: 12 }, width: 224, height: 208 });
    const plan = planCanvasEdit(canvas, [{ type: "node.update", nodeId: containerId, position: { x: 720, y: 240 }, width: 320, height: 280 }]);
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const moved = edit(canvas, plan.forward);
    expect(moved.document.nodes.find(node => node.id === modelId)).toMatchObject({ parentId: containerId, position: { x: 12, y: 12 }, width: 296, height: 256 });
    expect(edit(moved, plan.inverse).document.nodes.find(node => node.id === modelId)).toEqual(card);
  });
  it("旧卡片恢复内边距时不把派生位置写入独立的撤销操作", () => {
    const canvas = entrance(fixture());
    const modelId = filmSetObjectModelNodeId("film", "model");
    Object.assign(canvas.document.nodes.find(node => node.id === modelId)!, { position: { x: 0, y: 0 }, width: 248, height: 232 });
    const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "film", value: { title: "新标题" } }]);
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const updated = edit(canvas, plan.forward);
    expect(updated.document.nodes.find(node => node.id === modelId)).toMatchObject({ position: { x: 12, y: 12 }, width: 224, height: 208 });
    expect(applyCanvasCommands(updated, [{ type: "edit.apply", ...plan.inverse }]).ok).toBe(true);
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

  it("兼容 reader 读取旧 shell 不写入快照或派生节点", () => {
    const canvas = fixture();
    const id = filmSetObjectContainerId("film", "model");
    canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 400, y: 100 } });
    canvas.nodeData[id] = filmSetObjectContainerData("film", "model");
    const before = structuredClone(canvas);
    expect(createFilmSetObjectResolver(canvas)(id)?.item.id).toBe("model");
    expect(canvas).toEqual(before);
  });

  it("迁移移除旧 shell、未标记后代及其边，保留真正资源和镜头", () => {
    const canvas = fixture();
    const id = filmSetObjectContainerId("film", "model");
    canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 400, y: 100 } }, { id: "old-child", type: "model3d", parentId: id, position: { x: 12, y: 12 } });
    canvas.nodeData[id] = filmSetObjectContainerData("film", "model");
    canvas.nodeData["old-child"] = { modelScript: "scene.box({id:'old'});" };
    canvas.document.edges.push({ id: "old-edge", source: "old-child", target: "film", data: {} });
    const migrated = migrateFilmSetFixture(canvas, "film");
    expect(migrated.document.nodes.some(node => node.id === id || node.id === "old-child")).toBe(false);
    expect(migrated.document.edges).toEqual([]);
    expect(migrated.nodeData[id]).toBeUndefined();
    expect(migrated.nodeData["old-child"]).toBeUndefined();
    const binding = readFilmSetGroupMarker(migrated.nodeData.film)!.sceneBindings[0]!;
    expect(migrated.document.nodes.find(node => node.id === binding.sourceNodeId)?.parentId).toBe("film");
    expect(migrated.nodeData[binding.sourceNodeId]?.modelScript).toContain("body");
    expect(migrated.nodeData.film.filmSetContent).toBeUndefined();
  });

  it("物化失败不删除旧容器或改写原 owner", () => {
    const canvas = fixture();
    (canvas.nodeData.film.filmSetContent as { items: unknown[] }).items.push({ id: "bad", kind: "model", model: {} });
    const before = structuredClone(canvas);
    expect(migrateLegacyFilmSetToGroup(canvas, "film", { commandId: "atomic" }).ok).toBe(false);
    expect(canvas).toEqual(before);
  });

  it("迁移重试不重复物化，后续普通命令不会重建容器", () => {
    const migrated = migrateFilmSetFixture(fixture(), "film");
    const repeated = migrateLegacyFilmSetToGroup(migrated, "film", { commandId: "test-group-migration", groupId: "film" });
    expect(repeated).toMatchObject({ ok: true, duplicate: true, createdNodeIds: [] });
    const next = applyCanvasCommands(migrated, [{ type: "canvas.setTitle", title: "新标题" }]);
    expect(next.ok).toBe(true);
    if (!next.ok) throw Error(next.rejection.message);
    expect(next.canvas.document.nodes.map(node => node.type)).toEqual(migrated.document.nodes.map(node => node.type));
    expect(next.canvas.document.nodes.every(node => node.type !== "composite-asset")).toBe(true);
  });
});
