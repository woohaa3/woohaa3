import { createHash } from "node:crypto";
import type { AgentAdapterRunInput, PreparedAgentRoleTurn } from "@woohaa3/contracts";

/** All fields come from the accepted host turn, never a browser-supplied owner. */
export type NativeContext = {
  engineVersion: string;
  configRevision: number;
  credentialEpoch: number;
  conversationId: string;
  targetContext: string;
};

export function nativeContextFor(input: AgentAdapterRunInput, engineVersion: string): NativeContext {
  if (!input.connection) throw new Error("Missing frozen connection binding");
  const prepared = input.prepared;
  return {
    engineVersion,
    configRevision: input.connection.configRevision,
    credentialEpoch: input.connection.credentialEpoch,
    conversationId: input.conversationId,
    targetContext: JSON.stringify([
      input.canvasId, input.intent.nodeId ?? null, input.intent.mode ?? null,
      input.intent.cameraId ?? null, input.intent.clipId ?? null, input.intent.itemId ?? null,
      // 角色与真实工具范围纳入原生上下文身份（change: 2026-11-07-add-pluggable-agent-roles）：
      // 换角色、升级修订或换工具面都不得复用旧线程。
      prepared ? prepared.roleRef.namespacedId : null,
      prepared ? prepared.roleRef.revision : null,
      prepared ? prepared.preparedHash : null,
      prepared ? [...prepared.tools].sort() : null
    ])
  };
}

/** Full digest avoids collisions from truncating encoded owner or directory names. */
export function nativeContextKey(owner: string, connectionId: string, context: NativeContext): string {
  return createHash("sha256").update(JSON.stringify([
    owner, connectionId, context.engineVersion, context.configRevision, context.credentialEpoch,
    context.conversationId, context.targetContext
  ])).digest("hex");
}

/**
 * 规范准备消息 → 单文本 prompt（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 执行通道可以按协议转换消息形态；这里不做业务改写，只按语义角色拼接宿主已准备的正文。
 */
export function preparedPromptText(prepared: PreparedAgentRoleTurn): string {
  return prepared.messages
    .map((message) => message.role === "system" ? message.content : message.role === "assistant" ? `助手：${message.content}` : message.content)
    .join("\n\n");
}
