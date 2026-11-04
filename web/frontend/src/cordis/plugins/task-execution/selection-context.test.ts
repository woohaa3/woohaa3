/**
 * 选中上下文解析测试（任务 3.2）。
 *
 * 关键点：只接受节点 ID，类型与数据一律来自规范画布；失效 ID 必须清空上下文。
 */
import { describe, expect, it } from "vitest";
import { canvasFixture } from "./test-support/fixtures.js";
import { resolveSelectionContext } from "./selection-context.js";

const CANVAS = canvasFixture({
  nodes: [
    { id: "img-1", type: "image", data: { title: "图片节点", prompt: "画一只猫" } },
    { id: "txt-1", type: "text", data: { title: "文本节点", prompt: "写一段话" } },
    { id: "gen-1", type: "model3d", data: { title: "3D 节点" } }
  ]
});

describe("resolveSelectionContext", () => {
  it("3D model3d 节点返回仅参数面板上下文", () => {
    expect(resolveSelectionContext(CANVAS, "gen-1")).toMatchObject({
      nodeId: "gen-1",
      nodeType: "model3d",
      panelKind: null,
      nodeData: { title: "3D 节点" }
    });
  });

  it("Codex 成品图不打开生成面板", () => {
    const canvas = canvasFixture({
      nodes: [{ id: "img-codex", type: "image", data: { codexImageImport: true, outputAssetId: "asset-1" } }]
    });
    expect(resolveSelectionContext(canvas, "img-codex")).toBeNull();
  });

  it("选中图片节点 → image-generation，数据来自规范 nodeData", () => {
    const context = resolveSelectionContext(CANVAS, "img-1");
    expect(context).toEqual({
      nodeId: "img-1",
      nodeType: "image",
      panelKind: "image-generation",
      nodeData: { title: "图片节点", prompt: "画一只猫" }
    });
  });

  it("选中文本节点 → text-generation", () => {
    expect(resolveSelectionContext(CANVAS, "txt-1")?.panelKind).toBe("text-generation");
  });

  it("没有选中 → null", () => {
    expect(resolveSelectionContext(CANVAS, null)).toBeNull();
    expect(resolveSelectionContext(CANVAS, "")).toBeNull();
    expect(resolveSelectionContext(CANVAS, undefined)).toBeNull();
  });

  it("选中已失效（被删除）的节点 → null", () => {
    expect(resolveSelectionContext(CANVAS, "no-such-node")).toBeNull();
  });

  it("画布尚未加载 → null", () => {
    expect(resolveSelectionContext(null, "img-1")).toBeNull();
  });

  it("节点存在但没有 nodeData 时返回空对象（面板仍可渲染默认值）", () => {
    const canvas = canvasFixture({ nodes: [{ id: "img-2", type: "image" }] });
    expect(resolveSelectionContext(canvas, "img-2")?.nodeData).toEqual({});
  });
});
