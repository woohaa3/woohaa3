/**
 * Codex App Server stdio 传输实现
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.1/4.2/4.3 / design D5）。
 *
 * 使用专用进程（由 process-manager 提供）的 stdio；请求/通知用 JSONL 帧。流程：
 * `initialize`（版本核对）→ 账号就绪证据 → `thread/start`（或 `thread/resume`）→ `turn/start`，
 * 事件按 `createCodexAppServerDecoder` 映射。工具面用**受控 MCP**（`config.mcp_servers` 指向
 * 回环工具 endpoint，仅在本轮有 grant 时注入）；不解析隐式推理；不接管外部共享 daemon。
 *
 * 当前 App Server 的 `thread/start`/`thread/resume` 返回 `{ thread: { id } }`；`model/list`
 * 返回 `{ data: [{ id, displayName }] }`。线程目录/模型目录都以真实响应为准，不猜测旧路由。
 *
 * stdio 连接由调用方注入（`input.stdio`），测试用本地协议模拟；不启动真实进程。
 */
import { type AgentConversationAdapterEvent, type AgentModelView } from "@woohaa3/contracts";
import {
  request,
  initializeRequest,
  checkInitializeResult,
  accountReadyFromResult,
  createCodexAppServerDecoder,
  parseModelListResult,
  threadIdFromResult
} from "../protocol/codex-appserver.js";
import type { StdioConnection } from "../process-manager.js";
import { connectionCodexHome, inheritedMcpServerNames, inheritedPluginNames } from "../codex-home.js";
import type { LocalAgentTransport, LocalAgentTransportInput, LocalAgentTransportResult } from "./transport.js";

export type CodexAppServerTransportOptions = {
  /** 协议版本（与安装的 App Server 对应；不匹配明确拒绝）。 */
  protocolVersion: string;
  clientVersion: string;
  /** initialize/account/thread 请求超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** 显式 turn 总预算（毫秒）；缺省不限时。 */
  turnTimeoutMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

type InitializeCheck = { ok: true } | { ok: false; code: "protocol-mismatch"; message: string };

/** 同一专用进程只 initialize 一次；之后复用已初始化的连接。 */
const initializedConnections = new WeakMap<StdioConnection, Promise<InitializeCheck>>();
const requestIds = new WeakMap<StdioConnection, number>();

type CodexRpc = {
  call: (method: string, params?: unknown, timeoutMs?: number) => Promise<Record<string, unknown>>;
  dispose: () => void;
};

/**
 * 建立本次请求/通知的 JSON-RPC 客户端。
 *
 * 同一进程的多个调用（如模型目录与回合）各自持有 pending map；响应按 id 只交给所属调用，
 * 通知统一交给调用方。stdin 写入失败由调用方捕获。
 */
function createCodexRpc(
  connection: StdioConnection,
  options: {
    logger: (event: Record<string, unknown>) => void;
    requestTimeoutMs: number;
    onMessage?: (message: Record<string, unknown>) => void;
    onInvalid?: () => void;
  }
): CodexRpc {
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const unsubscribe = connection.onLine((line) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      options.onInvalid?.();
      return;
    }
    if (typeof parsed.id === "number" && pending.has(parsed.id)) {
      const entry = pending.get(parsed.id)!;
      pending.delete(parsed.id);
      if (parsed.error) {
        const error = parsed.error as Record<string, unknown>;
        entry.reject(new Error(typeof error.message === "string" ? error.message : "Codex 请求失败"));
      } else {
        entry.resolve((parsed.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    options.onMessage?.(parsed);
  });
  const unsubscribeStderr =
    connection.onStderr?.((line) => options.logger({ event: "codex-appserver-stderr", length: line.length })) ??
    (() => undefined);

  return {
    call(method, params, timeoutMs = options.requestTimeoutMs) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = (requestIds.get(connection) ?? 0) + 1;
        requestIds.set(connection, id);
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`本地 ChatGPT 在 ${method} 超时`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
        connection.send(JSON.stringify(request(id, method, params)));
      });
    },
    dispose() {
      for (const [, entry] of pending) entry.reject(new Error("aborted"));
      pending.clear();
      unsubscribe();
      unsubscribeStderr();
    }
  };
}

async function ensureInitialized(
  connection: StdioConnection,
  rpc: CodexRpc,
  options: CodexAppServerTransportOptions
): Promise<InitializeCheck> {
  const existing = initializedConnections.get(connection);
  if (existing) return await existing;
  const promise = (async (): Promise<InitializeCheck> => {
    const initialize = initializeRequest(0, {
      clientName: "woohaa3",
      clientVersion: options.clientVersion,
      protocolVersion: options.protocolVersion
    });
    let initialized: Record<string, unknown>;
    try {
      initialized = await rpc.call("initialize", initialize.params, options.requestTimeoutMs ?? 20_000);
    } catch (error) {
      /*
       * 对端说「这条连接已经握过手了」—— 对我们要的结果（连接可用）而言就是成功。
       *
       * 会走到这里是因为 `initializedConnections` 只活在本进程内存里，而专用 Codex 子进程由
       * supervisor 托管、**不随后端一起重启**：后端热重载 / 崩溃重启后，新进程对这条仍然存活的
       * 老连接再发一次 `initialize`，子进程回 JSON-RPC 错误 `Already initialized`。
       *
       * 只豁免这一种：超时、协议错误等其它失败仍然抛出，让用户看到真实原因。
       *
       * 代价：这条路径拿不到 `protocolVersion`，所以**跳过版本核对**。可接受 —— 版本在这条
       * 连接首次握手时已经被核对过，子进程没换就不可能换版本；换了子进程就是一条新连接，
       * 会走正常路径。
       */
      if (error instanceof Error && /already\s+initialized/i.test(error.message)) return { ok: true };
      throw error;
    }
    return checkInitializeResult(initialized, options.protocolVersion);
  })();
  initializedConnections.set(connection, promise);
  void promise.then(
    (result) => {
      if (!result.ok) initializedConnections.delete(connection);
    },
    () => initializedConnections.delete(connection)
  );
  return await promise;
}

/** 受控工具面：当前 App Server 通过 `config.mcp_servers` 注入，而不是顶层 `mcpServers`。 */
function threadConfig(input: LocalAgentTransportInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // 领域工具走受控 MCP；可信桌面目录启用内建 shell，网页搜索与插件应用仍关闭。
    "features.shell_tool": input.workspace === true,
    "features.js_repl": false,
    "features.apps": false,
    "features.skills": false,
    web_search: "disabled"
  };
  config["features.image_generation"] = input.nativeCapabilities?.includes("generate-image") === true;
  const mcpServers: Record<string, unknown> = {};
  // 复用现有 Codex home 时，全局 config.toml 的 MCP server 会与本次 thread config 合并。
  // 显式禁用继承项，避免模型绕过宿主 grant 直接调用用户的其他本机工具。
  for (const name of inheritedMcpServerNames(input.configDir)) {
    if (input.mcpEndpoint?.name === name) continue;
    mcpServers[name] = { enabled: false };
  }
  if (input.mcpEndpoint && input.toolToken) {
    mcpServers[input.mcpEndpoint.name] = {
      url: input.mcpEndpoint.url,
      http_headers: { Authorization: `Bearer ${input.toolToken}` },
      default_tools_approval_mode: "approve",
      ...(input.allowedTools.length > 0 ? { enabled_tools: [...input.allowedTools] } : {})
    };
  }
  if (Object.keys(mcpServers).length > 0) config.mcp_servers = mcpServers;
  const plugins: Record<string, unknown> = {};
  for (const name of inheritedPluginNames(input.configDir)) {
    plugins[name] = { enabled: false };
  }
  if (Object.keys(plugins).length > 0) config.plugins = plugins;
  return config;
}

type McpReadyCheck = { ok: true; toolCount: number } | { ok: false; message: string };

const MCP_FAILED_STATUSES = new Set(["failed", "disabled", "authenticationRequired", "cancelled"]);

function mcpToolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools.flatMap((tool) => {
      if (typeof tool === "string") return [tool];
      if (typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string") {
        return [(tool as { name: string }).name];
      }
      return [];
    });
  }
  if (typeof tools === "object" && tools !== null) return Object.keys(tools);
  return [];
}

function mcpServerName(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.name === "string") return entry.name;
  const info = entry.serverInfo;
  if (typeof info === "object" && info !== null && typeof (info as { name?: unknown }).name === "string") {
    return (info as { name: string }).name;
  }
  return undefined;
}

function mcpRuntimeStatus(entry: Record<string, unknown>): string | undefined {
  for (const key of ["runtimeStatus", "startupState", "status"] as const) {
    const value = entry[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function selectMcpStatus(
  data: unknown[],
  serverName: string,
  requiredTools: readonly string[]
): Record<string, unknown> | undefined {
  const entries = data.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
  const named = entries.find((entry) => mcpServerName(entry) === serverName);
  if (named) return named;
  return entries.find((entry) => requiredTools.every((tool) => mcpToolNames(entry.tools).includes(tool)));
}

/**
 * 核对本轮线程真的拿到了受控 MCP 工具。
 *
 * `thread/start` 的 config 可被接受但连接失败（例如子路径挂载下误用根路径返回 404）；
 * 只看 RPC 成功会让模型在没有工具的情况下回复“请上传模型”。这里用 `mcpServerStatus/list`
 * 读取该线程的连接状态与工具目录，缺失/失败时拒绝发送 turn。
 *
 * 就绪信号以工具目录为准：当前 Codex（0.145+）在工具已齐时仍可能报告
 * `runtimeStatus: "unknown"`，或把配置名放在 `serverInfo.name` 而不是顶层 `name`。
 * `connected`/`ready` 只是历史别名；硬失败状态仍立即拒绝。
 */
async function waitForMcpTools(
  rpc: CodexRpc,
  input: { threadId: string; serverName: string; requiredTools: readonly string[]; timeoutMs: number }
): Promise<McpReadyCheck> {
  const started = Date.now();
  let last = "MCP 工具面尚未就绪";
  while (Date.now() - started <= input.timeoutMs) {
    let result: Record<string, unknown>;
    try {
      result = await rpc.call(
        "mcpServerStatus/list",
        { threadId: input.threadId, serverName: input.serverName, detail: "toolsAndAuthOnly" },
        10_000
      );
    } catch (error) {
      return { ok: false, message: `无法核对 MCP 工具面：${error instanceof Error ? error.message : "协议调用失败"}` };
    }
    const data = Array.isArray(result.data) ? result.data : [];
    const status = selectMcpStatus(data, input.serverName, input.requiredTools);
    if (!status) {
      last = `MCP server "${input.serverName}" 未出现在线程工具状态中`;
    } else {
      const tools = mcpToolNames(status.tools);
      const missing = input.requiredTools.filter((tool) => !tools.includes(tool));
      const runtime = mcpRuntimeStatus(status);
      if (runtime && MCP_FAILED_STATUSES.has(runtime)) {
        const reason = typeof status.toolsError === "string" && status.toolsError !== "" ? status.toolsError : `MCP 状态 ${runtime}`;
        return { ok: false, message: `受控 MCP 工具面不可用：${reason}` };
      }
      if (missing.length === 0) {
        return { ok: true, toolCount: tools.length };
      }
      last = `受控 MCP 缺少工具：${missing.join(", ")}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, message: `受控 MCP 工具面未就绪：${last}` };
}

export function createCodexAppServerTransport(options: CodexAppServerTransportOptions): LocalAgentTransport {
  const log = options.logger ?? (() => undefined);
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const turnTimeoutMs = options.turnTimeoutMs ?? 0;

  return {
    id: "codex-appserver",
    probe: async () => ({ ok: true }),
    async check(input) {
      const unknown = { state: "unknown" as const };
      const failed = (reason: string) => ({ transport: { state: "unavailable" as const, reason }, credential: unknown, modelAccess: unknown, tools: unknown });
      if (!input.stdio) return failed("专用进程未提供 stdio");
      const rpc = createCodexRpc(input.stdio, { logger: log, requestTimeoutMs });
      try {
        const version = await ensureInitialized(input.stdio, rpc, options);
        if (!version.ok) return failed(version.message);
        const account = accountReadyFromResult(await rpc.call("account/read", {}, 15_000));
        return { transport: { state: "ready" as const }, credential: { state: account.ready ? "ready" as const : "unavailable" as const, ...(account.reason ? { reason: account.reason } : {}) }, modelAccess: unknown, tools: unknown };
      } catch { return failed("专用连接检查失败，请核对宿主工具和登录状态"); }
      finally { rpc.dispose(); }
    },
    async models(input): Promise<{ models: AgentModelView[]; error?: string }> {
      if (!input.stdio) return { models: [], error: "本地 ChatGPT 专用进程未提供 stdio" };
      const rpc = createCodexRpc(input.stdio, { logger: log, requestTimeoutMs });
      try {
        const versionCheck = await ensureInitialized(input.stdio, rpc, options);
        if (!versionCheck.ok) return { models: [], error: versionCheck.message };
        const models = new Map<string, AgentModelView>();
        let cursor: string | undefined;
        // 有界分页；`nextCursor` 为空即结束。重复 cursor 视为目录异常，避免死循环。
        for (let page = 0; page < 10; page += 1) {
          const result = await rpc.call("model/list", cursor ? { cursor } : {}, requestTimeoutMs);
          const parsed = parseModelListResult(result);
          for (const model of parsed.models) models.set(model.id, model);
          if (!parsed.nextCursor || parsed.nextCursor === cursor) break;
          cursor = parsed.nextCursor;
        }
        return {
          models: [...models.values()],
          ...(models.size === 0 ? { error: "本地 ChatGPT 未返回模型目录，可手动填写模型 ID" } : {})
        };
      } catch (error) {
        return { models: [], error: error instanceof Error ? error.message : "Codex 模型目录读取失败" };
      } finally {
        rpc.dispose();
      }
    },
    async run(input: LocalAgentTransportInput): Promise<LocalAgentTransportResult> {
      const connection = input.stdio;
      if (!connection) return { ok: false, code: "runtime-missing", message: "本地 ChatGPT 专用进程未提供 stdio" };

      const decoder = createCodexAppServerDecoder();
      let nativeThread: string | null = null;
      let nativeTurn: string | null = null;
      let startingTurn = false;
      let interrupted = false;
      // 内建 image_gen 的产物路径（按到达顺序）。只收 savedPath，不收 result 的 base64：
      // 三张图实测合计约 8.4 MB，转发会拖垮 JSONL 流式解析。
      const generatedImagePaths: string[] = [];
      const emit = (event: AgentConversationAdapterEvent) => input.onEvent(event);
      const rpc = createCodexRpc(connection, {
        logger: log,
        requestTimeoutMs,
        onMessage: (message) => {
          // Notifications are broadcast on this process. Only this run's thread/turn owns them.
          const params = (message.params ?? {}) as Record<string, unknown>;
          const thread = params.thread as Record<string, unknown> | undefined;
          const turn = params.turn as Record<string, unknown> | undefined;
          const threadId = params.threadId ?? thread?.id;
          const turnId = params.turnId ?? turn?.id;
          if (!nativeThread || threadId !== nativeThread) return;
          if (nativeTurn && typeof turnId === "string" && turnId !== nativeTurn) return;
          if (startingTurn && message.method === "turn/started" && typeof turnId === "string") nativeTurn = turnId;
          // 内建生图产物：只记录 savedPath，经产物回调写入 daemon journal，不进入模型可见消息（change: 2026-11-03-add-codex-image-import）。
          if (message.method === "item/completed") {
            const item = params.item as Record<string, unknown> | undefined;
            if (item?.type === "imageGeneration") {
              const savedPath = typeof item.savedPath === "string" ? item.savedPath.trim() : "";
              if (savedPath.length > 0) {
                generatedImagePaths.push(savedPath);
                input.onGeneratedImage?.({ savedPath, codexHome: connectionCodexHome(input.configDir) });
              }
              else log({ event: "codex-image-saved-path-missing", generationId: item.id ?? null });
              return;
            }
          }
          for (const event of decoder.onMessage(message)) emit(event);
        },
        onInvalid: () => decoder.onError("protocol-mismatch", "本地 ChatGPT 输出非 JSON 帧")
      });
      const interrupt = () => {
        if (!nativeThread || !nativeTurn || interrupted) return;
        interrupted = true;
        void rpc.call("turn/interrupt", { threadId: nativeThread, turnId: nativeTurn }, 5000).catch(() => undefined);
      };
      const onAbort = () => {
        interrupt();
        // Keep turn/start alive until its receipt arrives, so a late acceptance can be interrupted.
        if (!startingTurn || nativeTurn) rpc.dispose();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (input.signal.aborted) throw new Error("aborted");
        const versionCheck = await ensureInitialized(connection, rpc, options);
        if (!versionCheck.ok) return { ok: false, code: versionCheck.code, message: versionCheck.message };

        const account = await rpc.call("account/read", {}, 15_000).catch(() => ({} as Record<string, unknown>));
        const accountState = accountReadyFromResult(account);
        input.onEvidence?.({
          transport: "ready",
          credential: accountState.ready ? "ready" : "unavailable",
          ...(accountState.reason ? { reason: accountState.reason } : {})
        });
        if (!accountState.ready) {
          return {
            ok: false,
            code: "credential-unavailable",
            message: accountState.reason ?? "本机 Codex 尚未登录（请在后端机器的 Codex 中完成登录或配置 model provider）"
          };
        }

        const model = input.model.trim();
        const threadParams: Record<string, unknown> = {
          ...(model === "" ? {} : { model }),
          // 可信桌面 cwd 使用原生 workspace-write；其他回合保持只读，无审批。
          cwd: input.workDir,
          approvalPolicy: "never",
          sandbox: input.workspace ? "workspace-write" : "read-only",
          config: threadConfig(input)
        };
        // MCP grant 轮换：活跃订阅下 resume 不更新授权头（实测），因此更换 grant 前先
        // `thread/unsubscribe` 结束旧订阅，再以新 grant resume 同一 thread（保留历史）。
        // 无活跃订阅时 unsubscribe 可能报错，按幂等忽略。
        if (input.resumeNativeId) {
          await rpc.call("thread/unsubscribe", { threadId: input.resumeNativeId }, 10_000).catch(() => ({} as Record<string, unknown>));
        }
        let thread: Record<string, unknown>;
        let resumedNativeId = input.resumeNativeId;
        if (input.resumeNativeId) {
          try {
            thread = await rpc.call("thread/resume", { threadId: input.resumeNativeId, ...threadParams });
          } catch (error) {
            // 目标回合必须拿到工具面：旧线程无法恢复时建立新线程是安全的（新 thread 使用同一冻结
            // 连接与当前 grant），而不是在没有工具的情况下继续发送 prompt。
            if (!input.mcpEndpoint) throw error;
            log({ event: "codex-thread-resume-failed-new-thread", message: error instanceof Error ? error.message : String(error) });
            resumedNativeId = null;
            thread = await rpc.call("thread/start", threadParams);
          }
        } else {
          thread = await rpc.call("thread/start", threadParams);
        }
        let threadId = threadIdFromResult(thread, resumedNativeId ?? decoder.threadId());
        if (!threadId) {
          return { ok: false, code: "protocol-mismatch", message: "本地 ChatGPT 未返回 threadId，已拒绝发送回合" };
        }
        nativeThread = threadId;
        if (input.mcpEndpoint && input.toolToken) {
          let ready = await waitForMcpTools(rpc, {
            threadId,
            serverName: input.mcpEndpoint.name,
            requiredTools: input.allowedTools,
            timeoutMs: 8_000
          });
          // resume 在部分版本不会重新装载 MCP；若工具核对失败，改用新线程重新注入。
          if (!ready.ok && input.resumeNativeId) {
            log({ event: "codex-mcp-not-ready-new-thread", reason: ready.message });
            const fresh = await rpc.call("thread/start", threadParams);
            const freshId = threadIdFromResult(fresh, null);
            if (!freshId) {
              return { ok: false, code: "protocol-mismatch", message: "本地 ChatGPT 未返回新 threadId，已拒绝发送回合" };
            }
            threadId = freshId;
            nativeThread = threadId;
            ready = await waitForMcpTools(rpc, {
              threadId,
              serverName: input.mcpEndpoint.name,
              requiredTools: input.allowedTools,
              timeoutMs: 8_000
            });
          }
          if (!ready.ok) {
            return { ok: false, code: "tools-unavailable", message: ready.message, nativeId: threadId };
          }
        }

        const timeout = turnTimeoutMs > 0 ? setTimeout(() => decoder.onError("transport-unavailable", "Codex turn 超时"), turnTimeoutMs) : undefined;
        try {
          if (input.signal.aborted) throw new Error("aborted");
          startingTurn = true;
          const receipt = await rpc.call("turn/start", { threadId, summary: "concise", input: [{ type: "text", text: input.prompt }, ...(input.images ?? []).map(image => ({ type: "image", url: `data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}` }))], ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}), ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}) });
          startingTurn = false;
          const turn = receipt.turn as Record<string, unknown> | undefined;
          if (typeof turn?.id === "string") nativeTurn = turn.id;
          if (input.signal.aborted) interrupt();
          // 等待终态通知（turn/completed|turn/failed|error）或取消。
          await Promise.race([decoder.settled, abortPromise(input.signal)]);
        } finally {
          clearTimeout(timeout);
        }

        const outcome = decoder.finish({ cancelled: input.signal.aborted });
        if (outcome.status === "failed") {
          return { ok: false, code: outcome.error?.code ?? "protocol-mismatch", message: outcome.error?.message ?? "Codex 运行失败", nativeId: threadId };
        }
        if (outcome.status === "cancelled") return { ok: false, code: "cancelled", message: "回合已取消", nativeId: threadId };
        return { ok: true, outcome, nativeId: threadId, generatedImagePaths: [...generatedImagePaths] };
      } catch (error) {
        return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: error instanceof Error ? error.message : "本地 ChatGPT 运行失败" };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        rpc.dispose();
      }
    }
  };
}

/** 取消时 resolve 的 promise，用于与终态 Promise 竞速。 */
function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
