/**
 * 测试用 prepared turn（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 执行通道测试只需要一个**已由宿主准备**的规范请求：消息、工具集、输出契约与目标身份。
 * 这里不引入任何业务角色实现，也不复制仓库里的角色模板；文字只用于验证通道原样转发。
 */
import {
  AGENT_MODEL_TOOLS,
  ASSISTANT_WORLD_TOOLS,
  assistantWorldToolsForScope,
  CANVAS_GROUP_TOOLS,
  preparedTurnHash,
  type AgentEntryIntent,
  type AgentPromptMessage,
  type AgentRoleChannelCapabilities,
  type AgentRoleTargetRef,
  type PreparedAgentRoleTurn
} from "@woohaa3/contracts";

export function toolsForTestIntent(intent: Pick<AgentEntryIntent, "action" | "mode" | "worldScope">): readonly string[] {
  if (intent.action === "discuss") return [];
  if (intent.mode === "world") {
    return intent.worldScope ? assistantWorldToolsForScope(intent.worldScope) : [...ASSISTANT_WORLD_TOOLS];
  }
  if (intent.mode === "canvas-group") return [...CANVAS_GROUP_TOOLS];
  return [...AGENT_MODEL_TOOLS];
}

export function buildTestPreparedTurn(input: {
  requestId: string;
  target: AgentRoleTargetRef;
  prompt: string;
  messages?: readonly AgentPromptMessage[];
  tools?: readonly string[];
  output?: PreparedAgentRoleTurn["output"];
  nativeCapabilities?: PreparedAgentRoleTurn["nativeCapabilities"];
  roleRevision?: string;
}): PreparedAgentRoleTurn {
  const targetLine = [
    `canvasId="${input.target.canvasId ?? ""}"`,
    `nodeId="${input.target.nodeId ?? ""}"`,
    `mode="${input.target.mode ?? "model3d"}"`,
    ...(input.target.worldScope
      ? [`scope="${input.target.worldScope.kind}:${input.target.worldScope.areaId ?? input.target.worldScope.groupId ?? input.target.worldScope.cameraId ?? ""}"`]
      : []),
    ...(input.target.cameraId ? [`cameraId="${input.target.cameraId}"`] : [])
  ].join(", ");
  const messages: readonly AgentPromptMessage[] = input.messages ?? [
    { role: "system", content: "测试角色：只按宿主准备的规范请求执行。" },
    {
      role: "user",
      content: [
        `目标：${targetLine}。`,
        `本次请求稳定 id：requestId="${input.requestId}"。`,
        "流程：先调用 get_model_api / get_model_node 读取权威内容，再用 submit_model_script 提交；工具失败时如实说明。",
        `用户请求：${input.prompt}`
      ].join("\n")
    }
  ];
  const base: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
    schemaVersion: 1,
    roleRef: {
      namespacedId: "test-fixture/role",
      roleId: "role",
      extensionId: "test-fixture",
      revision: input.roleRevision ?? "1",
      descriptorDigest: "d".repeat(64),
      artifactId: "test-fixture@1"
    },
    messages,
    tools: input.tools ?? [],
    nativeCapabilities: input.nativeCapabilities ?? [],
    output: input.output ?? { kind: "tool-receipts" },
    inputDigest: "a".repeat(64),
    contextDigest: "b".repeat(64),
    attachmentDigests: [],
    target: input.target
  };
  return { ...base, preparedHash: preparedTurnHash(base) };
}

export const TEST_CHANNEL: AgentRoleChannelCapabilities = {
  toolCalling: true,
  imageInput: false,
  structuredOutput: "validated-json",
  nativeCapabilities: []
};
