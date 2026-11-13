import { describe, expect, it } from "vitest";
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { channelForDefinition, prepareCliRoleTurn, roleEntries } from "../src/roles.js";

function implementation(overrides: Partial<AgentRoleImplementation["definition"]> = {}): AgentRoleImplementation {
  return {
    definition: {
      id: "writer",
      revision: "1",
      title: "写作",
      specialty: "写东西",
      instructions: "你是作者。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: { prompt: { type: "string", minLength: 1 } }
      },
      contextSchema: { type: "object" },
      tools: { required: ["get_model_node"], optional: ["submit_model_script"] },
      nativeCapabilities: { required: [], optional: ["generate-image"] },
      requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
      output: { kind: "reply" },
      ...overrides
    },
    prepare: ({ nativeCapabilities }) => ({
      messages: [{ role: "user", content: nativeCapabilities.includes("generate-image") ? "with image" : "text" }],
      ...(nativeCapabilities.includes("generate-image") ? { tools: ["get_model_node", "submit_model_script"] } : { tools: ["get_model_node"] })
    })
  };
}

describe("CLI 角色准备", () => {
  it("从模块构造命名空间身份并冻结 preparedHash", () => {
    const entries = roleEntries([implementation()], { extensionId: "test", artifactId: "cli@1" });
    expect(entries[0]?.namespacedId).toBe("test/writer");
    const prepared = prepareCliRoleTurn({
      entry: entries[0]!,
      roleInput: { prompt: "盒子" },
      context: {},
      target: { canvasId: "c" },
      requestId: "r1"
    });
    expect(prepared.roleRef).toMatchObject({ namespacedId: "test/writer", artifactId: "cli@1" });
    expect(prepared.messages[0]!.content).toContain("你是作者");
    expect(prepared.tools).toEqual(["get_model_node"]);
    expect(prepared.preparedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("按通道能力求交，required 缺失拒绝", () => {
    const entry = roleEntries([implementation()], { extensionId: "test" })[0]!;
    const channel = channelForDefinition(entry.definition);
    expect(channel.toolCalling).toBe(true);
    expect(() => prepareCliRoleTurn({ entry, roleInput: { prompt: "x" }, context: {}, target: {}, requestId: "r", channel: { ...channel, toolCalling: false } }))
      .toThrow("不满足角色要求");
  });

  it("可选内建能力按通道开启，工具收窄不能越界", () => {
    const entry = roleEntries([implementation()], { extensionId: "test" })[0]!;
    const off = prepareCliRoleTurn({ entry, roleInput: { prompt: "x" }, context: {}, target: {}, requestId: "r" });
    expect(off.nativeCapabilities).toEqual([]);
    expect(off.tools).toEqual(["get_model_node"]);
    const on = prepareCliRoleTurn({
      entry,
      roleInput: { prompt: "x" },
      context: {},
      target: {},
      requestId: "r",
      channel: { ...channelForDefinition(entry.definition), nativeCapabilities: ["generate-image"] }
    });
    expect(on.nativeCapabilities).toEqual(["generate-image"]);
    expect(on.tools).toEqual(["get_model_node", "submit_model_script"]);
    expect(() => prepareCliRoleTurn({ entry, roleInput: { prompt: "x" }, context: {}, target: {}, requestId: "r", requestedTools: ["shell"] }))
      .toThrow("未声明");
  });

  it("输入/上下文 schema 校验与未知角色", () => {
    const entry = roleEntries([implementation()], { extensionId: "test" })[0]!;
    expect(() => prepareCliRoleTurn({ entry, roleInput: {}, context: {}, target: {}, requestId: "r" })).toThrow("角色输入非法");
    expect(() => prepareCliRoleTurn({ entry, roleInput: { prompt: "x" }, context: "bad", target: {}, requestId: "r" })).toThrow("角色上下文非法");
    expect(() => roleEntries([implementation({ tools: { required: ["Bad Name"], optional: [] } })])).toThrow("角色实现无效");
  });
});
