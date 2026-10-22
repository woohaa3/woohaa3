/**
 * 任务活动展示测试（change: 2026-10-09-improve-canvas-workflow，任务 5.1）。
 */
import { describe, expect, it } from "vitest";
import { modelDisplayName, resolveTaskActivityDisplay } from "../src/frontend/display.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";

function catalog(): CanvasTaskCatalog {
  return {
    available: true,
    models: [
      { modelKey: "img-key", providerId: "p", providerModelId: "raw", modelType: "image", title: "海边日落 模型", interaction: { id: "x", version: 1 }, inputSchema: {}, defaultInput: {}, bindings: [], taskTimeoutMs: 1000 }
    ],
    defaultModels: {}
  } as CanvasTaskCatalog;
}

describe("resolveTaskActivityDisplay 主/次行", () => {
  it("主行显示操作与作品名，次行显示模型可读名", () => {
    const display = resolveTaskActivityDisplay({
      item: { modelType: "image", modelKey: "img-key", nodeId: "n1" },
      node: { id: "n1", type: "image", title: "海边日落" },
      catalog: catalog()
    });
    expect(display.primary).toBe("生成图片 · 海边日落");
    expect(display.secondary).toBe("海边日落 模型");
    expect(display.locatable).toBe(true);
  });

  it("无显式名时使用已提交提示词摘要", () => {
    const display = resolveTaskActivityDisplay({
      item: { modelType: "video", modelKey: "v", nodeId: "n1" },
      node: { id: "n1", type: "video", prompt: "开场镜头：晨雾中的城市天际线" },
      catalog: null
    });
    expect(display.primary).toContain("生成视频 · 开场镜头");
  });

  it("目录缺失时次行回退 modelKey", () => {
    const display = resolveTaskActivityDisplay({
      item: { modelType: "image", modelKey: "some-long-model-key", nodeId: "n1" },
      node: { id: "n1", type: "image" },
      catalog: null
    });
    expect(display.secondary).toBe("some-long-model-key");
  });

  it("节点已删除：主行只显示操作，定位禁用并有原因", () => {
    const display = resolveTaskActivityDisplay({
      item: { modelType: "image", modelKey: "m", nodeId: "gone" },
      node: null,
      catalog: catalog()
    });
    expect(display.primary).toBe("生成图片");
    expect(display.locatable).toBe(false);
    expect(display.locateReason).toContain("无法定位");
  });

  it("未知模型类型回退通用操作", () => {
    const display = resolveTaskActivityDisplay({
      item: { nodeId: "n1" },
      node: { id: "n1", type: "text" },
      catalog: null
    });
    expect(display.primary).toContain("生成内容");
  });
});

describe("modelDisplayName", () => {
  it("命中目录返回标题，否则回退 modelKey", () => {
    expect(modelDisplayName("img-key", catalog())).toBe("海边日落 模型");
    expect(modelDisplayName("missing", catalog())).toBe("missing");
    expect(modelDisplayName(undefined, catalog())).toBe("未知模型");
  });
});
