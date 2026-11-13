/**
 * Codex App Server stdio JSON-RPC 协议编解码
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.1/4.2/4.3 / design D2/D5）。
 *
 * Codex App Server 以 stdio 上的 JSON-RPC 交换：`initialize` → 账号/目录 → `thread/start` 或
 * `thread/resume` → `turn/start`，并以通知流回传 item/turn 事件。本模块只实现**公开协议**：
 * - 帧格式：每行一条 JSON（JSONL）；请求带 `id`，通知不带；
 * - 事件映射为宿主事件（阶段、助手文本、工具开始/完成、终态）；
 * - **不**解析或保存隐式推理；
 * - 版本/能力不匹配明确拒绝（不猜测旧版路由）。
 *
 * 真实进程与账号登录未在本环境采集，标注「待人工验证」。
 */
import { isAgentReasoningEffort, type AgentModelView, type AgentConversationAdapterEvent, type AgentAdapterRunOutcome } from "@woohaa3/contracts";
import { toolResultDetail } from "./tool-detail.js";

export type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };

export function request(id: number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

/** JSONL 帧解析：逐行解析；忽略空行；非 JSON 行作为协议错误。 */
export function createJsonRpcLineParser(): {
  push: (chunk: string) => Array<{ message: Record<string, unknown> } | { error: string }>;
  flush: () => Array<{ message: Record<string, unknown> } | { error: string }>;
} {
  let buffer = "";
  const parseLine = (line: string): { message: Record<string, unknown> } | { error: string } | null => {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) return { message: parsed as Record<string, unknown> };
      return { error: "JSON-RPC 帧不是对象" };
    } catch {
      return { error: "JSON-RPC 帧不是合法 JSON" };
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      const out: Array<{ message: Record<string, unknown> } | { error: string }> = [];
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const parsed = parseLine(line);
        if (parsed) out.push(parsed);
        index = buffer.indexOf("\n");
      }
      return out;
    },
    flush() {
      const remaining = buffer;
      buffer = "";
      const parsed = parseLine(remaining);
      return parsed ? [parsed] : [];
    }
  };
}

/** initialize 请求（协议版本 + 客户端身份 + 能力）。 */
export function initializeRequest(id: number, input: { clientName: string; clientVersion: string; protocolVersion: string }): JsonRpcRequest {
  return request(id, "initialize", {
    clientInfo: { name: input.clientName, version: input.clientVersion },
    protocolVersion: input.protocolVersion,
    // `mcpServerStatus/list` 属于实验 API；传输层用它核对本轮受控 MCP 真的暴露了工具，
    // 避免 thread config 404/失效时让模型在没有工具的情况下空答。
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
}

/** initialize 结果校验：版本不匹配时明确拒绝（不猜测路由）。 */
export function checkInitializeResult(result: Record<string, unknown>, expectedProtocolVersion: string): { ok: true } | { ok: false; code: "protocol-mismatch"; message: string } {
  const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
  if (version !== "" && version !== expectedProtocolVersion) {
    return { ok: false, code: "protocol-mismatch", message: `本地 ChatGPT 协议版本不匹配（期望 ${expectedProtocolVersion}，实际 ${version}）` };
  }
  return { ok: true };
}

export type CodexThreadRef = { threadId: string };
export type CodexTurnRef = { turnId: string };

/**
 * 账号就绪证据：未登录不得标 ready。
 *
 * `account/read` 的当前公开返回是 `{ account: Account | null }`，其中登录态由
 * `Account.type`（`chatgpt`/`apiKey`/`amazonBedrock`）表示，而不是旧版的 `status`。
 * 同时兼容旧版 `status/loggedIn` 形状，避免把已登录账号误报为未登录。
 */
export function accountReadyFromResult(result: Record<string, unknown>): { ready: boolean; reason?: string } {
  // 自定义 model provider（如 Bearer token gateway）不要求 OpenAI 登录：当前 App Server 返回
  // `{ account: null, requiresOpenaiAuth: false }`。这不是“未登录”，不能据此阻止回合；
  // 真正的 provider 配置/凭据错误由 thread/turn 返回。只有 `requiresOpenaiAuth: true` 才表示
  // 需要官方账号。
  if (
    (result.account === null || result.account === undefined) &&
    result.requiresOpenaiAuth === false
  ) {
    return { ready: true };
  }
  const rawAccount = result.account ?? result.auth;
  const account = typeof rawAccount === "object" && rawAccount !== null ? (rawAccount as Record<string, unknown>) : {};
  const accountType = typeof account.type === "string" ? account.type : "";
  if (accountType === "chatgpt" || accountType === "apiKey" || accountType === "amazonBedrock") {
    return { ready: true };
  }
  const state = typeof account.status === "string" ? account.status : typeof result.status === "string" ? result.status : "";
  if (state === "ready" || state === "logged-in" || state === "authenticated" || account.loggedIn === true) {
    return { ready: true };
  }
  return {
    ready: false,
    reason:
      typeof account.message === "string"
        ? account.message
        : result.requiresOpenaiAuth === true
          ? "本机 Codex 尚未登录（请在后端机器的 Codex 中完成登录或配置 model provider）"
          : "本机 Codex 账号状态不可用"
  };
}

/**
 * `thread/start` / `thread/resume` 的线程 id 提取。
 *
 * 当前公开响应是 `{ thread: { id } }`；旧协议/测试桩可能返回顶层 `threadId` 或 `id`。
 * 未取得 id 时返回 null，调用方 MUST 在发送 `turn/start` 前明确失败。
 */
export function threadIdFromResult(result: Record<string, unknown>, fallback?: string | null): string | null {
  const thread = result.thread;
  if (typeof thread === "object" && thread !== null) {
    const record = thread as Record<string, unknown>;
    if (typeof record.id === "string" && record.id !== "") return record.id;
    if (typeof record.threadId === "string" && record.threadId !== "") return record.threadId;
  }
  if (typeof result.threadId === "string" && result.threadId !== "") return result.threadId;
  if (typeof result.id === "string" && result.id !== "") return result.id;
  return typeof fallback === "string" && fallback !== "" ? fallback : null;
}

/**
 * `model/list` 结果投影（不把目录项当作账号已授权证据）。
 *
 * 目录项可能同时带稳定 `id` 与 `model` slug；优先 `id`。`displayName` 只用于展示。
 * `nextCursor` 由调用方继续分页，避免只取第一页。
 */
export function parseModelListResult(result: Record<string, unknown>): {
  models: AgentModelView[];
  nextCursor?: string;
} {
  const data = Array.isArray(result.data) ? result.data : [];
  const models: AgentModelView[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (item.hidden === true) continue;
    const id =
      typeof item.id === "string" && item.id !== ""
        ? item.id
        : typeof item.model === "string" && item.model !== ""
          ? item.model
          : "";
    if (id === "") continue;
    const label = typeof item.displayName === "string" && item.displayName !== "" ? item.displayName : id;
    const reasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.map(raw => typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).reasoningEffort : raw).filter(isAgentReasoningEffort)
      : [];
    models.push({ id, label, ...(reasoningEfforts.length ? { reasoningEfforts } : {}) });
  }
  return {
    models,
    ...(typeof result.nextCursor === "string" && result.nextCursor !== "" ? { nextCursor: result.nextCursor } : {})
  };
}

/**
 * MCP grant 轮换时的 resume 计划
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.2 / design D5）。
 *
 * 实测：活跃订阅下 `thread/resume` **不会**更新授权头，旧 grant 撤销后调用变 403。因此更换
 * MCP grant 时 MUST 先 `thread/unsubscribe` 结束旧订阅，再以**新 grant** `thread/resume`（同一
 * threadId，保留历史）。本函数只产出**确定的调用序列**，由传输层按顺序执行；无 grant 变化时
 * 不额外 unsubscribe（避免丢失流）。
 */
export type CodexResumePlanStep = { method: "thread/unsubscribe" | "thread/resume"; params: Record<string, unknown> };

export function planThreadResume(input: {
  threadId: string;
  /** 当前已订阅的 grant；无订阅传 null。 */
  activeGrant: string | null;
  /** 本轮要使用的 grant；无工具面传 null。 */
  nextGrant: string | null;
  baseParams?: Record<string, unknown>;
}): { steps: CodexResumePlanStep[] } {
  const steps: CodexResumePlanStep[] = [];
  const grantChanged = input.activeGrant !== input.nextGrant;
  if (input.activeGrant !== null && grantChanged) {
    steps.push({ method: "thread/unsubscribe", params: { threadId: input.threadId } });
  }
  steps.push({ method: "thread/resume", params: { threadId: input.threadId, ...(input.baseParams ?? {}) } });
  return { steps };
}

/**
 * 有状态事件解码：把 App Server 通知映射为宿主事件与终态。
 *
 * MCP 工具调用只有在受控工具面下才投影；非法/未知事件被忽略（不影响终态结算）。
 */
export function createCodexAppServerDecoder(): {
  onMessage: (message: Record<string, unknown>) => AgentConversationAdapterEvent[];
  onError: (code: string, message: string) => void;
  /** 终态发生时 resolve；willRetry=true 的 error 通知仍属于在途回合。 */
  settled: Promise<void>;
  finish: (input?: { cancelled?: boolean }) => AgentAdapterRunOutcome;
  threadId: () => string | null;
} {
  let assistantText = "";
  let threadId: string | null = null;
  let failure: { code: string; message: string } | null = null;
  let cancelled = false;
  let toolCount = 0;
  let activityStage: string | null = null;
  let lastActivityAt = 0;
  let summaryItemId: string | null = null;
  const summaryParts = new Map<number, string>();
  let lastSummaryAt = 0;
  let publishedSummary = "";
  const startedTools = new Set<string>();
  // 当前助手消息的逻辑身份：增量与随后的完整 item 必须共用，否则同一条回复会分成两条。
  let messageKey: string | null = null;
  let messageSequence = 0;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const isToolItem = (type: string): boolean =>
    type === "mcp_tool_call" || type === "tool_call" || type === "mcpToolCall" || type === "toolCall";

  /** 消息身份：同一助手消息的增量与完成项共用一个 key；无在途 key 时优先采用原生 item id。 */
  const messageIdentityOf = (item: Record<string, unknown> | null): string => {
    if (messageKey === null) {
      const id = item && typeof item.id === "string" && item.id !== "" ? item.id : null;
      messageKey = id ?? `codex-message-${++messageSequence}`;
    }
    return messageKey;
  };

  const toolStart = (item: Record<string, unknown>): AgentConversationAdapterEvent => {
    const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "tool";
    const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
    return { type: "tool-started", tool, ...(callId ? { callId } : {}) };
  };

  const toolKey = (item: Record<string, unknown>): string => {
    const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : "";
    const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "tool";
    return callId !== "" ? callId : tool;
  };

  const onMessage = (message: Record<string, unknown>): AgentConversationAdapterEvent[] => {
    const method = typeof message.method === "string" ? message.method : "";
    const params = (message.params ?? {}) as Record<string, unknown>;
    const events: AgentConversationAdapterEvent[] = [];
    const activity = (stage: string, heartbeat = false) => {
      if (activityStage === stage && (!heartbeat || Date.now() - lastActivityAt < 10_000)) return;
      activityStage = stage;
      lastActivityAt = Date.now();
      events.push({ type: "stage", stage });
    };
    const publishSummary = (force = false) => {
      const summary = [...summaryParts].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n");
      if (!summary || summary === publishedSummary || (!force && publishedSummary && Date.now() - lastSummaryAt < 1000)) return;
      activityStage = "reasoning";
      lastActivityAt = lastSummaryAt = Date.now();
      publishedSummary = summary;
      events.push({ type: "stage", stage: "reasoning", summary });
    };
    switch (method) {
      case "thread/started":
      case "thread/resumed": {
        const thread = (params.thread ?? params) as Record<string, unknown>;
        if (typeof thread.id === "string") threadId = thread.id;
        events.push({ type: "stage", stage: method === "thread/resumed" ? "resumed" : "thread-started" });
        return events;
      }
      case "turn/started":
        activity("running");
        return events;
      case "item/started": {
        const item = (params.item ?? params) as Record<string, unknown>;
        const type = typeof item.type === "string" ? item.type : "";
        // 只投影原生活动类型，不读取、保存或展示内部推理正文。
        if (type === "reasoning") activity("reasoning", true);
        if (isToolItem(type)) {
          const key = toolKey(item);
          if (!startedTools.has(key)) {
            startedTools.add(key);
            toolCount += 1;
            events.push(toolStart(item));
          }
        }
        return events;
      }
      case "item/reasoning/summaryTextDelta": {
        if (typeof params.delta !== "string" || !params.delta) return events;
        const itemId = typeof params.itemId === "string" ? params.itemId : "current";
        if (summaryItemId !== itemId) {
          publishSummary(true);
          summaryItemId = itemId;
          summaryParts.clear();
          publishedSummary = "";
        }
        const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        summaryParts.set(index, (summaryParts.get(index) ?? "") + params.delta);
        publishSummary();
        return events;
      }
      case "item/reasoning/summaryPartAdded":
        publishSummary(true);
        return events;
      case "item/reasoning/textDelta":
        // 原始推理只用于确认有新活动，绝不读取或保存 delta。
        activity("reasoning", true);
        return events;
      case "item/agentMessage/delta": {
        const text = typeof params.delta === "string" ? params.delta : "";
        if (text !== "") {
          activity("responding");
          assistantText += text;
          // 已打开的增量消息沿用同一身份；否则用原生 item id 或新 key。
          events.push({ type: "message", role: "assistant", content: text, delivery: "append", streamId: messageIdentityOf(null) });
        }
        return events;
      }
      case "item/completed": {
        const item = (params.item ?? params) as Record<string, unknown>;
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "agent_message" || type === "assistant_message" || type === "agentMessage" || type === "assistantMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          if (text !== "") {
            activity("responding");
            assistantText = text;
            // 完成项带完整正文：以 replace 收敛**同一条**消息（与增量共用身份），不额外追加。
            events.push({ type: "message", role: "assistant", content: text, delivery: "replace", streamId: messageIdentityOf(item) });
          }
          // 下一条助手消息另开身份。
          messageKey = null;
        } else if (type === "reasoning") {
          // 完成项的公开 summary 用于补齐重连期间漏掉的摘要分片；不读取 content/text。
          if (Array.isArray(item.summary) && item.summary.length && item.summary.every(part => typeof part === "string")) {
            const itemId = typeof item.id === "string" ? item.id : "current";
            if (summaryItemId !== itemId) publishedSummary = "";
            summaryItemId = itemId;
            summaryParts.clear();
            item.summary.forEach((part, index) => summaryParts.set(index, part));
          }
          publishSummary(true);
          activity("reasoning", true);
        } else if (isToolItem(type)) {
          const key = toolKey(item);
          if (!startedTools.has(key)) {
            // 兼容只发 completed 的版本：至少记录工具与预算，但不伪造成功终态。
            startedTools.add(key);
            toolCount += 1;
            events.push(toolStart(item));
          } else {
            const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "tool";
            const callId = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
            const result = (item.result ?? {}) as Record<string, unknown>;
            const ok = item.status !== "failed" && item.status !== "error" && result.isError !== true;
            // 失败时带真实原因（结构化 code/message 或工具输出文本），不写成无信息量的“失败”。
            events.push({ type: "tool-completed", tool, ok, summary: ok ? "完成" : toolResultDetail(result) ?? "失败", ...(callId ? { callId } : {}) });
          }
        } else if (type === "custom_tool_call" || type === "customToolCall") {
          // 当前 Codex 在 code-mode 下把 MCP 工具包在 `exec` 脚本里调用，例如
          // `tools.mcp__woohaa__get_model_node(...)`。只投影其中的受控 MCP 调用，
          // 不把 `exec` 包装器本身当成工具事件（否则会误报未授权）。
          const input = typeof item.input === "string" ? item.input : "";
          const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
          for (const match of input.matchAll(/tools\.mcp__[A-Za-z0-9_]+__([a-z0-9_]+)\s*\(/g)) {
            const tool = match[1];
            if (!tool) continue;
            toolCount += 1;
            events.push({ type: "tool-started", tool, ...(callId ? { callId } : {}) });
          }
        }
        return events;
      }
      case "turn/completed": {
        publishSummary(true);
        // 当前协议以 turn/completed 携带所有终态，包括失败与中断。
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        if (turn.status === "failed") {
          const error = (turn.error ?? {}) as Record<string, unknown>;
          failure = {
            code: typeof error.code === "string" ? error.code : typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : "transport-unavailable",
            message: typeof error.message === "string" ? error.message : "Codex turn 失败"
          };
        } else if (turn.status === "interrupted") {
          cancelled = true;
        } else {
          events.push({ type: "stage", stage: "completed" });
        }
        settle();
        return events;
      }
      case "turn/failed": {
        const error = (params.error ?? {}) as Record<string, unknown>;
        failure = { code: typeof error.code === "string" ? error.code : "protocol-mismatch", message: typeof error.message === "string" ? error.message : "Codex turn 失败" };
        settle();
        return events;
      }
      case "error": {
        const error = (params.error ?? params) as Record<string, unknown>;
        if (params.willRetry === true) {
          events.push({ type: "stage", stage: "running", ...(typeof error.message === "string" ? { detail: error.message } : {}) });
          return events;
        }
        failure = { code: typeof error.code === "string" ? error.code : "protocol-mismatch", message: typeof error.message === "string" ? error.message : "Codex 返回错误" };
        settle();
        return events;
      }
      default:
        return events;
    }
  };

  return {
    onMessage,
    onError: (code, message) => {
      failure = { code, message };
      settle();
    },
    settled,
    finish: (input) => {
      if (input?.cancelled) cancelled = true;
      if (cancelled) return { status: "cancelled" };
      if (failure) return { status: "failed", error: failure, ...(threadId ? { runId: threadId } : {}) };
      return { status: "succeeded", assistantText, ...(threadId ? { runId: threadId } : {}), receipt: { toolCount } };
    },
    threadId: () => threadId
  };
}
