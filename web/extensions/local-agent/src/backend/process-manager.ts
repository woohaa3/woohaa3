import { createHash, randomBytes } from "node:crypto";
/**
 * 专用进程管理（本机 App Server）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.2/3.3 / design D1/D5/D9）。
 *
 * 只管理**本扩展拥有**的专用子进程；不接管/停止用户已有的共享 daemon（ATC 等）：
 * - 每个 (owner, connection, adapter) 一条专用进程与独立配置/工作目录（互不串配置）；
 * - HTTP 服务固定**回环**地址与专用端口（部署允许范围内分配）；
 * - 参数由适配器构造，**不提供任意 shell 命令串**、不自动下载执行；
 * - 缺 CLI 时 `probe()` 返回明确原因，不影响基础健康；
 * - 停止只按本扩展登记的句柄回收，幂等；扫加载模块**不**创建资源。
 *
 * 为独立可测：进程创建经可注入 `spawnFn`，端口经可注入 `allocatePort`，时钟可注入。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { AGENT_PROCESS_SUPERVISOR } from "./process-supervisor.js";

export type SpawnSpec = {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
};

export type SpawnedProcess = {
  pid: number | undefined;
  /**
   * 启动就绪信号：`spawn` 事件成功后 resolve，启动失败（入口不存在、无执行权限等）reject。
   * 未提供时（测试注入的假进程）按「已就绪」处理。
   */
  spawned?: Promise<void>;
  /** 结束回调；resolve 表示进程已退出（或启动失败）。 */
  exited: Promise<void>;
  kill: (signal?: NodeJS.Signals) => void;
  /** 仅 stdio 进程提供：JSONL/行式 stdio 连接。 */
  stdio?: StdioConnection;
};

/** stdio 行式连接（进程 stdio 的受控视图）。 */
export type StdioConnection = {
  send: (line: string) => void;
  onLine: (listener: (line: string) => void) => () => void;
  onStderr?: (listener: (line: string) => void) => () => void;
  close: () => void;
};

export type ProcessManagerOptions = {
  /** 隔离工作/配置目录根。 */
  workDirRoot: string;
  /** 部署允许的回环端口范围。 */
  portRange: { min: number; max: number };
  /** 可执行入口解析（按 adapter）。 */
  executableFor: (adapterId: string) => string | null | Promise<string | null>;
  acquireExecutable?: (adapterId: string) => Promise<{ entry: string; release(): void } | null>;
  /**
   * 专用配置目录创建后、进程启动前的准备钩子（如为 Codex 链接现有 home）。
   * 不得写入 secret 副本；失败应抛出，避免带着错误配置启动。
   */
  prepareConfigDir?: (input: {
    adapterId: string;
    owner: string;
    connectionId: string;
    workDir: string;
    configDir: string;
  }) => void | Promise<void>;
  /** 进程创建（缺省 node child_process；测试注入 fake）。 */
  spawnFn?: (spec: SpawnSpec) => SpawnedProcess;
  /** 端口分配（缺省范围内递增探测；测试注入固定端口）。 */
  allocatePort?: (input: { min: number; max: number; used: ReadonlySet<number> }) => number | null | Promise<number | null>;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export type ProcessHandle = {
  key: string;
  adapterId: string;
  owner: string;
  connectionId: string;
  kind: "stdio" | "http";
  /** HTTP 服务的回环地址（stdio 时为 null）。 */
  loopbackUrl: string | null;
  /** 专用 HTTP 进程认证；不进入提示词或日志。 */
  httpHeaders?: Record<string, string>;
  pid: number | undefined;
  workDir: string;
  configDir: string;
  startedAt: number;
  /** stdio 进程的受控 stdio 连接（仅 stdio 提供）。 */
  stdio?: StdioConnection;
};

export type ProcessProbe =
  | { ok: true; version: string }
  | { ok: false; code: "runtime-missing" | "version-unsupported"; message: string };

export type ProcessManager = {
  /** 运行依赖探测（缺 CLI/版本不支持准确报错；不启动进程）。 */
  probe: (adapterId: string, options?: { requiredVersion?: string }) => ProcessProbe | Promise<ProcessProbe>;
  /** 确保专用进程存在（幂等；已有句柄直接复用）。 */
  ensure: (input: { adapterId: string; owner: string; connectionId: string; args: readonly string[]; kind: "stdio" | "http"; env?: Record<string, string> }) => Promise<ProcessHandle>;
  /** 取得既有句柄（无则 null）。 */
  get: (input: { adapterId: string; owner: string; connectionId: string }) => ProcessHandle | null;
  /** 停止并回收指定句柄（幂等；只影响本扩展拥有的进程）。 */
  stop: (input: { adapterId: string; owner: string; connectionId: string }) => Promise<void>;
  /** 停止并回收全部自有进程（停用/退出）。 */
  stopAll: () => Promise<void>;
  /** 当前自有进程数量（诊断）。 */
  activeCount: () => number;
};

/** 每个 (adapter, owner, connection) 一条进程 key：不同 owner/连接不共配置。 */
export function processKey(adapterId: string, owner: string, connectionId: string): string {
  return `${adapterId}\u0000${owner}\u0000${connectionId}`;
}

function safeSegment(value: string): string {
  // Three full hashes under Windows TEMP exceed the Win32 cwd limit and spawn reports ENOENT.
  const hash = createHash("sha256").update(value).digest("hex");
  return process.platform === "win32" ? hash.slice(0, 32) : hash;
}

/**
 * 行帧缓冲：stdout 与 stderr 必须各持一份，不得共用。
 *
 * 共用时，未以换行结尾的 stderr 片段会被拼到下一段 stdout 之前，JSONL 解析报
 * 「非 JSON 帧」并把正常回合判成 protocol-mismatch。此函数只做纯分帧，便于直接回归。
 */
function createLineSplitter(emit: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    const lines = (buffer + chunk).split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  };
}

/**
 * 子进程两路流的分帧入口。
 *
 * `defaultSpawn` 实际使用本工厂，测试因此覆盖真实接线而不只是分帧算法本身。
 */
export function createLineStreams(
  onStdout: (line: string) => void,
  onStderr: (line: string) => void
): { stdout: (chunk: string) => void; stderr: (chunk: string) => void } {
  return { stdout: createLineSplitter(onStdout), stderr: createLineSplitter(onStderr) };
}

export function createProcessManager(options: ProcessManagerOptions): ProcessManager {
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? Date.now;
  const handles = new Map<string, { handle: ProcessHandle; process: SpawnedProcess | null }>();
  const usedPorts = new Set<number>();

  const defaultAllocatePort = async ({ min, max, used }: { min: number; max: number; used: ReadonlySet<number> }): Promise<number | null> => {
    for (let port = min; port <= max; port += 1) {
      if (used.has(port)) continue;
      // Reserve synchronously before probing: parallel ensure calls must not share a candidate.
      usedPorts.add(port);
      const free = await new Promise<boolean>(resolve => {
        const probe = createServer();
        probe.once("error", () => resolve(false));
        probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
      });
      if (free) return port;
      usedPorts.delete(port);
    }
    return null;
  };
  const allocatePort = options.allocatePort ?? defaultAllocatePort;

  const defaultSpawn = (spec: SpawnSpec): SpawnedProcess => {
    // The guardian owns the CLI tree and detects abrupt host death through its pipe/IPC.
    const child: ChildProcess = spawn(process.execPath, ["-e", AGENT_PROCESS_SUPERVISOR, JSON.stringify({ command: spec.command, args: spec.args })], {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const lineListeners = new Set<(line: string) => void>();
    const stderrListeners = new Set<(line: string) => void>();
    // stdout 与 stderr 各持一条独立帧缓冲：共用会把 stderr 残行拼进下一段 stdout。
    const streams = createLineStreams(
      (line) => lineListeners.forEach((listener) => listener(line)),
      (line) => stderrListeners.forEach((listener) => listener(line))
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => streams.stdout(chunk));
    child.stderr?.on("data", (chunk: string) => streams.stderr(chunk));
    // 启动失败（入口不存在、无执行权限等）是**这一条连接**的错误，不能升级成未处理事件。
    // 未监听 'error' 时 Node 会抛未捕获异常，把整个后端进程带走（表现为所有 API 502）。
    let markSpawned: () => void = () => undefined;
    let markSpawnFailed: (error: Error) => void = () => undefined;
    const spawned = new Promise<void>((resolve, reject) => {
      markSpawned = resolve;
      markSpawnFailed = reject;
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => { markSpawnFailed(new Error("Agent supervisor exited before startup")); resolve(); });
      child.once("error", () => resolve());
    });
    // 'spawn' 在进程真正起来后触发；'error' 可能先于或替代它。
    child.on("message", (message: { type?: string; message?: string }) => {
      if (message.type === "ready") markSpawned();
      if (message.type === "spawn-error") markSpawnFailed(new Error(message.message ?? "Agent startup failed"));
    });
    child.once("error", (error) => markSpawnFailed(error));
    // ensure() 会 await spawned；这里兜底，避免任何未被观察的 rejection。
    spawned.catch(() => undefined);
    return {
      get pid() {
        return child.pid;
      },
      spawned,
      exited,
      kill: (signal) => {
        try {
          // Killing a .cmd wrapper alone leaves its agent server listening on the old port.
          if (process.platform === "win32" && child.pid && child.exitCode === null && child.signalCode === null) {
            execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
            return;
          }
          child.kill(signal);
        } catch {
          /* 已退出 */
        }
      },
      stdio: {
        send: (line) => child.stdin?.write(`${line}\n`),
        onLine: (listener) => {
          lineListeners.add(listener);
          return () => lineListeners.delete(listener);
        },
        onStderr: (listener) => {
          stderrListeners.add(listener);
          return () => stderrListeners.delete(listener);
        },
        close: () => {
          try {
            child.stdin?.end();
          } catch {
            /* 已关闭 */
          }
        }
      }
    };
  };

  const probe = async (adapterId: string, probeOptions?: { requiredVersion?: string }): Promise<ProcessProbe> => {
    const executable = await options.executableFor(adapterId);
    if (!executable) return { ok: false, code: "runtime-missing", message: `未安装 ${adapterId} 所需可执行文件（本机来源需要后端机器上有对应 CLI）` };
    // 版本探测由适配器在真实调用时用协议初始化结果校对；此处只报「入口存在」。
    const version = probeOptions?.requiredVersion ?? "unknown";
    return { ok: true, version };
  };

  const start = async (input: { adapterId: string; owner: string; connectionId: string; args: readonly string[]; kind: "stdio" | "http"; env?: Record<string, string> }): Promise<ProcessHandle> => {
    const key = processKey(input.adapterId, input.owner, input.connectionId);
    const existing = handles.get(key);
    if (existing) return existing.handle;

    let executable = await options.executableFor(input.adapterId);
    if (!executable) throw new Error(`未安装 ${input.adapterId} 所需可执行文件`);
    if (!options.workDirRoot) throw new Error("未配置专用工作目录");

    const workDir = path.join(options.workDirRoot, safeSegment(input.adapterId), safeSegment(input.owner), safeSegment(input.connectionId));
    const configDir = path.join(workDir, "config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    await options.prepareConfigDir?.({
      adapterId: input.adapterId,
      owner: input.owner,
      connectionId: input.connectionId,
      workDir,
      configDir,
    });

    let loopbackUrl: string | null = null;
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("WOOHAA3_"))),
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...input.env
    };
    const args = [...input.args];
    let httpHeaders: Record<string, string> | undefined;
    if (input.kind === "http") {
      const port = await allocatePort({ min: options.portRange.min, max: options.portRange.max, used: usedPorts });
      if (port === null) throw new Error("回环端口已用尽");
      usedPorts.add(port);
      loopbackUrl = `http://127.0.0.1:${port}`;
      env.PORT = String(port);
      env.HOST = "127.0.0.1";
      args.push("--port", String(port));
      if (input.adapterId === "opencode-server") {
        const password = randomBytes(32).toString("hex");
        env.OPENCODE_SERVER_PASSWORD = password;
        httpHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
      }
    }
    // Codex has an explicit config-link hook. HTTP agents must retain their existing login
    // directories; their per-turn MCP config is runtime-only and their cwd/session is isolated.
    if (input.adapterId === "codex-appserver") {
      env.HOME = configDir;
      env.XDG_CONFIG_HOME = configDir;
    }

    let process0: SpawnedProcess | undefined;
    let lease: { entry: string; release(): void } | null = null;
    try {
      if (options.acquireExecutable) {
        lease = await options.acquireExecutable(input.adapterId);
        if (!lease) throw new Error("工具尚未安装，请安装后重试");
        executable = lease.entry;
      }
      process0 = (options.spawnFn ?? defaultSpawn)({ command: executable, args, env, cwd: workDir });
      await process0.spawned;
    } catch (error) {
      if (process0) {
        process0.kill("SIGTERM");
        await process0.exited;
      }
      lease?.release();
      // 入口不可执行：不登记句柄、不占端口，把原因交给调用方按连接错误上报。
      if (loopbackUrl) {
        const port = Number(new URL(loopbackUrl).port);
        usedPorts.delete(port);
      }
      throw new Error(
        `启动 ${input.adapterId} 失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const handle: ProcessHandle = {
      key,
      adapterId: input.adapterId,
      owner: input.owner,
      connectionId: input.connectionId,
      kind: input.kind,
      loopbackUrl,
      ...(httpHeaders ? { httpHeaders } : {}),
      pid: process0.pid,
      workDir,
      configDir,
      startedAt: now(),
      ...(input.kind === "stdio" && process0.stdio ? { stdio: process0.stdio } : {})
    };
    handles.set(key, { handle, process: process0 });
    void process0.exited.then(() => {
      lease?.release();
      if (handles.get(key)?.handle !== handle) return;
      handles.delete(key);
      if (loopbackUrl) usedPorts.delete(Number(new URL(loopbackUrl).port));
    });
    log({ event: "local-agent-process-started", adapterId: input.adapterId, kind: input.kind, pid: process0.pid });
    return handle;
  };

  const starting = new Map<string, Promise<ProcessHandle>>();
  const ensure = async (input: Parameters<typeof start>[0]): Promise<ProcessHandle> => {
    const key = processKey(input.adapterId, input.owner, input.connectionId);
    const pending = starting.get(key);
    if (pending) return pending;
    const operation = start(input);
    starting.set(key, operation);
    try { return await operation; } finally { starting.delete(key); }
  };

  const stop = async (input: { adapterId: string; owner: string; connectionId: string }): Promise<void> => {
    const key = processKey(input.adapterId, input.owner, input.connectionId);
    const entry = handles.get(key);
    if (!entry) return;
    handles.delete(key);
    if (entry.handle.loopbackUrl) {
      const port = Number(new URL(entry.handle.loopbackUrl).port);
      usedPorts.delete(port);
    }
    entry.process?.kill("SIGTERM");
    // 等待退出（有界），超时再强杀；只影响自有进程。
    await Promise.race([entry.process?.exited ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    entry.process?.kill("SIGKILL");
    log({ event: "local-agent-process-stopped", adapterId: input.adapterId });
  };

  return {
    probe,
    ensure,
    get: (input) => handles.get(processKey(input.adapterId, input.owner, input.connectionId))?.handle ?? null,
    stop,
    async stopAll() {
      await Promise.allSettled([...starting.values()]);
      const keys = [...handles.values()].map((entry) => entry.handle);
      await Promise.all(keys.map(handle => stop(handle)));
    },
    activeCount: () => handles.size
  };
}
