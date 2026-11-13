/**
 * OpenCode Server HTTP + SSE 协议编解码
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 6.1/6.2 / design D2/D5）。
 *
 * OpenCode 以本机 HTTP 服务暴露：
 * - `GET /global/health`（或 `/app`）做版本/健康探测；
 * - `POST /session` 建会话，`POST /session/<id>/message` 提交消息；
 * - `GET /event` 的 SSE 事件流回传增量（流是**易失**的：断线可能丢窗口，不当作权威）。
 *
 * 关键约束（design D5）：
 * - MCP 配置在 v2 是 **location 级共享**：本轮工具授权不能靠「给会话加 header」热切换；
 *   必须重启/新建 location 或按官方支持路径生效，否则明确拒绝写能力（不静默越权）；
 * - 只投影公开文本/工具过程；事件窗口不连续时要求调用方以权威快照复位。
 *
 * 只实现协议形状；真实进程与账号未在本环境采集，标注「待人工验证」。
 */
import type { AgentConversationAdapterEvent, AgentAdapterRunOutcome } from "@woohaa3/contracts";
import { coerceSseEvents, createSseParser } from "./sse.js";
import { toolResultDetail } from "./tool-detail.js";

export const OPENCODE_SUPPORTED_MAJOR = 2;

export type OpenCodeHealth =
  | { ok: true; version: string; major: number }
  | { ok: false; code: "runtime-missing" | "version-unsupported" | "protocol-mismatch"; message: string };

/** 健康/版本探测：非 v2 明确拒绝（不猜测旧版路由）。 */
export function parseOpenCodeHealth(status: number, contentType: string, text: string): OpenCodeHealth {
  if (status === 404) return { ok: false, code: "runtime-missing", message: "OpenCode 服务未就绪（/global/health 404）" };
  if (status < 200 || status >= 300) return { ok: false, code: "protocol-mismatch", message: `OpenCode 返回 ${status}` };
  if (!contentType.includes("application/json")) return { ok: false, code: "protocol-mismatch", message: "健康响应不是 JSON" };
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const version = typeof payload.version === "string" ? payload.version : typeof payload.v === "string" ? payload.v : "";
    const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
    if (!Number.isFinite(major)) return { ok: false, code: "protocol-mismatch", message: "健康响应缺少可解析版本" };
    if (major !== OPENCODE_SUPPORTED_MAJOR) {
      return { ok: false, code: "version-unsupported", message: `OpenCode 版本不支持（需要 v${OPENCODE_SUPPORTED_MAJOR}，实际 v${major}）` };
    }
    return { ok: true, version, major };
  } catch {
    return { ok: false, code: "protocol-mismatch", message: "健康响应无法解析" };
  }
}

export type OpenCodeSessionRef = { sessionId: string };

export function createSessionRequest(): { path: string; body: Record<string, unknown> } {
  return { path: "/session", body: {} };
}

export function messageRequest(sessionId: string, prompt: string): { path: string; body: Record<string, unknown> } {
  return {
    path: `/session/${encodeURIComponent(sessionId)}/message`,
    body: { parts: [{ type: "text", text: prompt }] }
  };
}

/**
 * SSE 事件解码：把 `/event` 流映射为宿主事件与终态。
 *
 * 事件窗口不连续（`resyncRequired`）时把回合标记为 `partial`，要求调用方以权威快照复位，
 * 不把不完整事件当作成功终态。
 */
export function createOpenCodeEventDecoder(): {
  onEvent: (event: { event: string; data: string }) => AgentConversationAdapterEvent[];
  markResync: () => void;
  /** `session.idle`（正常终态）时 resolve；用于等待回合结束。 */
  settled: Promise<void>;
  finish: (input?: { cancelled?: boolean; aborted?: boolean }) => AgentAdapterRunOutcome;
  sessionId: () => string | null;
} {
  const parser = createSseParser();
  let assistantText = "";
  let sessionId: string | null = null;
  let streamSequence = 0;
  const streamIds = new Map<string, string>();
  /** 最近一条无 id 的文本 part（用于判断累计快照是否属于同一条消息）。 */
  let anonymous: { streamId: string; text: string } | null = null;
  let failure: { code: string; message: string } | null = null;
  let resyncRequired = false;
  let completed = false;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  /**
   * 文本 part 的逻辑消息身份。
   *
   * - 有 part/message id：同一 id 复用 streamId；
   * - 无 id：若新正文是对上一条匿名正文的前缀扩展（累计快照），沿用同一 streamId；
   *   否则视为下一条消息。缺这一步会把每次累计更新都当成新消息。
   */
  const streamIdOf = (partId: string | undefined, text: string): string => {
    if (partId) {
      const known = streamIds.get(partId);
      if (known) return known;
      const created = `opencode-part-${++streamSequence}`;
      streamIds.set(partId, created);
      return created;
    }
    if (anonymous && (text.startsWith(anonymous.text) || anonymous.text.startsWith(text))) {
      anonymous.text = text;
      return anonymous.streamId;
    }
    anonymous = { streamId: `opencode-part-${++streamSequence}`, text };
    return anonymous.streamId;
  };

  const emitText = (
    emitted: AgentConversationAdapterEvent[],
    text: string,
    delivery: "append" | "replace",
    partId: string | undefined
  ): void => {
    emitted.push({ type: "message", role: "assistant", content: text, delivery, streamId: streamIdOf(partId, text) });
  };

  const onEvent = (rawEvent: { event: string; data: string }): AgentConversationAdapterEvent[] => {
    const emitted: AgentConversationAdapterEvent[] = [];
    for (const frameEvent of coerceSseEvents(rawEvent, parser)) {
      if (frameEvent.data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frameEvent.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof payload.type === "string" ? payload.type : frameEvent.event;
      const properties = (payload.properties ?? payload) as Record<string, unknown>;
      switch (type) {
        case "session.created":
        case "session.updated": {
          const info = (properties.info ?? properties) as Record<string, unknown>;
          if (typeof info.id === "string") sessionId = info.id;
          return emitted;
        }
        case "message.part.updated": {
          const part = (properties.part ?? properties) as Record<string, unknown>;
          if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
            assistantText = part.text;
            // `message.part.updated` 给的是该 part 的**累计**正文：以 replace 收敛同一 part，
            // 用 part/message id 作为逻辑消息身份（一次回复不会按增量各存一条）。
            const partId = typeof part.id === "string" ? part.id : typeof part.messageID === "string" ? part.messageID : undefined;
            emitText(emitted, part.text, "replace", partId);
          } else if (part.type === "tool" && typeof part.tool === "string") {
            const status = typeof part.state === "string" ? part.state : "";
            if (status === "running" || status === "pending") emitted.push({ type: "tool-started", tool: part.tool });
            else if (status === "completed" || status === "error") {
              const detail = status === "error" ? toolResultDetail(part.error ?? part) : undefined;
              emitted.push({ type: "tool-completed", tool: part.tool, ok: status === "completed", ...(detail ? { summary: detail } : {}) });
            }
          }
          return emitted;
        }
        case "session.idle": {
          completed = true;
          settle();
          return emitted;
        }
        case "session.error":
        case "error": {
          const error = (properties.error ?? properties) as Record<string, unknown>;
          failure = { code: typeof error.name === "string" ? error.name : "protocol-mismatch", message: typeof error.message === "string" ? error.message : "OpenCode 返回错误" };
          settle();
          return emitted;
        }
        case "server.heartbeat":
        default:
          return emitted;
      }
    }
    return emitted;
  };

  return {
    onEvent,
    markResync: () => {
      resyncRequired = true;
    },
    settled,
    finish: (input) => {
      if (input?.cancelled || input?.aborted) return { status: "cancelled" };
      if (failure) return { status: "failed", error: failure, ...(sessionId ? { runId: sessionId } : {}) };
      // 事件窗口不连续：不冒充成功终态。
      if (resyncRequired && !completed) {
        return { status: "partial", assistantText, ...(sessionId ? { runId: sessionId } : {}), error: { code: "event-window-lost", message: "OpenCode 事件窗口不连续，请以权威快照复位后重试" } };
      }
      return { status: "succeeded", assistantText, ...(sessionId ? { runId: sessionId } : {}) };
    },
    sessionId: () => sessionId
  };
}

/**
 * MCP 写能力判定。
 *
 * 默认不限制写能力。若显式开启 `enforceLocationMatch`，则核对 location 级 MCP grant。
 */
export function assertOpencodeToolScope(input: {
  requestedTools: readonly string[];
  locationMcpGrantToken?: string | null;
  turnGrantToken?: string | null;
  enforceLocationMatch?: boolean;
}): { ok: true } | { ok: false; code: "capability-unsupported"; message: string } {
  if (input.requestedTools.length === 0) return { ok: true };
  if (input.enforceLocationMatch) {
    if (!input.turnGrantToken) return { ok: false, code: "capability-unsupported", message: "本轮未取得工具授权，拒绝写能力" };
    if (input.locationMcpGrantToken !== input.turnGrantToken) {
      return {
        ok: false,
        code: "capability-unsupported",
        message: "OpenCode v2 的 MCP 配置在 location 级共享，无法为本轮热切换工具授权；请在专用 location 上重启后再执行写操作"
      };
    }
  }
  return { ok: true };
}
