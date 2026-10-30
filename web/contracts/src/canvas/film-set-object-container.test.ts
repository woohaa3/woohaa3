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

describe("旧对象容器的只读边界", () => {
  it("旧 owner、对象 patch 和容器新增均原子拒绝", () => {
    const canvas = fixture();
    const before = structuredClone(canvas);
    const commands: CanvasCommand[] = [
      { type: "nodeData.patch", nodeId: "film", value: { title: "修改" } },
      { type: "filmSet.itemPatch", nodeId: "film", itemId: "model", op: { kind: "delete" } },
      { type: "node.add", node: { id: filmSetObjectContainerId("film", "model"), type: "composite-asset", position: { x: 0, y: 0 } }, nodeData: filmSetObjectContainerData("film", "model") }
    ];
    for (const command of commands) {
      expect(applyCanvasCommands(canvas, [{ type: "canvas.setTitle", title: "不能部分提交" }, command]).ok).toBe(false);
      expect(canvas).toEqual(before);
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
