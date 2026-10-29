/**
 * 节点顶部横条显隐与下载门禁的纯判定
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1/3.2/3.9）。
 *
 * 非渲染检查：不触碰 DOM/渲染；覆盖单选/多选/取消选择/类型/聚焦显隐与下载就绪门禁独立于
 * 画布写权限。
 */
import { describe, expect, it } from "vitest";
import { builtinNodeCapabilityResolver, createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker, type ServerCanvas } from "@woohaa3/contracts";
import { resolveContainerFocusEdit, resolveNodeActionToolbarView, resolveNodeDownloadAvailability } from "./node-action-toolbar-view.js";

const NODES = [
  { id: "img", type: "image" },
  { id: "vid", type: "video" },
  { id: "model", type: "model3d" },
  { id: "text", type: "text" },
  { id: "film", type: "composite-asset" }
];

function canvasWith(overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  return { ...createEmptyWoohaa3ServerCanvas("c1"), ...overrides };
}

describe("容器编辑入口（片场）", () => {
  it("只有自带模型聚焦工作区的 group 返回可进入的 kind", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("focus-edit");
    canvas.document.nodes = [
      { id: "film", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 },
      { id: "plain", type: "group", position: { x: 600, y: 0 }, width: 400, height: 300 },
      { id: "model", type: "model3d", position: { x: 0, y: 400 } }
    ];
    canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker() } as never;
    canvas.nodeData.plain = {};
    const edit = (nodeId: string) => resolveContainerFocusEdit({ canvas, nodeId, nodeCapabilities: builtinNodeCapabilityResolver });
    expect(edit("film")).toBe("model");
    expect(edit("plain")).toBeNull();
    expect(edit("model")).toBeNull();
    expect(edit("missing")).toBeNull();
  });
});

describe("节点顶部横条显隐（任务 3.1/3.9）", () => {
  it("单选适用类型节点时显示并固定来源", () => {
    for (const [id, type] of [["img", "image"], ["vid", "video"], ["model", "model3d"], ["film", "composite-asset"]] as const) {
      expect(resolveNodeActionToolbarView({ selectedNodeIds: [id], nodes: NODES, focused: false, writable: true }))
        .toEqual({ nodeId: id, nodeType: type, writable: true });
    }
  });

  it("多选、取消选择、非适用类型与聚焦时不显示", () => {
    expect(resolveNodeActionToolbarView({ selectedNodeIds: [], nodes: NODES, focused: false, writable: true })).toBeNull();
    expect(resolveNodeActionToolbarView({ selectedNodeIds: ["img", "vid"], nodes: NODES, focused: false, writable: true })).toBeNull();
    expect(resolveNodeActionToolbarView({ selectedNodeIds: ["text"], nodes: NODES, focused: false, writable: true })).toBeNull();
    expect(resolveNodeActionToolbarView({ selectedNodeIds: ["img"], nodes: NODES, focused: true, writable: true })).toBeNull();
  });

  it("来源 nodeId 在解析时固定，不随之后 selection 变化（同一输入确定性）", () => {
    const first = resolveNodeActionToolbarView({ selectedNodeIds: ["img"], nodes: NODES, focused: false, writable: true });
    const later = resolveNodeActionToolbarView({ selectedNodeIds: ["img"], nodes: NODES, focused: false, writable: true });
    expect(first).toEqual(later);
  });
});

describe("下载就绪门禁独立于画布写权限（任务 3.2/design D7）", () => {
  it("ready 图片在只读画布下仍可下载（MUST NOT 被只读拒绝）", () => {
    const canvas = canvasWith({
      document: { ...createEmptyWoohaa3ServerCanvas("c1").document, nodes: [{ id: "img", type: "image", position: { x: 0, y: 0 } }] },
      nodeData: { img: { outputAssetId: "asset-1" } },
      assets: [{ id: "asset-1", title: "图片", source: "uploaded", mediaKind: "image", status: "ready", createdAt: "2026-10-13T00:00:00Z", url: "/api/media/a" }]
    });
    expect(resolveNodeDownloadAvailability({ canvas, nodeId: "img", nodeType: "image" })).toEqual({ available: true });
  });

  it("资源未就绪或缺失时禁用并给出原因", () => {
    const canvas = canvasWith({
      document: { ...createEmptyWoohaa3ServerCanvas("c1").document, nodes: [{ id: "vid", type: "video", position: { x: 0, y: 0 } }] },
      nodeData: { vid: { outputAssetId: "asset-x" } },
      assets: [{ id: "asset-x", title: "视频", source: "uploaded", mediaKind: "video", status: "generating", createdAt: "2026-10-13T00:00:00Z", url: "/api/media/v" }]
    });
    const result = resolveNodeDownloadAvailability({ canvas, nodeId: "vid", nodeType: "video" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("尚未就绪");
  });

  it("3D 有模型脚本可导出，空脚本禁用", () => {
    const withScript = canvasWith({ nodeData: { model: { modelScript: "scene.box({});" } } });
    expect(resolveNodeDownloadAvailability({ canvas: withScript, nodeId: "model", nodeType: "model3d" })).toEqual({ available: true });
    const empty = canvasWith({ nodeData: { model: { modelScript: "  " } } });
    expect(resolveNodeDownloadAvailability({ canvas: empty, nodeId: "model", nodeType: "model3d" }).available).toBe(false);
  });

  it("文件模型按引用资产就绪性判定下载，不再要求脚本", () => {
    const glbData = {
      title: "模型.glb",
      modelSourceKind: "glb" as const,
      modelAssetId: "asset-glb",
      modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    };
    const ready = canvasWith({
      nodeData: { model: glbData },
      assets: [{ id: "asset-glb", title: "模型.glb", source: "uploaded", mediaKind: "file", status: "ready", createdAt: "2026-10-28T00:00:00Z", url: "/api/media/g" }]
    });
    expect(resolveNodeDownloadAvailability({ canvas: ready, nodeId: "model", nodeType: "model3d" })).toEqual({ available: true });
    const missing = canvasWith({ nodeData: { model: glbData }, assets: [] });
    const result = resolveNodeDownloadAvailability({ canvas: missing, nodeId: "model", nodeType: "model3d" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("尚未就绪");
  });

  it("画布未加载时禁用", () => {
    expect(resolveNodeDownloadAvailability({ canvas: null, nodeId: "img", nodeType: "image" }).available).toBe(false);
  });
});
