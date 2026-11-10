/**
 * model-author：3D 模型脚本的工具创作角色。
 *
 * 迁移自 agent-connections `target-prompt` 的 model3d 分支。工具声明引用公开契约，
 * 真实写入仍由 MCP grant 与 Canvas 权限决定。
 */
import { AGENT_MODEL_TOOLS } from "@woohaa3/contracts";
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { conversationPrompt, CONVERSATION_INPUT_SCHEMA, OPEN_CONTEXT_SCHEMA, RECEIPTS_OUTPUT } from "../role-shared.js";
import { MODEL_AUTHOR_FLOW, targetLine, TOOL_COMMON_RULES } from "../prompts.js";

export const modelAuthorRole: AgentRoleImplementation = {
  definition: {
    id: "model-author",
    revision: "1",
    title: "模型作者",
    specialty: "在 3D 模型节点内读取权威脚本并做最小必要增量修改",
    instructions: [
      "你是 Woohaa3 Model Canvas 的 3D 创作 Agent。",
      ...TOOL_COMMON_RULES,
      ...MODEL_AUTHOR_FLOW
    ].join("\n"),
    inputSchema: CONVERSATION_INPUT_SCHEMA,
    contextSchema: OPEN_CONTEXT_SCHEMA,
    tools: { required: [...AGENT_MODEL_TOOLS], optional: [] },
    nativeCapabilities: { required: [], optional: [] },
    requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
    output: RECEIPTS_OUTPUT
  },
  prepare({ input, target, requestId, expectedContentHash }) {
    const lines = [`目标：${targetLine(target)}。`, `本次请求稳定 id：requestId="${requestId}"。`];
    if (expectedContentHash) lines.push(`宿主冻结的内容哈希：${expectedContentHash}；提交前仍以工具读取结果为准。`);
    lines.push(conversationPrompt(input));
    return { messages: [{ role: "user", content: lines.join("\n") }] };
  }
};
