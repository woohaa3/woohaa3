/**
 * 扩展节点复制 Drop 分派（宿主通用）测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.3/4.4）。
 *
 * 纯逻辑覆盖：范围命中（zIndex/文档顺序/来源排除）、按 nodeType 委托、未命中不消费、
 * 命中即消费（不回退普通移动）。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { dropNodeDrop, ownerAcceptsSources, previewNodeDrop, type DropTargetResolution, type NodeDropTarget } from "./node-drop-dispatch.js";

function node(id: string, type: string, position: { x: number; y: number }, extra: Record<string, unknown> = {}) {
  return { id, type, position, ...extra };
}

function canvas(nodes: ReturnType<typeof node>[]): ServerCanvas {
  return {
    id: "c1",
    revision: 1,
    document: { schemaVersion: "asset-canvas-v1", nodes, edges: [], updatedAt: "2026-10-10T00:00:00.000Z" },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-10-10T00:00:00.000Z"
  } as unknown as ServerCanvas;
}

const target = (nodeId: string | null): DropTargetResolution =>
  nodeId ? { status: "target", nodeId } : { status: "none" };

describe("扩展节点 drop 分派", () => {
  const c = canvas([node("f1", "composite-asset", { x: 100, y: 100 }, { width: 200, height: 120 })]);
  const target100: NodeDropTarget = {
    nodeType: "composite-asset",
    onDrop: () => true,
    onPreview: () => "可收集"
  };

  it("命中的 accepted 目标委托并按 nodeType 消费", () => {
    let called: { targetNodeId: string; sources: readonly string[] } | null = null;
    const t: NodeDropTarget = { nodeType: "composite-asset", onDrop: (input: { targetNodeId: string; sourceNodeIds: readonly string[] }) => { called = { targetNodeId: input.targetNodeId, sources: input.sourceNodeIds }; return true; } };
    expect(dropNodeDrop([t], c, ["src1"], { x: 150, y: 150 }, target("f1"))).toBe(true);
    expect(called).toEqual({ targetNodeId: "f1", sources: ["src1"] });
  });

  it("查询成功但无目标时不消费（回退普通移动）", () => {
    expect(dropNodeDrop([target100], c, ["src1"], { x: 0, y: 0 }, target(null))).toBe(false);
  });

  it("目标 identity 不存在时按未命中处理，不消费", () => {
    expect(dropNodeDrop([target100], c, ["src1"], { x: 150, y: 150 }, target("missing"))).toBe(false);
  });

  it("查询不可用时消费为明确失败，绝不回退普通移动", () => {
    const unavailable: DropTargetResolution = { status: "unavailable", reason: "stale" };
    expect(dropNodeDrop([], c, ["src1"], { x: 150, y: 150 }, unavailable)).toBe(true);
    expect(dropNodeDrop([target100], c, ["src1"], { x: 150, y: 150 }, unavailable)).toBe(true);
    expect(previewNodeDrop([], c, ["src1"], unavailable)).toContain("不可用");
  });

  it("无贡献的扩展节点明确拒绝，不回退移动", () => {
    expect(dropNodeDrop([], c, ["src1"], { x: 150, y: 150 }, target("f1"))).toBe(true);
    expect(previewNodeDrop([], c, ["src1"], target("f1"))).toContain("不可用");
  });

  it("预览反馈来自命中贡献", () => {
    expect(previewNodeDrop([target100], c, ["src1"], target("f1"))).toBe("可收集");
    expect(previewNodeDrop([{ nodeType: "composite-asset", onDrop: () => true }], c, ["src1"], target("f1"))).toBeNull();
  });
});


describe("同类型扩展节点身份分派", () => {
  it("只调用拥有目标的扩展，不向其他扩展泄漏预览或释放", () => {
    const c = canvas([node("other", "composite-asset", { x: 0, y: 0 })]);
    const rejected = { nodeType: "composite-asset", matchesTarget: () => false, onDrop: vi.fn(() => true), onPreview: vi.fn(() => "wrong") };
    const accepted = { nodeType: "composite-asset", matchesTarget: ({ targetNodeId }: { targetNodeId: string }) => targetNodeId === "other", onDrop: vi.fn(() => true), onPreview: () => "other" };
    expect(previewNodeDrop([rejected, accepted], c, ["source"], target("other"))).toBe("other");
    expect(dropNodeDrop([rejected, accepted], c, ["source"], { x: 10, y: 10 }, target("other"))).toBe(true);
    expect(rejected.onDrop).not.toHaveBeenCalled();
    expect(rejected.onPreview).not.toHaveBeenCalled();
    expect(accepted.onDrop).toHaveBeenCalledOnce();
    expect(dropNodeDrop([rejected], c, ["source"], { x: 10, y: 10 }, target("other"))).toBe(true);
  });

  it("多个owner拒绝整次drop，不按注册顺序调用", () => {
    const c = canvas([node("target", "composite-asset", { x: 0, y: 0 })]);
    const accept = vi.fn(() => true);
    expect(dropNodeDrop([{ nodeType: "composite-asset", onDrop: () => false }, { nodeType: "composite-asset", onDrop: accept }], c, [], { x: 10, y: 10 }, target("target"))).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("接收方来源谓词（拖动提示）", () => {
  it("未实现 acceptsSources 的贡献保持既有行为（视为接收）", () => {
    const c = canvas([node("f", "composite-asset", { x: 0, y: 0 })]);
    expect(ownerAcceptsSources({ nodeType: "composite-asset", onDrop: () => true }, c, "f", ["image"])).toBe(true);
    expect(ownerAcceptsSources(undefined, c, "f", ["image"])).toBe(true);
  });

  it("谓词决定拖动提示是否点亮，但不影响释放裁决", () => {
    const c = canvas([node("f", "composite-asset", { x: 0, y: 0 })]);
    const owner = { nodeType: "composite-asset", acceptsSources: () => false, onDrop: vi.fn(() => true) };
    expect(ownerAcceptsSources(owner, c, "f", ["image"])).toBe(false);
    // 释放仍由 onDrop 消费（明确拒绝而非回退普通移动）。
    expect(dropNodeDrop([owner], c, ["image"], { x: 10, y: 10 }, target("f"))).toBe(true);
    expect(owner.onDrop).toHaveBeenCalledOnce();
  });

  it("谓词抛错时按不接收处理，不打断指针生命周期", () => {
    const c = canvas([node("f", "composite-asset", { x: 0, y: 0 })]);
    const owner = { nodeType: "composite-asset", acceptsSources: () => { throw new Error("boom"); }, onDrop: () => true };
    expect(ownerAcceptsSources(owner, c, "f", ["model"])).toBe(false);
  });
});

// 上层实际节点由宿主 accepted 查询固定：命中普通图片时目标即图片，非 composite-asset 且无 owner 时不消费。
it("topmost ordinary media blocks drop to a furnace underneath", () => {
  const c = canvas([node("f", "composite-asset", {x: 0, y: 0}), node("image", "image", {x: 0, y: 0}, {zIndex: 10})]);
  const onDrop = vi.fn(() => true);
  expect(dropNodeDrop([{nodeType: "composite-asset", onDrop}], c, ["source"], {x: 20, y: 20}, target("image"))).toBe(false);
  expect(onDrop).not.toHaveBeenCalled();
});

describe("container-less drop ownership", () => {
  const c = canvas([node("owner", "composite-asset", { x: 0, y: 0 }, { width: 300, height: 200 })]);
  const owner: NodeDropTarget = {
    nodeType: "composite-asset",
    matchesTarget: ({ targetNodeId }) => targetNodeId === "owner",
    onDrop: vi.fn(() => true),
    onPreview: () => "放到此处"
  };

  it("a matching owner consumes its own target", () => {
    const targetOwner: NodeDropTarget = { ...owner, onDrop: vi.fn(() => true) };
    expect(dropNodeDrop([targetOwner], c, ["source"], { x: 10, y: 10 }, target("owner"))).toBe(true);
    expect(targetOwner.onDrop).toHaveBeenCalledOnce();
    expect(previewNodeDrop([targetOwner], c, ["source"], target("owner"))).toBe("放到此处");
  });
});

