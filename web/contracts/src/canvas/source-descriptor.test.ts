import { describe, expect, it } from "vitest";
import { describeCanvasSource } from "./source-descriptor.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";

function source(type = "future-node"): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
  canvas.document.nodes = [{ id: "n", type, position: { x: 0, y: 0 } }];
  canvas.nodeData.n = { payload: { unknown: "complete" }, assetIds: ["image"], mediaReferences: ["sha256-original"] } as never;
  canvas.assets = [{ id: "image", mediaKind: "image", status: "ready", source: "uploaded", title: "image", createdAt: "now", metadata: { storageKey: "sha256-image", contentType: "image/png" } }];
  return canvas;
}

describe("公共来源素材描述", () => {
  it("未知类型保留完整快照和显式引用，返回副本", () => {
    const canvas = source(), descriptor = describeCanvasSource(canvas, "n")!;
    expect(descriptor.snapshot).toEqual(canvas.nodeData.n);
    expect(descriptor.mediaKeys).toEqual(["sha256-original"]);
    expect(descriptor.assets.map(asset => asset.id)).toEqual(["image"]);
    descriptor.assets[0]!.title = "changed";
    expect(canvas.assets[0]!.title).toBe("image");
  });
  it("完整内容尾部、资产metadata变化改变身份，位置和进度不改变", () => {
    const canvas = source(); canvas.nodeData.n = { prompt: "x".repeat(5000) + "a", outputAssetId: "image" } as never;
    const hash = describeCanvasSource(canvas, "n")!.contentHash;
    canvas.document.nodes[0]!.position.x = 100;
    canvas.nodeData.n = { ...canvas.nodeData.n, progress: 0.5 } as never;
    expect(describeCanvasSource(canvas, "n")!.contentHash).toBe(hash);
    canvas.nodeData.n = { ...canvas.nodeData.n, prompt: "x".repeat(5000) + "b" } as never;
    expect(describeCanvasSource(canvas, "n")!.contentHash).not.toBe(hash);
    const next = describeCanvasSource(canvas, "n")!.contentHash;
    canvas.assets[0]!.metadata = { storageKey: "sha256-new" };
    expect(describeCanvasSource(canvas, "n")!.contentHash).not.toBe(next);
  });
  it("缺失或未就绪的显式依赖拒绝整条来源", () => {
    const canvas = source(); canvas.assets = [];
    expect(describeCanvasSource(canvas, "n")).toBeNull();
    expect(describeCanvasSource(canvas, "missing")).toBeNull();
  });
  it("导演场提取内部图片视频，重复引用只保留一份", () => {
    const canvas = source("composite-asset");
    const item = { id: "plane", kind: "image", name: "image", assetId: "image", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    canvas.nodeData.n = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [item, { ...item, id: "second" }] } } as never;
    expect(describeCanvasSource(canvas, "n")!.assets.map(asset => asset.id)).toEqual(["image"]);
  });
});
