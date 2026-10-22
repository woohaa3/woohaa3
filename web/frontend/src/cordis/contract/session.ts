/**
 * Canvas Session 契约（页面级，高于 React root）。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */
import type { CanvasCommand } from "@woohaa3/contracts";
import type { CanvasSyncStatus, CommandHandle, CommandLifecycleRegistry } from "../services/canvas-state/index.js";

export type CanvasSessionPhase = "loading" | "ready" | "error";

export type CanvasSessionStatus = {
  phase: CanvasSessionPhase;
  error: string | null;
  /** 是否已把规范画布交给渲染运行时（Bevy ready + 首个快照）。 */
  hydrated: boolean;
  /** 服务端 Yjs 同步状态（唯一持久化路径）。 */
  remote: CanvasSyncStatus;
};

export interface CanvasSession {
  getStatus(): CanvasSessionStatus;
  subscribe(listener: (status: CanvasSessionStatus) => void): () => void;
  /** 从加载失败中重试（会重新走一次完整加载，期间整页显示启动态）。 */
  retry(): Promise<void>;
  /**
   * 显式重建画布连接（change: 2026-10-21-recover-canvas-connection-explicitly）。
   *
   * 用于断线只读/同步异常时的「重新连接」入口：不重载页面、不重开画布，也不把会话
   * 打回启动态。已有 provider 时走物理连接重建（state vector 差量收敛）；尚未建立
   * 过连接时回落为一次完整 attach。幂等：重建进行中重复调用不叠加连接。
   */
  reconnect(): Promise<void>;
  /** 显式请求一次完整 hydrate（例如调试或恢复）。 */
  requestHydrate(): void;
  /** Yjs 命令生命周期注册表；宿主用它观察 pending/accepted/committed 状态。 */
  commandLifecycle(): CommandLifecycleRegistry | null;
  /**
   * 提交一个原子服务端命令批次。未同步（syncing/offline）时返回结构化失败，
   * 不进入离线 outbox。
   */
  submitCommands(
    commands: readonly CanvasCommand[],
    commandId: string
  ): { ok: true; handle: CommandHandle } | { ok: false; reason: string; code?: string };
  /** 当前同步相位（供快捷键写入门禁判定）。 */
  isWritable(): boolean;
  /** 真正销毁会话。 */
  shutdown(): void;
}
