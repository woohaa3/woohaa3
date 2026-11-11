/**
 * 独立执行运行时协议（woohaa3-executor）。
 *
 * 设计边界：
 * - 只传**已准备**的回合 / 任务，不在这里解析角色、不读画布、不签发 grant；
 * - 状态变化用单调 cursor 事件表示，客户端按 `since` 拉取，断线可重放；
 * - 进程操作只使用 `proc.*`；旧 Agent Supervisor 方法不再接受。
 */
import type { PreparedAgentRoleTurn } from "@woohaa3/contracts";

export const EXECUTOR_PROTOCOL_VERSION = 1 as const;

export type ExecutorMethod =
  | "ping"
  | "health"
  | "proc.ensure"
  | "proc.stop"
  | "proc.stopAll"
  | "proc.query"
  | "proc.events"
  | "proc.list"
  | "executor.register"
  | "executor.unregister"
  | "executor.detach"
  | "executor.list"
  | "turn.run"
  | "turn.drain"
  | "turn.query"
  | "turn.events"
  | "turn.cancel"
  | "turn.list"
  | "shutdown";

export type ExecutorRequest = {
  id: number;
  token?: string;
  workspaceKey?: string;
  method: ExecutorMethod | string;
  params?: unknown;
};

export type ExecutorResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** 本机子进程的启动参数；与 local-agent 现有 supervisor 请求同形。 */
export type ProcessEnsureInput = {
  adapterId: string;
  owner: string;
  connectionId: string;
  requestId?: string;
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  kind: "http" | "stdio";
  portMin?: number;
  portMax?: number;
  httpHeaders?: Record<string, string>;
};

export type ProcessHandleInfo = {
  key: string;
  adapterId: string;
  owner: string;
  connectionId: string;
  kind: "http" | "stdio";
  loopbackUrl: string | null;
  httpHeaders?: Record<string, string>;
  stdioPath: string | null;
  pid: number | undefined;
  startedAt: number;
};

export type ProcessRunRecord = {
  key: string;
  workspaceKey?: string;
  adapterId?: string;
  owner?: string;
  connectionId?: string;
  requestId?: string | null;
  kind?: string;
  loopbackUrl?: string | null;
  stdioPath?: string | null;
  pid?: number;
  status?: string;
  cursor?: number;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
};

export type ProcessEvent = { cursor: number; data: string };

export type TurnKind = "agent" | "generation";

export type TurnRunInput = {
  /** 稳定回合计身份；与 requestId 一起构成幂等身份。 */
  turnId: string;
  requestId: string;
  kind: TurnKind;
  /** 目标 executor id；缺省用 daemon 的 defaultExecutor。 */
  executor?: string;
  /** agent 回合的宿主准备结果（不在这里重新准备）。 */
  prepared?: PreparedAgentRoleTurn;
  /** generation 等后续任务的结构化输入；协议不解释其业务含义。 */
  payload?: unknown;
  /**
   * 宿主依赖桥（可选）：executor 需要连接/工具授权/画布读取时，通过这个本机端点
   * 回调宿主，而不是在 daemon 里持有秘密或 Canvas 权限。
   */
  host?: { socketPath: string; token: string; workspaceKey: string; leaseId?: string };
  /** 可选超时；超时按 cancelled 结算并 abort。 */
  timeoutMs?: number;
};

export type TurnStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type TurnError = { code: string; message: string };

export type ExecutorOutcome =
  | { status: "succeeded"; result?: unknown }
  | { status: "failed"; error: TurnError; result?: unknown }
  | { status: "cancelled"; error?: TurnError; result?: unknown };

export type RuntimeEvent = {
  cursor: number;
  turnId: string;
  type: string;
  payload?: unknown;
  at: string;
};

export type TurnView = {
  turnId: string;
  requestId: string;
  kind: TurnKind;
  executor: string;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
  cursor: number;
  result?: unknown;
  error?: TurnError;
  /** prepared 摘要（不包含消息正文）。 */
  preparedHash?: string;
};

export type ExecutorProcessPort = {
  ensure(input: ProcessEnsureInput): Promise<ProcessHandleInfo>;
  stop(input: { adapterId: string; owner: string; connectionId: string }): Promise<void>;
};

export type ExecutorHostPort = {
  /** 调用宿主依赖桥的受控方法；方法白名单由宿主决定。 */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type ExecutorRunContext = {
  signal: AbortSignal;
  turnId: string;
  requestId: string;
  stateDir: string;
  workspaceKey: string;
  emit: (type: string, payload?: unknown) => void;
  processes: ExecutorProcessPort;
  host: ExecutorHostPort | null;
};

export type Executor = {
  id: string;
  /** 允许的回合类型；`any` 表示通用的后续 generation 执行器。 */
  kind: TurnKind | "any";
  run(input: TurnRunInput, context: ExecutorRunContext): Promise<ExecutorOutcome>;
};

export type HealthInfo = {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  /** 身份快照结构版本；接管前必须匹配。 */
  schemaVersion?: number;
  runtimeVersion?: string;
  workspaceKey: string;
  pid: number;
  socketPath: string;
  startedAt: number;
  processes: number;
  turns: number;
  activeTurns: number;
};

export type ExecutorClientOptions = {
  socketPath: string;
  token: string;
  workspaceKey: string;
  /** 单次 RPC 超时；事件跟随不使用这个值。 */
  timeoutMs?: number;
  /**
   * 连接层失败（超时 / socket 错误）的稳定错误码。
   *
   * 宿主桥（daemon → host）与执行器（host → daemon）共用本客户端：调用方按用途注入，
   * 让上层能把「通道不可用」和领域拒绝分开，而不是都退化成同一条通用文案。
   */
  transportErrorCode?: string;
  /** 测试/嵌入时可注入 RPC 实现。 */
  request?: (request: ExecutorRequest) => Promise<unknown>;
};

/** 将错误统一成协议里的稳定文本（不把堆栈/路径带进浏览器）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
