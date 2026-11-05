/**
 * `ServerCanvas` ⇄ Y.Doc 映射测试（任务 2.1）。
 *
 * 覆盖：全部 fixture 的语义往返、确定性顺序（不依赖 Y.Map 迭代顺序）、非法引用不产生
 * 修剪后的空画布，以及格式版本闸门。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseCanvasAggregate, type ServerCanvas } from "../domain/index.js";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SHARED_TYPES } from "./format.js";
import { serverCanvasToYDoc,
  yDocToServerCanvas,
  yjsSharedTypes } from "./mapping.js";

import { ALL_FIXTURES, FIXTURE_NOW } from "./__fixtures__/canvases.js";

function normalize(canvas: ServerCanvas): ServerCanvas {
  const parsed = parseCanvasAggregate(canvas, { now: FIXTURE_NOW });
  if (!parsed.ok) throw new Error(`fixture 解析失败：${parsed.failure.message}`);
  return parsed.canvas;
}

/** 只比较持久化字段；revision/updatedAt 由命令 transaction 决定，不参与映射语义比较。 */
function persistedShape(canvas: ServerCanvas) {
  return {
    id: canvas.id,
    title: canvas.title,
    nodes: canvas.document.nodes,
    edges: canvas.document.edges,
    nodeData: canvas.nodeData,
    assets: canvas.assets,
    jobs: canvas.jobs
  };
}

describe("映射往返（任务 2.1）", () => {
  for (const { name, build } of ALL_FIXTURES) {
    it(`${name} 往返语义等价`, () => {
      const original = normalize(build());
      const doc = serverCanvasToYDoc(original);
      const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(persistedShape(exported.canvas)).toEqual(persistedShape(original));
      expect(exported.canvas.revision).toBe(original.revision);
    });
  }


  it("悬空 parent 的 Y.Doc 导出被拒绝（不静默修剪）", () => {
    const base = ALL_FIXTURES[0].build();
    const canvas = normalize({
      ...base,
      document: {
        ...base.document,
        nodes: [{ id: "orphan", type: "image", position: { x: 0, y: 0 }, width: 200, height: 100, parentId: "missing" }],
        edges: []
      }
    });
    const doc = serverCanvasToYDoc(canvas);
    // 直接篡改 Y.Doc，模拟协作端写入悬空 parent。
    const shared = yjsSharedTypes(doc);
    doc.transact(() => {
      shared.nodes.set("orphan", { id: "orphan", type: "image", position: { x: 0, y: 0 }, width: 200, height: 100, parentId: "missing" });
    });
    const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.failure.code).toBe("dangling-parent");
  });
});

describe("确定性顺序（任务 2.1）", () => {
  it("节点按 zIndex/id 输出，与 Y.Map 插入顺序无关", () => {
    const canvas = normalize(ALL_FIXTURES[1].build());
    const doc = new Y.Doc();
    // 故意以「非输出顺序」写入 Y.Map。
    const shared = yjsSharedTypes(doc);
    doc.transact(() => {
      shared.meta.set("formatVersion", YJS_CANVAS_FORMAT_VERSION);
      shared.meta.set("id", "canvas-order");
      shared.meta.set("revision", 1);
      shared.meta.set("title", "顺序画布");
      shared.nodes.set("image-1", { id: "image-1", type: "image", position: { x: 640, y: 0 }, zIndex: 2 });
      shared.nodes.set("text-1", { id: "text-1", type: "text", position: { x: 0, y: 0 }, zIndex: 1 });
    });
    const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.map((node) => node.id)).toEqual(["text-1", "image-1"]);
    // 与整体写入的结果一致。
    const reference = yDocToServerCanvas(serverCanvasToYDoc(canvas), { now: FIXTURE_NOW });
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(exported.canvas.document.nodes.map((node) => node.id))
      .toEqual(reference.canvas.document.nodes.map((node) => node.id));
  });

  it("资产/任务按 id、nodeData 按 key 输出", () => {
    const doc = new Y.Doc();
    serverCanvasToYDoc(normalize(ALL_FIXTURES[2].build()), doc);
    const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const ids = exported.canvas.assets.map((asset) => asset.id);
    expect([...ids].sort()).toEqual(ids);
    const jobIds = exported.canvas.jobs.map((job) => job.id);
    expect([...jobIds].sort()).toEqual(jobIds);
    const dataKeys = Object.keys(exported.canvas.nodeData);
    expect([...dataKeys].sort()).toEqual(dataKeys);
  });
});

describe("非法状态与格式闸门（任务 2.1）", () => {
  it("缺少 meta.id 导出失败（不创建空画布）", () => {
    const doc = new Y.Doc();
    const result = yDocToServerCanvas(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("missing-meta-id");
  });

  it("不支持的格式版本导出失败", () => {
    const doc = new Y.Doc();
    serverCanvasToYDoc(normalize(ALL_FIXTURES[0].build()), doc);
    const shared = yjsSharedTypes(doc);
    doc.transact(() => shared.meta.set("formatVersion", "woohaa3-ycanvas-v99"));
    const result = yDocToServerCanvas(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("unsupported-format");
  });

  it("非法引用（缺失边端点）导出失败，而不是修剪成空画布", () => {
    const doc = new Y.Doc();
    const shared = yjsSharedTypes(doc);
    doc.transact(() => {
      shared.meta.set("formatVersion", YJS_CANVAS_FORMAT_VERSION);
      shared.meta.set("id", "canvas-broken");
      shared.meta.set("revision", 1);
      shared.meta.set("title", "坏画布");
      shared.nodes.set("n1", { id: "n1", type: "text", position: { x: 0, y: 0 } });
      // 边指向不存在的目标。
      shared.edges.set("e1", { id: "e1", source: "n1", target: "ghost", data: {} });
    });
    const result = yDocToServerCanvas(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("dangling-edge-endpoint");
    // 关键：不得返回修剪后的画布。
    expect("canvas" in result).toBe(false);
  });

  it("meta.revision 缺失或非整数导出失败", () => {
    const doc = new Y.Doc();
    const shared = yjsSharedTypes(doc);
    doc.transact(() => {
      shared.meta.set("formatVersion", YJS_CANVAS_FORMAT_VERSION);
      shared.meta.set("id", "canvas-x");
      shared.meta.set("revision", -1);
    });
    const result = yDocToServerCanvas(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid-revision");
  });

  it("顶层 shared type 名固定（契约）", () => {
    const doc = new Y.Doc();
    serverCanvasToYDoc(normalize(ALL_FIXTURES[0].build()), doc);
    for (const key of Object.values(YJS_SHARED_TYPES)) {
      expect(doc.getMap(key)).toBeTruthy();
    }
  });
});

