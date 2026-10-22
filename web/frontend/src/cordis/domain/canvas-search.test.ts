/**
 * 画布作品查找测试（change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { searchCanvasNodes } from "./canvas-search.js";

const NOW = "2026-10-09T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

function withNodes(): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [
    { id: "img-aaaa", type: "image", position: { x: 0, y: 0 } },
    { id: "img-bbbb", type: "image", position: { x: 100, y: 0 } },
    { id: "vid-cccc", type: "video", position: { x: 200, y: 0 } },
    { id: "grp-dddd", type: "group", position: { x: -40, y: -40 }, width: 500, height: 400 },
    { id: "txt-eeee", type: "text", position: { x: 40, y: 40 }, parentId: "grp-dddd" }
  ];
  canvas.nodeData = {
    "img-aaaa": { title: "海边日落" },
    "img-bbbb": { title: "海边日落" },
    "vid-cccc": { title: "开场镜头" },
    "grp-dddd": { title: "场景组" },
    "txt-eeee": { title: "文案草稿" }
  };
  return canvas;
}

describe("searchCanvasNodes", () => {
  it("按名称匹配并稳定排序", () => {
    const results = searchCanvasNodes(withNodes(), { query: "海边日落" });
    expect(results.map((r) => r.nodeId)).toEqual(["img-aaaa", "img-bbbb"]);
    expect(results[0]!.typeLabel).toBe("图片");
  });

  it("按中文类型匹配", () => {
    const results = searchCanvasNodes(withNodes(), { query: "视频" });
    expect(results.map((r) => r.nodeId)).toContain("vid-cccc");
  });

  it("按类型 ID 匹配", () => {
    const results = searchCanvasNodes(withNodes(), { query: "image" });
    expect(results.map((r) => r.nodeId).sort()).toEqual(["img-aaaa", "img-bbbb"]);
  });

  it("类型筛选只保留指定类型（group 仍可搜索以定位）", () => {
    const results = searchCanvasNodes(withNodes(), { query: "", kinds: ["image"] });
    expect(results.map((r) => r.type)).toContain("image");
    expect(results.map((r) => r.type)).toContain("group");
    expect(results.map((r) => r.type)).not.toContain("video");
  });

  it("同名结果用组名与短 ID 区分", () => {
    const results = searchCanvasNodes(withNodes(), { query: "海边日落" });
    expect(results[0]!.shortId).toBe("aaaa");
    expect(results[1]!.shortId).toBe("bbbb");
  });

  it("组内节点显示所属组名", () => {
    const results = searchCanvasNodes(withNodes(), { query: "文案" });
    expect(results[0]!.groupName).toBe("场景组");
  });

  it("无结果显示空数组", () => {
    expect(searchCanvasNodes(withNodes(), { query: "不存在" })).toEqual([]);
  });

  it("空查询返回全部节点", () => {
    expect(searchCanvasNodes(withNodes(), { query: "  " }).length).toBe(5);
  });

  it("无显式名时按已提交提示词摘要匹配", () => {
    const canvas = base();
    canvas.document.nodes = [{ id: "n1", type: "image", position: { x: 0, y: 0 } }];
    canvas.nodeData = { n1: { prompt: "秋日森林里的木屋" } };
    expect(searchCanvasNodes(canvas, { query: "秋日森林" })).toHaveLength(1);
  });
});
