/**
 * camera-composer：单个世界镜头的构图角色。
 *
 * 迁移自 `target-prompt` 的 world-camera 分支；只允许读镜头上下文与写同一个镜头。
 */
import { ASSISTANT_WORLD_CAMERA_TOOLS } from "@woohaa3/contracts";
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { conversationPrompt, CONVERSATION_INPUT_SCHEMA, OPEN_CONTEXT_SCHEMA, RECEIPTS_OUTPUT } from "../role-shared.js";
import { CAMERA_COMPOSER_FLOW, targetLine, TOOL_COMMON_RULES } from "../prompts.js";

export const cameraComposerRole: AgentRoleImplementation = {
  definition: {
    id: "camera-composer",
    revision: "2",
    title: "镜头构图",
    specialty: "读取权威镜头与场景包围盒，只调整所选镜头的机位、朝向、FoV 与画幅",
    instructions: ["你是 Woohaa3 镜头构图 Agent。", ...TOOL_COMMON_RULES, ...CAMERA_COMPOSER_FLOW].join("\n"),
    inputSchema: CONVERSATION_INPUT_SCHEMA,
    contextSchema: OPEN_CONTEXT_SCHEMA,
    tools: { required: [...ASSISTANT_WORLD_CAMERA_TOOLS], optional: [] },
    nativeCapabilities: { required: [], optional: [] },
    requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
    output: RECEIPTS_OUTPUT
  },
  prepare({ input, target, requestId }) {
    const lines = [`目标：${targetLine(target)}。`, `本次请求稳定 id：requestId="${requestId}"。`];
    lines.push(conversationPrompt(input));
    return { messages: [{ role: "user", content: lines.join("\n") }] };
  }
};
