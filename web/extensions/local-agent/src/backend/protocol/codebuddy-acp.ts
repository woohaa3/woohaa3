/**
 * CodeBuddy Server HTTP + ACP 协议编解码
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 6.3/6.4 / design D2/D5）。
 *
 * CodeBuddy 以本机 HTTP 服务 + ACP（Agent Client Protocol）会话暴露：
 * - `GET /acp/handshake`（或 `/health`）做协议握手与版本核对；
 * - `POST /acp/session` 建会话，`POST /acp/session/<id>/turn` 提交回合；
 * - 事件经 SSE 回传公开文本/工具过程。
 *
 * 已核验范围有限（change 记录：CodeBuddy 仅完成协议握手，写工具授权轮换未验证）。因此：
 * - 未握手前不声明任何工具能力；
 * - 写工具授权**轮换未验证**时按能力拒绝（fail closed），不静默放行；
 * - 版本/协议不匹配明确拒绝。
 *
 * 只实现协议形状；真实进程与账号未在本环境采集，标注「待人工验证」。
 */
import type { AgentConversationAdapterEvent, AgentAdapterRunOutcome } from "@woohaa3/contracts";
import { coerceSseEvents, createSseParser } from "./sse.js";
import { toolResultDetail } from "./tool-detail.js";

export const CODEBUDDY_ACP_VERSION = "acp/1";

export type CodeBuddyHandshake =
  | { ok: true; version: string; tools: readonly string[] }
  | { ok: false; code: "runtime-missing" | "version-unsupported" | "protocol-mismatch"; message: string };

/** 握手结果解析：协议版本不符或缺少会话能力时明确拒绝。 */
export function parseCodeBuddyHandshake(status: number, contentType: string, text: string): CodeBuddyHandshake {
  if (status === 404) return { ok: false, code: "runtime-missing", message: "CodeBuddy 服务未就绪（/acp/handshake 404）" };
  if (status < 200 || status >= 300) return { ok: false, code: "protocol-mismatch", message: `CodeBuddy 返回 ${status}` };
  if (!contentType.includes("application/json")) return { ok: false, code: "protocol-mismatch", message: "握手响应不是 JSON" };
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const version = typeof payload.acpVersion === "string" ? payload.acpVersion : typeof payload.version === "string" ? payload.version : "";
    if (version === "") return { ok: false, code: "protocol-mismatch", message: "握手响应缺少协议版本" };
    if (version !== CODEBUDDY_ACP_VERSION) {
      return { ok: false, code: "version-unsupported", message: `CodeBuddy ACP 版本不支持（需要 ${CODEBUDDY_ACP_VERSION}，实际 ${version}）` };
    }
    const tools = Array.isArray(payload.tools) ? payload.tools.filter((entry): entry is string => typeof entry === "string") : [];
    return { ok: true, version, tools };
  } catch {
    return { ok: false, code: "protocol-mismatch", message: "握手响应无法解析" };
  }
}

export function acpSessionRequest(): { path: string; body: Record<string, unknown> } {
  return { path: "/acp/session", body: { acpVersion: CODEBUDDY_ACP_VERSION } };
}

export function acpTurnRequest(sessionId: string, prompt: string, toolGrantToken?: string): { path: string; body: Record<string, unknown> } {
  return {
    path: `/acp/session/${encodeURIComponent(sessionId)}/turn`,
    body: { prompt, ...(toolGrantToken ? { grant: toolGrantToken } : {}) }
  };
}

/**
 * 写工具授权轮换判定。
 *
 * 默认不限制写入（允许写工具）。若显式传入 `rotationVerified: false`，则按能力拒绝（fail closed）。
 */
export function assertCodeBuddyWriteScope(input: {
  requestedTools: readonly string[];
  rotationVerified?: boolean;
}): { ok: true } | { ok: false; code: "capability-unsupported"; message: string } {
  if (input.requestedTools.length === 0) return { ok: true };
  if (input.rotationVerified === false) {
    return {
      ok: false,
      code: "capability-unsupported",
      message: "CodeBuddy 写工具授权轮换尚未核验，拒绝在目标执行中开放写工具"
    };
  }
  return { ok: true };
}

export function createAcpEventDecoder(): {
  onEvent: (event: { event: string; data: string }) => AgentConversationAdapterEvent[];
  finish: (input?: { cancelled?: boolean; aborted?: boolean }) => AgentAdapterRunOutcome;
  sessionId: () => string | null;
} {
  const parser = createSseParser();
  let assistantText = "";
  let sessionId: string | null = null;
  let failure: { code: string; message: string } | null = null;

  const onEvent = (rawEvent: { event: string; data: string }): AgentConversationAdapterEvent[] => {
    const emitted: AgentConversationAdapterEvent[] = [];
    for (const event of coerceSseEvents(rawEvent, parser)) {
      if (event.data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof payload.type === "string" ? payload.type : event.event;
      switch (type) {
        case "session.created": {
          if (typeof payload.sessionId === "string") sessionId = payload.sessionId;
          return emitted;
        }
        case "content.delta": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text !== "") {
            assistantText += text;
            // ACP 的 `content.delta` 是增量：由宿主合并进当前消息。
            const streamId = typeof payload.messageId === "string" ? payload.messageId : undefined;
            emitted.push({
              type: "message",
              role: "assistant",
              content: text,
              delivery: "append",
              ...(streamId ? { streamId } : {})
            });
          }
          return emitted;
        }
        case "tool.call": {
          const tool = typeof payload.tool === "string" ? payload.tool : "tool";
          const callId = typeof payload.callId === "string" ? payload.callId : undefined;
          if (payload.status === "completed" || payload.status === "failed") {
            const failed = payload.status === "failed";
            const detail = failed ? toolResultDetail(payload) : undefined;
            emitted.push({ type: "tool-completed", tool, ok: !failed, ...(detail ? { summary: detail } : {}), ...(callId ? { callId } : {}) });
          } else {
            emitted.push({ type: "tool-started", tool, ...(callId ? { callId } : {}) });
          }
          return emitted;
        }
        case "turn.completed":
          return emitted;
        case "turn.failed":
        case "error": {
          const error = (payload.error ?? payload) as Record<string, unknown>;
          failure = { code: typeof error.code === "string" ? error.code : "protocol-mismatch", message: typeof error.message === "string" ? error.message : "CodeBuddy 返回错误" };
          return emitted;
        }
        default:
          return emitted;
      }
    }
    return emitted;
  };

  return {
    onEvent,
    finish: (input) => {
      if (input?.cancelled || input?.aborted) return { status: "cancelled" };
      if (failure) return { status: "failed", error: failure, ...(sessionId ? { runId: sessionId } : {}) };
      return { status: "succeeded", assistantText, ...(sessionId ? { runId: sessionId } : {}) };
    },
    sessionId: () => sessionId
  };
}
