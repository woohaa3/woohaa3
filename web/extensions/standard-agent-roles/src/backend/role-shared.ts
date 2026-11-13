/**
 * 标准角色共享形状（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 只放**可序列化**的定义片段与纯输入解码；不 import 执行通道、不读 I/O。
 */
import { isJsonObject } from "@woohaa3/contracts";
import type { AgentRoleDefinition, AgentRoleJsonSchema, AgentRoleOutput } from "@woohaa3/contracts";

/** 业务入口提交的角色输入：用户原文、动作与（可选）目标模式。 */
export const CONVERSATION_INPUT_SCHEMA: AgentRoleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "action"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 20_000 },
    action: { type: "string", enum: ["discuss", "generate", "modify"] },
    mode: { type: "string", enum: ["model3d", "camera", "text", "world", "canvas-group"] }
  }
};

/** 工具角色不依赖领域上下文（真实上下文由工具按授权读取）。 */
export const OPEN_CONTEXT_SCHEMA: AgentRoleJsonSchema = { type: "object" };

export function conversationPrompt(input: unknown): string {
  if (!isJsonObject(input) || typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new Error("缺少用户请求");
  }
  return input.prompt;
}

export function optionalString(value: unknown, key: string): string | undefined {
  return isJsonObject(value) && typeof value[key] === "string" ? value[key] : undefined;
}

export const REPLY_OUTPUT: AgentRoleOutput = { kind: "reply" };
export const RECEIPTS_OUTPUT: AgentRoleOutput = { kind: "tool-receipts" };

/** 角色定义的无秘密形状；revision 变化即视为契约变化。 */
export type StandardRoleDefinition = AgentRoleDefinition;
