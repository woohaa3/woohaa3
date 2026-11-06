import { describe, expect, it } from "vitest";
import type { AgentEntryIntent } from "@woohaa3/contracts";
import { ASSISTANT_WORLD_TOOL } from "@woohaa3/contracts";
import { buildTargetPrompt } from "./target-prompt.js";
import { localAgentToolsForMode } from "./target-tools.js";

describe("world target prompt and tools", () => {
  it("keeps a 2D group read-only and names the selected scope", () => {
    const intent: AgentEntryIntent = {
      action: "modify",
      canvasId: "canvas-1",
      nodeId: "group-node",
      mode: "world",
      worldScope: { kind: "workflow-group-2d", groupId: "group-1" },
      prompt: "搭场景"
    };
    expect(localAgentToolsForMode("world", intent.worldScope)).toEqual([ASSISTANT_WORLD_TOOL.readContext]);
    const prompt = buildTargetPrompt(intent, "req-1");
    expect(prompt).toContain('scope="workflow-group-2d:group-1"');
    expect(prompt).toContain("没有世界写工具");
  });

  it("grants the scene-area tool set and explains host-owned versions", () => {
    const intent: AgentEntryIntent = {
      action: "modify",
      canvasId: "canvas-1",
      nodeId: "area-node",
      mode: "world",
      worldScope: { kind: "scene-area", areaId: "area-1" },
      prompt: "搭场景"
    };
    expect(localAgentToolsForMode("world", intent.worldScope)).toEqual([
      "get_model_api",
      ASSISTANT_WORLD_TOOL.readContext,
      ASSISTANT_WORLD_TOOL.readModelRig,
      ASSISTANT_WORLD_TOOL.sampleAnimation,
      ASSISTANT_WORLD_TOOL.createModel,
      ASSISTANT_WORLD_TOOL.replaceModel,
      ASSISTANT_WORLD_TOOL.moveModel,
      ASSISTANT_WORLD_TOOL.setAnimation,
      ASSISTANT_WORLD_TOOL.resizeArea,
      ASSISTANT_WORLD_TOOL.createCamera,
      ASSISTANT_WORLD_TOOL.setCamera,
      ASSISTANT_WORLD_TOOL.completeCamera
    ]);
    const prompt = buildTargetPrompt(intent, "req-1");
    expect(prompt).toContain('scope="scene-area:area-1"');
    expect(prompt).toContain("get_world_context");
    expect(prompt).toContain("真实版本");
    expect(prompt).toContain("sceneArea.animation");
    expect(prompt).toContain("保留未要求修改的轨道");
    expect(prompt).toContain("旧宿主未返回 sceneArea 时不能猜测原动画或直接覆盖");
  });

  it("retires camera tools and refuses a world target without a scope", () => {
    expect(localAgentToolsForMode("camera")).toEqual([]);
    expect(localAgentToolsForMode("world")).toEqual([]);
  });
});

 it("grants only context and camera tools for the selected camera", () => {
  const worldScope = { kind: "world-camera" as const, cameraId: "camera-a" };
  expect(localAgentToolsForMode("world", worldScope)).toEqual(["get_world_context", "set_world_camera", "complete_world_camera"]);
  const prompt = buildTargetPrompt({ action: "modify", canvasId: "canvas", nodeId: "camera-card", mode: "world", worldScope, prompt: "拉近一点" }, "request");
  expect(prompt).toContain('scope="world-camera:camera-a"');
  expect(prompt).toContain("camera.settings");
  expect(prompt).toContain("verticalFovRadians");
  expect(prompt).not.toContain("写 modelScript");
});
