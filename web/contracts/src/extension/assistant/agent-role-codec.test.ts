import { describe, expect, it } from "vitest";
import {
  agentRoleDescriptorDigest,
  decodeAgentRoleDefinition,
  decodeAgentRoleImplementation,
  decodeAgentRolePrompt,
  decodePreparedAgentRoleTurn,
  makeAgentRoleRef,
  preparedTurnHash,
  validateAgentRoleValue
} from "./index.js";
import { sha256Hex } from "./agent-role-digest.js";
import type { AgentRoleImplementation, PreparedAgentRoleTurn } from "./index.js";

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
      contextSchema: { type: "object", properties: { source: { type: "string" } } },
      tools: { required: ["get_model_node"], optional: ["submit_model_script"] },
      nativeCapabilities: { required: [], optional: ["generate-image"] },
      requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
      output: { kind: "reply" },
      ...overrides
    },
    prepare: () => ({ messages: [{ role: "user", content: "hi" }] })
  };
}

describe("Agent 角色契约", () => {
  it("sha256 与标准向量一致", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("严格解码定义，拒绝未知字段与执行/授权字段", () => {
    expect(decodeAgentRoleDefinition(implementation().definition).ok).toBe(true);
    expect(decodeAgentRoleDefinition({ ...implementation().definition, extra: 1 })).toMatchObject({ ok: false, code: "role-invalid-definition" });
    expect(decodeAgentRoleDefinition({ ...implementation().definition, connectionId: "c" })).toMatchObject({ ok: false, code: "role-forbidden-field" });
    expect(decodeAgentRoleDefinition({ ...implementation().definition, model: "gpt" })).toMatchObject({ ok: false, code: "role-forbidden-field" });
  });

  it("拒绝必需/可选工具重叠、非法工具名与空定义", () => {
    expect(decodeAgentRoleDefinition(implementation({ tools: { required: ["a"], optional: ["a"] } }).definition)).toMatchObject({ ok: false });
    expect(decodeAgentRoleDefinition(implementation({ tools: { required: ["Bad Name"], optional: [] } }).definition)).toMatchObject({ ok: false });
    expect(decodeAgentRoleDefinition(implementation({ instructions: "" }).definition)).toMatchObject({ ok: false });
  });

  it("校验 input/context schema 值（含额外字段与最小值）", () => {
    const definition = decodeAgentRoleDefinition(implementation().definition);
    if (!definition.ok) throw new Error("definition invalid");
    expect(validateAgentRoleValue(definition.value.inputSchema, { prompt: "x" })).toBeNull();
    expect(validateAgentRoleValue(definition.value.inputSchema, {})).toMatchObject({ path: "prompt" });
    expect(validateAgentRoleValue(definition.value.inputSchema, { prompt: "" })).toMatchObject({ path: "prompt" });
    expect(validateAgentRoleValue(definition.value.inputSchema, { prompt: "x", extra: 1 })).toMatchObject({ path: "extra" });
    expect(validateAgentRoleValue(definition.value.contextSchema, { source: "s" })).toBeNull();
    expect(validateAgentRoleValue(definition.value.contextSchema, { source: 3 })).toMatchObject({ path: "source" });
  });

  it("prepare 工具收窄不能引入未声明工具", () => {
    expect(decodeAgentRolePrompt({ messages: [{ role: "user", content: "x" }], tools: ["get_model_node"] }, ["get_model_node", "submit_model_script"]).ok).toBe(true);
    expect(decodeAgentRolePrompt({ messages: [{ role: "user", content: "x" }], tools: ["shell"] }, ["get_model_node"])).toMatchObject({ ok: false, code: "role-prepare-failed" });
    expect(decodeAgentRolePrompt({ messages: [] }, [])).toMatchObject({ ok: false, code: "role-prepare-failed" });
  });

  it("prepared turn 摘要可复算，篡改会被拒绝", () => {
    const definition = decodeAgentRoleDefinition(implementation().definition);
    if (!definition.ok) throw new Error("definition invalid");
    const base: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
      schemaVersion: 1,
      roleRef: makeAgentRoleRef({
        extensionId: "test",
        roleId: "writer",
        revision: "1",
        descriptorDigest: agentRoleDescriptorDigest(definition.value),
        artifactId: "test@1"
      }),
      messages: [{ role: "system", content: "你是作者。" }],
      tools: ["get_model_node"],
      nativeCapabilities: [],
      output: { kind: "reply" },
      inputDigest: "a".repeat(64),
      contextDigest: "b".repeat(64),
      attachmentDigests: [],
      target: { canvasId: "c" }
    };
    const turn: PreparedAgentRoleTurn = { ...base, preparedHash: preparedTurnHash(base) };
    expect(decodePreparedAgentRoleTurn(turn).ok).toBe(true);
    // 目标中的世界范围/镜头/内容哈希同样参与摘要，恢复后必须原样保留。
    const scopedBase = {
      ...base,
      target: {
        canvasId: "c",
        nodeId: "n",
        mode: "world" as const,
        cameraId: "cam",
        expectedContentHash: "h",
        worldScope: { kind: "world-camera" as const, cameraId: "cam" }
      }
    };
    expect(decodePreparedAgentRoleTurn({ ...scopedBase, preparedHash: preparedTurnHash(scopedBase) }).ok).toBe(true);
    expect(decodePreparedAgentRoleTurn({ ...turn, tools: ["submit_model_script"] })).toMatchObject({ ok: false, code: "role-version-conflict" });
  });

  it("实现必须带 prepare，且不接受额外字段", () => {
    expect(decodeAgentRoleImplementation(implementation()).ok).toBe(true);
    expect(decodeAgentRoleImplementation({ definition: implementation().definition })).toMatchObject({ ok: false });
    expect(decodeAgentRoleImplementation({ ...implementation(), extra: true })).toMatchObject({ ok: false });
  });
});
