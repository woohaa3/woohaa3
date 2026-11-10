/**
 * 核心角色注册表 / 准备协调（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 覆盖：跨 owner 独立命名空间、重复身份拒绝、停用收回、目录投影、能力/工具求交、
 * 内建能力可选分支、确定性摘要与第三方测试角色无需改核心。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRoleChannelCapabilities, AgentRoleImplementation } from "@woohaa3/contracts";
import { createAgentRoleRegistry } from "./registry.js";

const CHANNEL: AgentRoleChannelCapabilities = {
  toolCalling: true,
  imageInput: false,
  structuredOutput: "none",
  nativeCapabilities: []
};

function role(overrides: Partial<AgentRoleImplementation["definition"]> = {}, preparedTools?: readonly string[]): AgentRoleImplementation {
  return {
    definition: {
      id: "writer",
      revision: "1",
      title: "写作",
      specialty: "写模型",
      instructions: "你是模型作者。",
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
      output: { kind: "tool-receipts" },
      ...overrides
    },
    prepare: () => ({
      messages: [{ role: "user", content: "写一个盒子" }],
      ...(preparedTools ? { tools: preparedTools } : {})
    })
  };
}

function prepare(registry: ReturnType<typeof createAgentRoleRegistry>, input: {
  roleId?: string;
  prompt?: string;
  tools?: readonly string[];
  channel?: Partial<AgentRoleChannelCapabilities>;
} = {}) {
  return registry.prepare({
    roleId: input.roleId ?? "test/writer",
    input: { prompt: input.prompt ?? "盒子" },
    context: {},
    target: { canvasId: "canvas", nodeId: "node", mode: "model3d" },
    requestId: "r1",
    channel: { ...CHANNEL, ...input.channel },
    ...(input.tools ? { requestedTools: input.tools } : {})
  });
}

describe("Agent 角色注册表", () => {
  it("按扩展命名空间独立注册，重复完整身份被拒绝", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node", "submit_model_script"] });
    expect(registry.register({ extensionId: "a", implementation: role(), artifactId: "a@1" }).ok).toBe(true);
    expect(registry.register({ extensionId: "b", implementation: role(), artifactId: "b@1" }).ok).toBe(true);
    expect(registry.register({ extensionId: "a", implementation: role(), artifactId: "a@2" })).toMatchObject({ ok: false, code: "role-duplicate" });
    expect(registry.list().map((entry) => entry.ref.namespacedId)).toEqual(["a/writer", "b/writer"]);
  });

  it("非法定义与自报越界字段被拒绝", () => {
    const registry = createAgentRoleRegistry();
    expect(registry.register({ extensionId: "a", implementation: role({ tools: { required: ["x y"], optional: [] } }), artifactId: "a@1" })).toMatchObject({ ok: false, code: "role-invalid-definition" });
    expect(registry.register({ extensionId: "a", implementation: { ...role(), definition: { ...role().definition, connectionId: "c" } } as never, artifactId: "a@1" })).toMatchObject({ ok: false, code: "role-forbidden-field" });
  });

  it("扩展停用收回角色并通知一次", () => {
    const registry = createAgentRoleRegistry();
    const listener = vi.fn();
    registry.onUnregistered(listener);
    registry.register({ extensionId: "a", implementation: role(), artifactId: "a@1" });
    registry.register({ extensionId: "b", implementation: role(), artifactId: "b@1" });
    registry.disposeExtension("a");
    expect(registry.resolve("a/writer")).toBeNull();
    expect(registry.resolve("b/writer")).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ namespacedId: "a/writer" });
    registry.disposeExtension("a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("输入/上下文非法在准备前拒绝", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    registry.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    expect(prepare(registry, { prompt: "" })).toMatchObject({ ok: false, code: "role-input-invalid" });
    expect(registry.prepare({ roleId: "test/writer", input: { prompt: "x" }, context: "x", target: {}, requestId: "r", channel: CHANNEL })).toMatchObject({ ok: false, code: "role-context-invalid" });
  });

  it("required 缺失拒绝，optional 按目录收窄，prepare 只能进一步收窄", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    registry.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    const prepared = prepare(registry);
    expect(prepared.ok && prepared.turn.tools).toEqual(["get_model_node"]);
    expect(prepare(registry, { roleId: "test/writer", channel: { toolCalling: false } })).toMatchObject({ ok: false, code: "role-requirement-unsatisfied" });
    expect(prepare(registry, { tools: ["not-declared"] })).toMatchObject({ ok: false, code: "role-input-invalid" });
  });

  it("prepare 不能引入未声明工具，也不能伪装成必需能力", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node", "shell"] });
    registry.register({ extensionId: "test", implementation: role({}, ["get_model_node", "shell"]), artifactId: "test@1" });
    expect(prepare(registry)).toMatchObject({ ok: false, code: "role-prepare-failed" });
  });

  it("内建能力只按通道真实支持开启，可选分支可影响工具收窄", () => {
    const implementation = role();
    const prepareSpy = vi.fn(({ nativeCapabilities }: { nativeCapabilities: readonly string[] }) => ({
      messages: [{ role: "user" as const, content: nativeCapabilities.includes("generate-image") ? "with image" : "text only" }],
      tools: nativeCapabilities.includes("generate-image") ? ["get_model_node", "submit_model_script"] : ["get_model_node"]
    }));
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node", "submit_model_script"] });
    registry.register({ extensionId: "test", implementation: { ...implementation, prepare: prepareSpy }, artifactId: "test@1" });
    const off = prepare(registry);
    expect(off.ok && off.turn.nativeCapabilities).toEqual([]);
    expect(off.ok && off.turn.tools).toEqual(["get_model_node"]);
    const on = prepare(registry, { channel: { nativeCapabilities: ["generate-image"] } });
    expect(on.ok && on.turn.nativeCapabilities).toEqual(["generate-image"]);
    expect(on.ok && on.turn.tools).toEqual(["get_model_node", "submit_model_script"]);
  });

  it("通道能力缺失（图片/结构化）在准备前拒绝", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    registry.register({
      extensionId: "test",
      implementation: role({ requirements: { imageInput: true, toolCalling: true, structuredOutput: "schema-enforced" } }),
      artifactId: "test@1"
    });
    expect(prepare(registry)).toMatchObject({ ok: false, code: "role-requirement-unsatisfied" });
  });

  it("同一输入得到确定性 preparedHash，角色修订变化则摘要变化", () => {
    const registry = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    registry.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    const first = prepare(registry);
    const second = prepare(registry);
    expect(first.ok && first.turn.preparedHash).toBe(second.ok && second.turn.preparedHash);
    registry.disposeExtension("test");
    registry.register({ extensionId: "test", implementation: role({ revision: "2" }), artifactId: "test@1" });
    const upgraded = prepare(registry);
    expect(upgraded.ok && upgraded.turn.preparedHash).not.toBe(first.ok && first.turn.preparedHash);
  });

  it("目录只读投影包含可用性与缺失原因，不触发 prepare", () => {
    const prepareSpy = vi.fn(role().prepare);
    const registry = createAgentRoleRegistry({ availableTools: () => [] });
    registry.register({ extensionId: "test", implementation: { ...role(), prepare: prepareSpy }, artifactId: "test@1" });
    const listed = registry.list();
    expect(listed[0]).toMatchObject({ ref: { namespacedId: "test/writer" }, outputKind: "tool-receipts" });
    expect(listed[0]!.available).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(registry.availability("test/writer")).toMatchObject({ available: false });
  });
});
