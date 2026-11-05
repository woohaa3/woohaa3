/**
 * 共享 Agent 节点描述符契约测试
 * （change: add-agent-canvas-authoring-mcp，任务 1.2）。
 *
 * 锁定 Frontend 节点目录的稳定语义（顺序、标签、默认尺寸、默认任务字段、连线标签），
 * 证明下沉共享描述符不改变 UI 行为。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_NODE_DESCRIPTORS,
  agentConnectLabel,
  agentDescriptorForCanonicalType,
  canonicalTypeFor,
  defaultAgentNodeData,
  findAgentNodeDescriptor
} from "./agent-node-descriptors.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";

describe("Agent 节点描述符（任务 1.2）", () => {
  it("暴露全部可创建语义种类与标签", () => {
    expect(AGENT_NODE_DESCRIPTORS.map((entry) => entry.kind)).toEqual(["text", "image", "model", "video", "audio"]);
    expect(AGENT_NODE_DESCRIPTORS.map((entry) => entry.label)).toEqual(["文本", "图片", "模型", "视频", "音频"]);
  });

  it("模型语义种类映射为 canonical model3d 且不带任务字段", () => {
    expect(findAgentNodeDescriptor("model")?.canonicalType).toBe("model3d");
    expect(findAgentNodeDescriptor("model")?.taskKind).toBeUndefined();
    expect(defaultAgentNodeData("model")).toMatchObject({ modelScript: "", modelScriptVersion: "woohaa-model-js-v2" });
    expect(defaultAgentNodeData("model")?.modelContentVersion).toBeDefined();
    expect(defaultAgentNodeData("model")?.taskKind).toBeUndefined();
    expect(agentDescriptorForCanonicalType("model3d")?.kind).toBe("model");
    expect(agentDescriptorForCanonicalType(COMPOSITE_ASSET_NODE_TYPE)?.kind).toBe("model");
    expect(agentDescriptorForCanonicalType("generate")).toBeNull();
    expect(canonicalTypeFor("model")).toBe("model3d");
  });

  it("任务节点默认 nodeData 带 taskKind/taskStatus: idle", () => {
    expect(defaultAgentNodeData("text")).toEqual({ taskKind: "text-generation", taskStatus: "idle" });
    expect(defaultAgentNodeData("image")).toEqual({ taskKind: "image-generation", taskStatus: "idle" });
    expect(defaultAgentNodeData("video")).toEqual({ taskKind: "video-generation", taskStatus: "idle" });
    expect(defaultAgentNodeData("audio")).toEqual({ taskKind: "audio-generation", taskStatus: "idle" });
  });

  it("默认尺寸与 Bevy 节点尺寸一致", () => {
    // 自包含 model3d 在渲染契约里是完整预览卡片（248×232），默认尺寸必须同源，
    // 否则菜单预览与画布实际尺寸分叉（见 node-dimensions.ts / render-scene）。
    expect(findAgentNodeDescriptor("text")?.defaultSize).toEqual({ width: 248, height: 232 });
    expect(findAgentNodeDescriptor("model")?.defaultSize).toEqual({ width: 248, height: 232 });
    expect(findAgentNodeDescriptor("image")?.defaultSize).toEqual({ width: 248, height: 232 });
    expect(findAgentNodeDescriptor("video")?.defaultSize).toEqual({ width: 248, height: 232 });
    expect(findAgentNodeDescriptor("audio")?.defaultSize).toEqual({ width: 248, height: 232 });
  });

  it("连线标签与旧 _wire_label 等价（来源+目标依赖）", () => {
    expect(agentConnectLabel("text", "image")).toBe("文本");
    expect(agentConnectLabel("text", "model3d")).toBe("文本");
    expect(agentConnectLabel(COMPOSITE_ASSET_NODE_TYPE, "image")).toBe("模型");
    expect(agentConnectLabel("image", "video")).toBe("图片");
    expect(agentConnectLabel("model3d", "image")).toBe("模型");
    expect(agentConnectLabel("audio", "video")).toBe("");
    // canonical type 与语义 kind 等价输入。
    expect(agentConnectLabel("model", "image")).toBe("模型");
  });

  it("可执行与 prompt 能力与节点语义一致", () => {
    expect(findAgentNodeDescriptor("text")?.executable).toBe(true);
    expect(findAgentNodeDescriptor("model")?.executable).toBe(false);
    expect(findAgentNodeDescriptor("model")?.supportsPrompt).toBe(true);
  });
});
