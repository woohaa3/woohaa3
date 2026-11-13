/**
 * 测试用已准备角色回合（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 只用于让执行通道测试聚焦「消费规范请求」：固定 system + user 消息、固定工具集与候选契约。
 */
import {
  AGENT_MODEL_READ_TOOLS,
  AGENT_MODEL_WRITE_TOOLS,
  modelCandidateSchema,
  preparedTurnHash,
  type AgentPromptMessage,
  type PreparedAgentRoleTurn
} from "@woohaa3/contracts";

export function testPreparedTurn(input: {
  requestId?: string;
  canvasId?: string;
  nodeId?: string;
  mode?: "model3d" | "camera";
  prompt?: string;
  messages?: readonly AgentPromptMessage[];
  tools?: readonly string[];
  output?: PreparedAgentRoleTurn["output"];
  selectedCameraId?: string;
} = {}): PreparedAgentRoleTurn {
  const turn: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
    schemaVersion: 1,
    roleRef: {
      namespacedId: "test/role",
      roleId: "role",
      extensionId: "test",
      revision: "1",
      descriptorDigest: "d".repeat(64),
      artifactId: "test@1"
    },
    messages: input.messages ?? [
      { role: "system", content: "测试角色系统指令" },
      { role: "user", content: input.prompt ?? "编辑模型" }
    ],
    tools: input.tools ?? [...AGENT_MODEL_READ_TOOLS, ...AGENT_MODEL_WRITE_TOOLS],
    nativeCapabilities: [],
    output: input.output ?? { kind: "tool-receipts" },
    inputDigest: "a".repeat(64),
    contextDigest: "b".repeat(64),
    attachmentDigests: [],
    target: {
      canvasId: input.canvasId ?? "cv",
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.selectedCameraId ? { cameraId: input.selectedCameraId } : {})
    }
  };
  return { ...turn, preparedHash: preparedTurnHash(turn) };
}

export function testCandidateTurn(input: { prompt?: string; tools?: readonly string[] } = {}): PreparedAgentRoleTurn {
  return testPreparedTurn({
    ...(input.prompt ? { prompt: input.prompt } : {}),
    tools: input.tools ?? [],
    output: { kind: "candidate", schema: modelCandidateSchema() }
  });
}
