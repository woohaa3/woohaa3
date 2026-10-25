import { describe, expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { applyNodeResourceLoading, NodeResourceLoading } from "./node-resource-loading.js";

describe("节点资源加载状态", () => {
  it("换源只保留最新加载身份，视频缓冲复用同一身份", () => {
    const loading = new NodeResourceLoading();
    const old = loading.track("private-node", "private-url");
    const current = loading.track("private-node", "new-private-url");
    expect(loading.isLoading("private-node")).toBe(true);
    loading.setLoading(old, false);
    expect(loading.isLoading("private-node")).toBe(true);
    loading.setLoading(current, false);
    expect(loading.isLoading("private-node")).toBe(false);
    loading.setLoading(current, true);
    expect(loading.isLoading("private-node")).toBe(true);
  });
  it("换源、删除与清空后，迟到结果不能结束当前加载或重新挂起提示", () => {
    const loading = new NodeResourceLoading();
    const old = loading.track("n", "old");
    const current = loading.track("n", "current");
    loading.setLoading(old, false);
    loading.remove(old);
    expect(loading.isLoading("n")).toBe(true);
    loading.setLoading(current, false);
    expect(loading.isLoading("n")).toBe(false);
    loading.setLoading(current, true); // 视频缓冲复用同一次加载身份。
    expect(loading.isLoading("n")).toBe(true);
    loading.retain(new Map());
    loading.setLoading(current, true);
    expect(loading.isLoading("n")).toBe(false);
    const disposed = loading.track("n", "next");
    loading.clear();
    loading.setLoading(disposed, true);
    expect(loading.isLoading("n")).toBe(false);
  });

  it("图片、视频、3D 模型共用 mediaLoading，保留生成进度并排除无资源的节点", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes = ["image", "video", "model3d", "text"].map(type => ({
      id: type, type, position: { x: 0, y: 0 }, width: 260, height: 195
    }));
    const loading = new NodeResourceLoading();
    for (const type of ["image", "video", "model3d", "text"]) loading.track(type, "resource");
    const scene = buildCanvasRenderScene({ canvas });
    applyNodeResourceLoading(scene, { image: loading, video: loading, model: loading });
    expect(scene.nodes.filter(node => node.mediaLoading).map(node => node.id)).toEqual(["image", "video", "model3d"]);
    canvas.nodeData.video = { taskStatus: "processing" };
    const busy = buildCanvasRenderScene({ canvas });
    applyNodeResourceLoading(busy, { image: loading, video: loading, model: loading });
    expect(busy.nodes.find(node => node.id === "video")?.busy).toBe(true);
    expect(busy.nodes.find(node => node.id === "video")?.mediaLoading).toBeUndefined();
  });
});
