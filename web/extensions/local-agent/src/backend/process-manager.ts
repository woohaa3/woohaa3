/** 本机进程端口：宿主仅通过独立执行器管理进程。 */
import { createSupervisorProcessManager } from "./supervisor-client.js";

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
  logger?: (event: Record<string, unknown>) => void;
  /** 独立执行器连接；未配置时明确失败，不在宿主创建 Agent 进程。 */
  supervisor?: { socketPath: string; token: string; workspaceKey: string; portRange: { min: number; max: number } };
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
  ensure: (input: { adapterId: string; owner: string; connectionId: string; requestId?: string; args: readonly string[]; kind: "stdio" | "http"; env?: Record<string, string> }) => Promise<ProcessHandle>;
  /** 取得既有句柄（无则 null）。 */
  get: (input: { adapterId: string; owner: string; connectionId: string }) => ProcessHandle | null;
  /** 停止并回收指定句柄（幂等；只影响本扩展拥有的进程）。 */
  stop: (input: { adapterId: string; owner: string; connectionId: string }) => Promise<void>;
  /** 停止并回收全部自有进程（停用/退出）。 */
  stopAll: () => Promise<void>;
  /** 当前自有进程数量（诊断）。 */
  activeCount: () => number;
};

export function createProcessManager(options: ProcessManagerOptions): ProcessManager {
  if (options.supervisor) return createSupervisorProcessManager(options, options.supervisor);
  const unavailable = async (): Promise<never> => { throw new Error("宿主未配置独立执行器"); };
  return {
    probe: async () => ({ ok: false, code: "runtime-missing", message: "宿主未配置独立执行器" }),
    ensure: unavailable,
    get: () => null,
    stop: unavailable,
    stopAll: async () => undefined,
    activeCount: () => 0
  };
}
