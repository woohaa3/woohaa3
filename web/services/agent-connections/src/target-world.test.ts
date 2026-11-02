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
      ASSISTANT_WORLD_TOOL.readContext,
      ASSISTANT_WORLD_TOOL.createModel,
      ASSISTANT_WORLD_TOOL.replaceModel,
      ASSISTANT_WORLD_TOOL.moveModel,
      ASSISTANT_WORLD_TOOL.setCamera,
      ASSISTANT_WORLD_TOOL.completeCamera
    ]);
    const prompt = buildTargetPrompt(intent, "req-1");
    expect(prompt).toContain('scope="scene-area:area-1"');
    expect(prompt).toContain("get_world_context");
    expect(prompt).toContain("真实版本");
  });

  it("retires camera tools and refuses a world target without a scope", () => {
    expect(localAgentToolsForMode("camera")).toEqual([]);
    expect(localAgentToolsForMode("world")).toEqual([]);
  });
});
