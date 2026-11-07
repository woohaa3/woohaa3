/**
 * 右键菜单目录与默认 nodeData 测试（change: 后续 change 补齐右键菜单）。
 */
import { describe, expect, it } from "vitest";
import {
  NODE_TEMPLATES,
  connectLabelFor,
  connectNodeDataFor,
  defaultNodeDataForType,
  findNodeTemplate
} from "./node-catalog.js";

describe("node-catalog", () => {
  it("统一目录只列宿主模板；片场由扩展模板贡献，不重复出现", () => {
    expect(NODE_TEMPLATES.map((entry) => entry.id)).toEqual([
      "text",
      "image",
      "model3d",
      "video",
      "audio",
      "character-series",
      "product-series"
    ]);
    expect(NODE_TEMPLATES.map((entry) => entry.label)).toEqual([
      "文本",
      "图片",
      "3D 模型",
      "视频",
      "音频",
      "角色系列",
      "商品系列"
    ]);
    expect(findNodeTemplate("model")?.nodeType).toBe("model3d");
    expect(findNodeTemplate("model3d")?.nodeType).toBe("model3d");
    // 复合资产由扩展经 canvas.node-template 贡献。
    expect(findNodeTemplate("composite-asset")).toBeNull();
  });

  it("菜单只有一份目录，不再有拉线专用的额外项", () => {
    // 空白右键与拉线创建读取同一个 NODE_TEMPLATES；不存在机位拍摄等第二套菜单项。
    expect(NODE_TEMPLATES.map((entry) => entry.id)).toEqual([
      "text",
      "image",
      "model3d",
      "video",
      "audio",
      "character-series",
      "product-series"
    ]);
    expect(findNodeTemplate("shot")).toBeNull();
    expect(findNodeTemplate("generate")).toBeNull();
    expect(findNodeTemplate("edit")).toBeNull();
    expect(NODE_TEMPLATES.filter((entry) => entry.nodeType === "model3d")).toHaveLength(1);
  });

  it("任务节点带 taskKind/taskStatus，3D 模型节点不带", () => {
    expect(defaultNodeDataForType("text")).toEqual({ taskKind: "text-generation", taskStatus: "idle" });
    expect(defaultNodeDataForType("image")).toEqual({ taskKind: "image-generation", taskStatus: "idle" });
    expect(defaultNodeDataForType("video")).toEqual({ taskKind: "video-generation", taskStatus: "idle" });
    expect(defaultNodeDataForType("audio")).toEqual({ taskKind: "audio-generation", taskStatus: "idle" });
    // 已下线的旧 generate 类型不再有默认 nodeData（模型定义只走自包含 3D 节点）。
    expect(defaultNodeDataForType("generate")).toBeUndefined();
  });

  it("角色/商品系列预设写入 identity-required，普通图片节点仍 optional", () => {
    expect(defaultNodeDataForType("character-series")).toMatchObject({
      taskKind: "image-generation",
      referencePolicy: "identity-required"
    });
    expect(defaultNodeDataForType("product-series")).toMatchObject({
      referencePolicy: "identity-required"
    });
    expect(defaultNodeDataForType("image")?.referencePolicy).toBeUndefined();
    expect(connectNodeDataFor({ id: "n1", type: "image" }, "character-series")).toMatchObject({
      referencePolicy: "identity-required",
      inputMapping: [{ sourceNodeId: "n1" }]
    });
  });

  it("拉线创建的 nodeData 带指向源节点的输入映射", () => {
    const data = connectNodeDataFor({ id: "n1", type: "image" }, "video");
    expect(data).toMatchObject({ taskKind: "video-generation", taskStatus: "idle" });
    expect(data?.inputMapping).toHaveLength(1);
    expect(data?.inputMapping?.[0]).toMatchObject({ sourceNodeId: "n1", sortKey: "0" });
    // 模型节点不承载任务字段/输入映射（旧 generate 类型已下线）。
    expect(connectNodeDataFor({ id: "n1", type: "image" }, "generate")).toBeUndefined();
  });

  it("拉线边标签与旧 _wire_label 等价", () => {
    expect(connectLabelFor("text", "image")).toBe("文本");
    expect(connectLabelFor("text", "model3d")).toBe("文本");
    expect(connectLabelFor("image", "video")).toBe("图片");
    expect(connectLabelFor("model3d", "image")).toBe("模型");
    expect(connectLabelFor("audio", "video")).toBe("");
  });

  it("自包含 3D 节点直接创建携带完整本地模型定义（change: 2026-10-05）", () => {
    const model = defaultNodeDataForType("model3d");
    expect(model?.modelScript).toBe("");
    expect(model?.modelScriptVersion).toBe("woohaa-model-js-v2");
    expect(model?.modelContentVersion).toBeTruthy();

  });
});

