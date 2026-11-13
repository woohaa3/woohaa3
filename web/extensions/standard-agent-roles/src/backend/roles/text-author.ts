/**
 * text-author：文本作品的无工具候选角色。
 *
 * 迁移自 Application 文本交付服务的内联输出约束。领域仍拥有编译后的用户提示词、版本基线、
 * 候选校验、保存重试与回执；角色只构造规范消息与候选契约。
 */
import { assistantTextCandidateSchema } from "@woohaa3/contracts";
import type { AgentRoleImplementation, AgentRoleJsonSchema } from "@woohaa3/contracts";
import { CONVERSATION_INPUT_SCHEMA } from "../role-shared.js";

const CONTEXT_SCHEMA: AgentRoleJsonSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    baseline: { type: "string" }
  }
};

export const TEXT_AUTHOR_OUTPUT_SCHEMA = assistantTextCandidateSchema;

export const textAuthorRole: AgentRoleImplementation = {
  definition: {
    id: "text-author",
    revision: "1",
    title: "文本作者",
    specialty: "根据文本节点的输入与参考素材写出完整正文，不改动画布结构",
    instructions: [
      "你是 Woohaa3 文本节点作者。",
      "只输出符合给定 schema 的 JSON；text 字段是完整正文，保留用户要求的 Markdown 格式。",
      "不要调用工具、不要修改节点结构或其它节点；正文之外的判断都属于无效输出。"
    ].join("\n"),
    inputSchema: CONVERSATION_INPUT_SCHEMA,
    contextSchema: CONTEXT_SCHEMA,
    tools: { required: [], optional: [] },
    nativeCapabilities: { required: [], optional: [] },
    requirements: { imageInput: false, toolCalling: false, structuredOutput: "validated-json" },
    output: { kind: "candidate", schema: TEXT_AUTHOR_OUTPUT_SCHEMA }
  },
  prepare({ input, context }) {
    const read = typeof context === "object" && context !== null ? context as Record<string, unknown> : {};
    const prompt = typeof read.prompt === "string" && read.prompt.trim() !== ""
      ? read.prompt
      : typeof (input as { prompt?: unknown }).prompt === "string"
        ? (input as { prompt: string }).prompt
        : "";
    return {
      messages: [{
        role: "user",
        content: [
          prompt,
          "Return only JSON matching this schema. The text field is the complete artwork, preserving Markdown.",
          JSON.stringify(TEXT_AUTHOR_OUTPUT_SCHEMA)
        ].join("\n")
      }]
    };
  }
};
