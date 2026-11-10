/**
 * 独立执行运行时 daemon。
 *
 * 同时承担两类职责：
 * 1. `proc.*`：本机 CLI 子进程监管（替代 dev 期间的 Agent Supervisor）；
 * 2. `turn.*`：按 prepared turn / 结构化任务执行，写事件 journal 与终态。
 *
 * 只监听本机 Unix socket / Windows 命名管道，请求必须带 workspace token；不暴露 HTTP。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { executorEndpoint } from "./endpoints.js";
import { ProcessHost } from "./processes.js";
import { createExecutorClient } from "./client.js";
import { ExecutorModules, type ExecutorModuleRegistration } from "./modules.js";
import { TurnStore } from "./turns.js";
import type {
  Executor,
  ExecutorRequest,
  HealthInfo,
  ProcessEnsureInput,
  TurnRunInput
} from "./protocol.js";
import { EXECUTOR_PROTOCOL_VERSION, errorMessage } from "./protocol.js";

export type ExecutorDaemonOptions = {
  socketPath: string;
  stateDir: string;
  token: string;
  workspaceKey: string;
  /** dev 启动器的 pid；它消失后 daemon 有 15 秒宽限期再自退。 */
  ownerPid?: number;
  executors?: readonly Executor[];
  defaultExecutor?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExecutorDaemon = {
  socketPath: string;
  workspaceKey: string;
  pid: number;
  health(): HealthInfo;
  close(): Promise<void>;
};

function parseArgs(argv: readonly string[]): { command: string; flags: Map<string, string[]> } {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0]! : "daemon";
  const flags = new Map<string, string[]>();
  for (let index = command === argv[0] ? 1 : 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, [...(flags.get(key) ?? []), ""]);
      continue;
    }
    flags.set(key, [...(flags.get(key) ?? []), next]);
    index += 1;
  }
  return { command, flags };
}

function readFlag(flags: Map<string, string[]>, key: string): string | undefined {
  const values = flags.get(key);
  return values?.[values.length - 1] || undefined;
}

export async function startExecutorDaemon(options: ExecutorDaemonOptions): Promise<ExecutorDaemon> {
  const log = options.logger ?? (() => undefined);
  fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const processes = new ProcessHost({ stateDir: options.stateDir, workspaceKey: options.workspaceKey, logger: log });
  const turns = new TurnStore({ stateDir: options.stateDir, logger: log });
  const executors = options.executors ?? [];
  const modules = new ExecutorModules(options.stateDir);
  const startedAt = Date.now();
  let closed = false;

  const health = (): HealthInfo => {
    const views = turns.list();
    return {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      workspaceKey: options.workspaceKey,
      pid: process.pid,
      socketPath: options.socketPath,
      startedAt,
      processes: processes.list().length,
      turns: views.length,
      activeTurns: views.filter((view) => view.status === "queued" || view.status === "running").length
    };
  };

  if (process.platform !== "win32") {
    try { fs.unlinkSync(options.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  const reply = (socket: net.Socket, id: number, result: unknown, error?: unknown): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(error ? { id, ok: false, error: errorMessage(error) } : { id, ok: true, result })}\n`);
  };

  const dispatch = async (request: ExecutorRequest): Promise<unknown> => {
    if (request.token !== options.token || request.workspaceKey !== options.workspaceKey) {
      throw new Error("Executor 身份校验失败");
    }
    const params = request.params as Record<string, unknown> | undefined;
    switch (request.method) {
      case "ping":
        return { workspaceKey: options.workspaceKey, pid: process.pid, generation: 1, count: processes.list().length };
      case "health":
        return health();
      case "proc.ensure":
        return processes.ensure(params as unknown as ProcessEnsureInput);
      case "proc.stop":
        return processes.stop(params as unknown as string | { adapterId: string; owner: string; connectionId: string });
      case "proc.stopAll":
        await processes.stopAll();
        return { stopped: true };
      case "proc.query":
        return processes.query(params as never);
      case "proc.events":
        return processes.events(
          params as never,
          Number((params as { after?: unknown } | undefined)?.after ?? 0)
        );
      case "proc.list":
        return { processes: processes.list() };
      case "executor.register":
        return modules.register(params as unknown as ExecutorModuleRegistration);
      case "executor.unregister": {
        const ids = await modules.unregister(String(params?.registrationId ?? ""));
        const active = turns.list().filter(view => ids.includes(view.executor));
        for (const view of active) turns.cancel(view.turnId);
        await Promise.all(active.map(view => turns.drain(view.turnId)));
        return { removed: ids };
      }
      case "executor.list":
        return { executors: [...executors, ...modules.list()].map(({ id, kind }) => ({ id, kind })) };
      case "turn.run":
        return turns.run(params as unknown as TurnRunInput, [...executors, ...modules.list()], options.defaultExecutor, {
          stateDir: options.stateDir,
          workspaceKey: options.workspaceKey,
          processes,
          hostFor: (input) => {
            if (!input.host) return null;
            const client = createExecutorClient(input.host);
            return input.host.leaseId ? { call: <T>(method: string, params?: unknown) => client.call<T>("extension.call", { leaseId: input.host!.leaseId, method, params }) } : client;
          }
        });
      case "turn.drain":
        await turns.drain(String(params?.turnId ?? ""));
        return { drained: true };
      case "turn.query":
        return turns.get(String((params as { turnId?: unknown } | undefined)?.turnId ?? ""));
      case "turn.list":
        return { turns: turns.list() };
      case "turn.events": {
        const turnId = String((params as { turnId?: unknown } | undefined)?.turnId ?? "");
        return turns.events(turnId, Number((params as { since?: unknown } | undefined)?.since ?? 0));
      }
      case "turn.cancel":
        return turns.cancel(String((params as { turnId?: unknown } | undefined)?.turnId ?? ""));
      case "shutdown":
        void close().then(() => {
          // 关闭完成后进程可以自然退出；dev 启动器会负责重新拉起。
          setTimeout(() => process.exit(0), 10).unref?.();
        });
        return { shuttingDown: true };
      default:
        throw new Error(`未知 Executor 方法：${String(request.method)}`);
    }
  };

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let request: ExecutorRequest;
        try { request = JSON.parse(line) as ExecutorRequest; } catch { continue; }
        void dispatch(request).then(
          (result) => reply(socket, request.id, result),
          (error) => reply(socket, request.id, undefined, error)
        );
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  // 端点只在当前用户可读写；Windows 命名管道由系统 ACL 管理。
  if (process.platform !== "win32") {
    try { fs.chmodSync(options.socketPath, 0o600); } catch { /* best effort */ }
  }
  fs.writeFileSync(
    path.join(options.stateDir, "executor.json"),
    JSON.stringify({ workspaceKey: options.workspaceKey, pid: process.pid, socketPath: options.socketPath, token: options.token, startedAt }),
    { mode: 0o600 }
  );

  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  if (options.ownerPid && options.ownerPid > 0) {
    let orphanTimer: ReturnType<typeof setTimeout> | undefined;
    const ownerAlive = (): boolean => {
      try { process.kill(options.ownerPid!, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    };
    ownerTimer = setInterval(() => {
      if (closed || ownerAlive()) return;
      if (!orphanTimer) orphanTimer = setTimeout(() => void close(), 15_000);
    }, 2_000);
    ownerTimer.unref?.();
  }

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    turningOff = true;
    if (ownerTimer) clearInterval(ownerTimer);
    closing = (async () => {
      turns.cancelAll();
      await processes.stopAll();
      await Promise.all(turns.list().map(view => turns.drain(view.turnId)));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        try { fs.unlinkSync(options.socketPath); } catch { /* gone */ }
      }
      log({ event: "executor-daemon-stopped", workspaceKey: options.workspaceKey, pid: process.pid });
    })();
    return closing;
  };

  let turningOff = false;
  process.once("SIGTERM", () => { if (!turningOff) void close(); });
  process.once("SIGINT", () => { if (!turningOff) void close(); });

  log({ event: "executor-daemon-started", socketPath: options.socketPath, workspaceKey: options.workspaceKey, pid: process.pid });
  return { socketPath: options.socketPath, workspaceKey: options.workspaceKey, pid: process.pid, health, close };
}

/** 解析 CLI 参数并启动 daemon（供 `woohaa3-executor daemon` 与 dev 启动器使用）。 */
export async function runDaemonCommand(argv: readonly string[]): Promise<ExecutorDaemon> {
  const { flags } = parseArgs(argv);
  const runtimeDir = readFlag(flags, "state") ?? path.join(process.cwd(), ".local", "agent-runtime");
  const workspaceKey = readFlag(flags, "workspace") ?? "default";
  const socketPath = readFlag(flags, "socket") ?? executorEndpoint({ workspaceKey, runtimeDir });
  const token = readFlag(flags, "token") ?? "";
  if (!token) throw new Error("daemon 需要 --token（CLI 的 `daemon start` 会自动生成）");
  return startExecutorDaemon({
    socketPath,
    stateDir: runtimeDir,
    token,
    workspaceKey,
    ...(readFlag(flags, "owner-pid") ? { ownerPid: Number(readFlag(flags, "owner-pid")) } : {})
  });
}
