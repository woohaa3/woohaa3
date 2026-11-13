import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_TOOLS,
  ASSISTANT_WORLD_CAMERA_TOOLS,
  ASSISTANT_WORLD_TOOLS,
  CANVAS_GROUP_TOOLS,
  decodeAgentRoleDefinition,
  decodeAgentRolePrompt,
  type AgentRoleImplementation
} from "@woohaa3/contracts";
import { STANDARD_AGENT_ROLES } from "./index.js";
import { canvasBuilderRole } from "./canvas-builder.js";
import { textAuthorRole } from "./text-author.js";
import { sceneDirectorRole } from "./scene-director.js";

function prepare(implementation: AgentRoleImplementation, input: unknown = { prompt: "做一个盒子", action: "generate" }, context: unknown = {}) {
  return implementation.prepare({
    input,
    context,
    target: { canvasId: "canvas", nodeId: "node", mode: "model3d" },
    requestId: "req-1",
    nativeCapabilities: []
  });
}

describe("standard-agent-roles", () => {
  it("每个角色定义都通过严格 codec，ID 唯一", () => {
    const ids = STANDARD_AGENT_ROLES.map((implementation) => implementation.definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const implementation of STANDARD_AGENT_ROLES) {
      expect(decodeAgentRoleDefinition(implementation.definition).ok, implementation.definition.id).toBe(true);
    }
    expect(ids).toEqual(["model-author", "scene-director", "camera-composer", "canvas-builder", "text-author"]);
  });

  it("工具角色声明引用公开工具契约，prepare 不越界", () => {
    const cases: Array<[AgentRoleImplementation, readonly string[]]> = [
      [STANDARD_AGENT_ROLES.find((role) => role.definition.id === "model-author")!, AGENT_MODEL_TOOLS],
      [STANDARD_AGENT_ROLES.find((role) => role.definition.id === "scene-director")!, [...ASSISTANT_WORLD_TOOLS, "get_model_api"]],
      [STANDARD_AGENT_ROLES.find((role) => role.definition.id === "camera-composer")!, ASSISTANT_WORLD_CAMERA_TOOLS],
      [canvasBuilderRole, CANVAS_GROUP_TOOLS]
    ];
    for (const [implementation, expected] of cases) {
      for (const tool of expected) {
        expect([...implementation.definition.tools.required, ...implementation.definition.tools.optional]).toContain(tool);
      }
      const declared = [...implementation.definition.tools.required, ...implementation.definition.tools.optional];
      const prepared = prepare(implementation);
      expect(decodeAgentRolePrompt(prepared, declared).ok, implementation.definition.id).toBe(true);
    }
  });

  it("条件注册的工具不得作为角色必需项", () => {
    const alwaysRegistered = new Set([
      "list_canvases", "get_canvas_capabilities", "get_canvas_graph", "get_canvas_changes",
      "get_canvas_script_api", "validate_canvas_script", "submit_canvas_script"
    ]);
    for (const tool of canvasBuilderRole.definition.tools.required) {
      expect(alwaysRegistered.has(tool), `canvas-builder required ${tool}`).toBe(true);
    }
    expect(sceneDirectorRole.definition.tools.required).toEqual(["get_world_context"]);
  });

  it("画布组角色保留旧工具面，只在未开启生图时收窄 import_generated_image", () => {
    const off = prepare(canvasBuilderRole);
    expect(off.tools).not.toContain("import_generated_image");
    for (const tool of CANVAS_GROUP_TOOLS) {
      if (tool === "import_generated_image") continue;
      expect(off.tools, tool).toContain(tool);
    }
    const on = canvasBuilderRole.prepare({
      input: { prompt: "做一个组", action: "generate" },
      context: {},
      target: { canvasId: "canvas", nodeId: "root", mode: "canvas-group" },
      requestId: "req-2",
      nativeCapabilities: ["generate-image"]
    });
    expect(on.tools).toContain("import_generated_image");
  });

  it("导演区角色在图片重建上下文中要求工具写场景", () => {
    const prepared = sceneDirectorRole.prepare({
      input: { prompt: "根据图片重建", action: "generate" },
      context: { imageReconstruction: { sourceNodeId: "image", width: 4, height: 3 } },
      target: { canvasId: "canvas", nodeId: "area", mode: "world", worldScope: { kind: "scene-area", areaId: "a1" } },
      requestId: "req-image",
      nativeCapabilities: []
    });
    expect(prepared.tools).toEqual(expect.arrayContaining([...ASSISTANT_WORLD_TOOLS, "get_model_api"]));
    expect(prepared.messages[0]!.content).toContain("参考图片");
  });

  it("导演区与镜头角色都说明默认 4×4 范围与三类世界失败", () => {
    const director = sceneDirectorRole.definition.instructions;
    expect(director).toContain("默认 4×4 米");
    expect(director).toContain("读取工具只是准备阶段，不是完成结果");
    expect(director).toContain("至少一个写工具");
    expect(director).toContain("resize_scene_area");
    expect(director).toContain("重新 get_world_context");
    for (const term of ["outside-scope", "version-conflict", "version-unknown", "不要伪造版本"]) {
      expect(director, term).toContain(term);
    }
    const composer = STANDARD_AGENT_ROLES.find((role) => role.definition.id === "camera-composer")!;
    for (const term of ["outside-scope", "version-conflict", "version-unknown", "不要编造"]) {
      expect(composer.definition.instructions, term).toContain(term);
    }
  });

  it("文本角色把领域提供的上下文写进消息，输出候选 schema", () => {
    const prepared = textAuthorRole.prepare({
      input: { prompt: "写一段介绍", action: "generate" },
      context: { prompt: "编译后的正文要求" },
      target: { canvasId: "canvas", nodeId: "text" },
      requestId: "req-4",
      nativeCapabilities: []
    });
    expect(prepared.messages[0]!.content).toContain("编译后的正文要求");
    expect(prepared.messages[0]!.content).toContain("Return only JSON");
    expect(textAuthorRole.definition.output.kind).toBe("candidate");
  });
});
