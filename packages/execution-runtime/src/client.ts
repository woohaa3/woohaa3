/**
 * 执行运行时客户端（宿主 / CLI 共用）。
 *
 * 每次 RPC 一条短连接；事件跟随由上层用 cursor 轮询，断线不会丢 cursor。
 */
import net from "node:net";
import type {
  Executor,
  ExecutorClientOptions,
  ExecutorRequest,
  HealthInfo,
  ProcessEnsureInput,
  ProcessHandleInfo,
  ProcessRunRecord,
  RuntimeEvent,
  TurnRunInput,
  TurnView
} from "./protocol.js";
import { errorMessage } from "./protocol.js";

export type ExecutorClient = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  health(): Promise<HealthInfo>;
  ping(): Promise<{ workspaceKey: string; pid: number; generation: number; count: number }>;
  ensure(input: ProcessEnsureInput): Promise<ProcessHandleInfo>;
  stop(input: string | { adapterId: string; owner: string; connectionId: string }): Promise<void>;
  stopAll(): Promise<{ stopped: true }>;
  listProcesses(): Promise<{ processes: ProcessHandleInfo[] }>;
  queryProcess(input: { requestId?: string; adapterId?: string; owner?: string; connectionId?: string } | string): Promise<ProcessRunRecord | null>;
  processEvents(input: { key?: string; adapterId?: string; owner?: string; connectionId?: string } | string, after?: number): Promise<{ key: string; events: Array<{ cursor: number; data: string }>; cursor: number }>;
  runTurn(input: TurnRunInput): Promise<TurnView>;
  queryTurn(turnId: string): Promise<TurnView | null>;
  listTurns(): Promise<{ turns: TurnView[] }>;
  turnEvents(turnId: string, since?: number): Promise<{ events: RuntimeEvent[]; cursor: number }>;
  cancelTurn(turnId: string): Promise<TurnView | null>;
  shutdown(): Promise<{ shuttingDown: true }>;
};

class SocketClient implements ExecutorClient {
  constructor(private readonly options: ExecutorClientOptions) {}

  private request(request: Omit<ExecutorRequest, "id" | "token" | "workspaceKey">): Promise<unknown> {
    if (this.options.request) {
      return this.options.request({
        id: 1,
        token: this.options.token,
        workspaceKey: this.options.workspaceKey,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {})
      });
    }
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Executor 请求超时（${request.method}）`));
      }, timeoutMs);
      const finish = (error: unknown, value?: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(value);
      };
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
            if (response.ok) finish(null, response.result);
            else finish(new Error(response.error ?? "Executor 请求失败"));
            return;
          } catch {
            // 等待完整 JSON 行
          }
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => {
        socket.write(JSON.stringify({
          id: 1,
          token: this.options.token,
          workspaceKey: this.options.workspaceKey,
          method: request.method,
          ...(request.params !== undefined ? { params: request.params } : {})
        }) + "\n");
      });
    });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.request({ method, ...(params !== undefined ? { params } : {}) }) as Promise<T>;
  }

  health() { return this.call<HealthInfo>("health"); }
  ping() { return this.call<{ workspaceKey: string; pid: number; generation: number; count: number }>("ping"); }
  ensure(input: ProcessEnsureInput) { return this.call<ProcessHandleInfo>("proc.ensure", input); }
  stop(input: string | { adapterId: string; owner: string; connectionId: string }) { return this.call<void>("proc.stop", input); }
  stopAll() { return this.call<{ stopped: true }>("proc.stopAll"); }
  listProcesses() { return this.call<{ processes: ProcessHandleInfo[] }>("proc.list"); }
  queryProcess(input: { requestId?: string; adapterId?: string; owner?: string; connectionId?: string } | string) {
    return this.call<ProcessRunRecord | null>("proc.query", input);
  }
  processEvents(input: { key?: string; adapterId?: string; owner?: string; connectionId?: string } | string, after = 0) {
    return this.call<{ key: string; events: Array<{ cursor: number; data: string }>; cursor: number }>("proc.events", { ...(typeof input === "string" ? { key: input } : input), after });
  }
  runTurn(input: TurnRunInput) { return this.call<TurnView>("turn.run", input); }
  queryTurn(turnId: string) { return this.call<TurnView | null>("turn.query", { turnId }); }
  listTurns() { return this.call<{ turns: TurnView[] }>("turn.list"); }
  turnEvents(turnId: string, since = 0) { return this.call<{ events: RuntimeEvent[]; cursor: number }>("turn.events", { turnId, since }); }
  cancelTurn(turnId: string) { return this.call<TurnView | null>("turn.cancel", { turnId }); }
  shutdown() { return this.call<{ shuttingDown: true }>("shutdown"); }
}

export function createExecutorClient(options: ExecutorClientOptions): ExecutorClient {
  return new SocketClient(options);
}

/** 跟随回合事件直到终态；返回终态视图。 */
export async function followTurn(
  client: ExecutorClient,
  turnId: string,
  input: { since?: number; intervalMs?: number; onEvent?: (event: RuntimeEvent) => void; signal?: AbortSignal } = {}
): Promise<TurnView | null> {
  let cursor = input.since ?? 0;
  const interval = input.intervalMs ?? 500;
  for (;;) {
    if (input.signal?.aborted) return client.queryTurn(turnId);
    const page = await client.turnEvents(turnId, cursor);
    for (const event of page.events) {
      cursor = event.cursor;
      input.onEvent?.(event);
    }
    const view = await client.queryTurn(turnId);
    if (!view || (view.status !== "queued" && view.status !== "running")) return view;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** 供 CLI / 诊断：把执行器导出为稳定的可注入形状。 */
export type { Executor };
export { errorMessage };
