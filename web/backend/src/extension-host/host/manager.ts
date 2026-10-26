/**
 * Extension Host 管理器（change: 2026-10-21-isolate-extension-host-process，D2/D3/D8，任务 4.1）。
 *
 * 负责「起一个子进程实例」：fork（execArgv、advanced 序列化、环境白名单、cwd、TMPDIR）、
 * 分配实例 id、全局进程数上限、stdout/stderr 转结构化日志、`$/hello` 握手与心跳。
 *
 * 只描述**一个实例**的生死；崩溃判定后的处置（撤注册、退避重启、熔断）在 supervisor（任务 7），
 * 蓝绿切换在 swap（任务 8）。实例的每一次结束都恰好回调一次 `onExit`（exit / 心跳超时 / 协议错误
 * 以先到者为准，按实例 id 去重）。
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXTENSION_HOST_LIMITS,
  EXTENSION_HOST_METHODS,
  EXTENSION_HOST_PROTOCOL_VERSION,
  type ExtensionHostHello,
  type ExtensionHostStartParams
} from "@woohaa3/contracts";
import { connectIpc, RpcError, type RpcEndpoint } from "../rpc/index.js";
import { attachChildLogs, createChildLogSink } from "./child-logs.js";

/** 结束原因：`stopped` 是宿主主动停止，其余都算崩溃。 */
export type InstanceExitReason = "stopped" | "exit" | "heartbeat-timeout" | "protocol-error" | "hello-failed";

export type InstanceExit = {
  instanceId: string;
  reason: InstanceExitReason;
  exitCode: number | null;
  signal: string | null;
  message?: string;
};

export type ExtensionHostInstance = {
  readonly instanceId: string;
  readonly extensionId: string;
  readonly directory: string;
  readonly pid: number | undefined;
  readonly rpc: RpcEndpoint;
  /** `$/hello` 握手完成、启动参数已下发（子进程开始 apply）。 */
  readonly started: Promise<void>;
  /** 本实例结束（任何原因）时 resolve；只 resolve 一次。 */
  readonly exited: Promise<InstanceExit>;
  /** 主动停止：发 `host.stop`，在时限内等子进程自行退出，超时 SIGKILL。幂等。 */
  stop(timeoutMs: number): Promise<InstanceExit>;
};

export type SpawnRequest = {
  extensionId: string;
  /** 版本目录（子进程 cwd）。 */
  directory: string;
  /** 下发给子进程的启动参数（不含 instanceId，由管理器补）。 */
  start: Omit<ExtensionHostStartParams, "instanceId">;
};

export type ForkFn = (modulePath: string, args: readonly string[], options: Parameters<typeof fork>[2]) => ChildProcess;

export type ExtensionHostManagerOptions = {
  /** 子进程入口（构建产物 `dist/extension-host-child.js`）。 */
  childEntry: string;
  log: (event: Record<string, unknown>) => void;
  /** 本机设置读取（每次 spawn 现读，热重载在下次启动子进程时生效）。 */
  settings: () => { maxOldSpaceMb: number; maxProcesses: number };
  /** 宿主 SDK ABI（hello 校验用）。 */
  sdkAbi?: number;
  /** 子进程临时目录根（每实例一个子目录）；缺省 os.tmpdir()/woohaa3-extension-host。 */
  tmpRoot?: string;
  /** 从宿主环境透传的变量（白名单，D2）。 */
  envAllowlist?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** hello 握手时限。 */
  helloTimeoutMs?: number;
  /** 测试注入。 */
  fork?: ForkFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type ExtensionHostManager = {
  spawn(request: SpawnRequest): ExtensionHostInstance;
  /** 存活实例数。 */
  size(): number;
  /** 停止全部实例（宿主关闭）。 */
  stopAll(timeoutMs: number): Promise<void>;
};

export const DEFAULT_ENV_ALLOWLIST = ["NODE_ENV", "TZ", "LANG"] as const;

export class ExtensionHostLimitError extends RpcError {
  constructor(limit: number) {
    super("extension-host-limit", `扩展子进程数已达上限（${limit}）`);
  }
}

export function createExtensionHostManager(options: ExtensionHostManagerOptions): ExtensionHostManager {
  const doFork: ForkFn = options.fork ?? ((modulePath, args, forkOptions) => fork(modulePath, [...args], forkOptions));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const heartbeatInterval = options.heartbeatIntervalMs ?? EXTENSION_HOST_LIMITS.heartbeatIntervalMs;
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? EXTENSION_HOST_LIMITS.heartbeatTimeoutMs;
  const helloTimeout = options.helloTimeoutMs ?? 30_000;
  const tmpRoot = options.tmpRoot ?? path.join(os.tmpdir(), "woohaa3-extension-host");
  const live = new Set<ExtensionHostInstance>();

  const childEnv = (tmpdir: string): NodeJS.ProcessEnv => {
    const base = options.baseEnv ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const key of options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
      if (base[key] !== undefined) env[key] = base[key];
    }
    env.TMPDIR = tmpdir;
    env.TMP = tmpdir;
    env.TEMP = tmpdir;
    // 子进程入口只在此标记下自启（被 import 时不产生副作用）。
    env.WOOHAA3_EXTENSION_HOST_CHILD = "1";
    return env;
  };

  const spawn = (request: SpawnRequest): ExtensionHostInstance => {
    const { maxOldSpaceMb, maxProcesses } = options.settings();
    if (live.size >= maxProcesses) throw new ExtensionHostLimitError(maxProcesses);
    const instanceId = `${request.extensionId}#${randomUUID().slice(0, 8)}`;
    const tmpdir = path.join(tmpRoot, instanceId.replace(/[^A-Za-z0-9._-]/g, "_"));
    fs.mkdirSync(tmpdir, { recursive: true });
    const log = (event: Record<string, unknown>) => options.log({ extension: request.extensionId, instanceId, ...event });

    const child = doFork(options.childEntry, [], {
      execArgv: [`--max-old-space-size=${maxOldSpaceMb}`, "--disable-proto=throw"],
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: childEnv(tmpdir),
      cwd: request.directory
    });
    attachChildLogs(
      createChildLogSink({ extensionId: request.extensionId, instanceId, log: options.log }),
      child.stdout ?? null,
      child.stderr ?? null
    );

    let finished = false;
    let stopping = false;
    let resolveExited!: (exit: InstanceExit) => void;
    const exited = new Promise<InstanceExit>((resolve) => {
      resolveExited = resolve;
    });
    let heartbeat: unknown = null;
    let lastPong = Date.now();

    const finish = (reason: InstanceExitReason, detail: { exitCode?: number | null; signal?: string | null; message?: string } = {}) => {
      if (finished) return;
      finished = true;
      live.delete(instance);
      if (heartbeat !== null) clearTimer(heartbeat);
      heartbeat = null;
      const crashed = reason !== "stopped";
      rpc.close(crashed ? "extension-crashed" : "extension-unavailable", crashed ? "扩展子进程已退出" : "扩展子进程已停止");
      // 确保进程真的没了（协议错误 / 心跳超时时子进程可能还活着）。
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(tmpdir, { recursive: true, force: true });
      const exit: InstanceExit = {
        instanceId,
        reason,
        exitCode: detail.exitCode ?? child.exitCode ?? null,
        signal: detail.signal ?? child.signalCode ?? null,
        ...(detail.message ? { message: detail.message } : {})
      };
      log({ event: crashed ? "extension-host-instance-crashed" : "extension-host-instance-stopped", reason, exitCode: exit.exitCode, signal: exit.signal, ...(detail.message ? { message: detail.message } : {}) });
      resolveExited(exit);
    };

    const rpc = connectIpc(child as unknown as Parameters<typeof connectIpc>[0], {
      onProtocolError: (error) => finish("protocol-error", { message: error.message }),
      onSendError: (error) => log({ event: "extension-host-send-failed", message: error.message })
    });
    child.once("exit", (code, signal) => finish(stopping ? "stopped" : "exit", { exitCode: code, signal }));
    child.once("error", (error) => finish("exit", { message: error.message }));

    // 握手：子进程第一帧 `$/hello` 请求，宿主回启动参数。
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    started.catch(() => undefined);
    const helloTimer = setTimer(() => {
      rejectStarted(new RpcError("rpc-timeout", "扩展子进程未在时限内完成握手"));
      finish("hello-failed", { message: "hello-timeout" });
    }, helloTimeout);
    rpc.handle(EXTENSION_HOST_METHODS.hello, (params) => {
      clearTimer(helloTimer);
      const hello = params as Partial<ExtensionHostHello> | undefined;
      if (hello?.protocol !== EXTENSION_HOST_PROTOCOL_VERSION) {
        const error = new RpcError("MARKETPLACE_ENGINES_INCOMPATIBLE", `扩展子进程协议版本不兼容：${String(hello?.protocol)}`);
        rejectStarted(error);
        setTimer(() => finish("hello-failed", { message: error.message }), 0);
        throw error;
      }
      if (options.sdkAbi !== undefined && hello.sdkAbi !== options.sdkAbi) {
        const error = new RpcError("MARKETPLACE_ENGINES_INCOMPATIBLE", `扩展子进程 SDK ABI 不兼容：${String(hello.sdkAbi)}`);
        rejectStarted(error);
        setTimer(() => finish("hello-failed", { message: error.message }), 0);
        throw error;
      }
      resolveStarted();
      startHeartbeat();
      return { ...request.start, instanceId } satisfies ExtensionHostStartParams;
    });
    exited.then((exit) => {
      clearTimer(helloTimer);
      rejectStarted(new RpcError("extension-crashed", `扩展子进程在握手前退出（${exit.reason}）`));
    });

    const startHeartbeat = () => {
      lastPong = Date.now();
      const tick = () => {
        heartbeat = null;
        if (finished) return;
        if (Date.now() - lastPong > heartbeatTimeout) {
          finish("heartbeat-timeout", { message: `${heartbeatTimeout}ms 内无心跳响应` });
          return;
        }
        rpc.request(EXTENSION_HOST_METHODS.ping, undefined, { timeoutMs: heartbeatTimeout }).then(
          () => {
            lastPong = Date.now();
          },
          () => undefined
        );
        heartbeat = setTimer(tick, heartbeatInterval);
      };
      heartbeat = setTimer(tick, heartbeatInterval);
    };

    const instance: ExtensionHostInstance = {
      instanceId,
      extensionId: request.extensionId,
      directory: request.directory,
      pid: child.pid,
      rpc,
      started,
      exited,
      stop(timeoutMs) {
        if (finished) return exited;
        if (!stopping) {
          stopping = true;
          rpc.request(EXTENSION_HOST_METHODS.hostStop, undefined, { timeoutMs }).catch(() => undefined);
          const killer = setTimer(() => {
            if (!finished) {
              log({ event: "extension-host-stop-timeout", timeoutMs });
              child.kill("SIGKILL");
              // 极端情况下 exit 事件丢失：按停止收尾。
              setTimer(() => finish("stopped", { message: "stop-timeout" }), 1000);
            }
          }, timeoutMs);
          exited.then(() => clearTimer(killer));
        }
        return exited;
      }
    };
    live.add(instance);
    log({ event: "extension-host-instance-spawned", pid: child.pid, directory: request.directory, maxOldSpaceMb });
    return instance;
  };

  return {
    spawn,
    size: () => live.size,
    async stopAll(timeoutMs) {
      await Promise.all([...live].map((instance) => instance.stop(timeoutMs)));
    }
  };
}
