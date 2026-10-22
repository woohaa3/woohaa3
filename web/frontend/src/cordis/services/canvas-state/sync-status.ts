/**
 * 浏览器 Yjs 同步状态（唯一持久化路径）。
 *
 * 与 remote-cas 时代的 `RemoteSyncStatus` 不同：没有 `unpublished`/`conflict`/本地 outbox
 * 概念。断线即只读，重连后由 state-vector 差量收敛。
 */
export type CanvasSyncPhase = "idle" | "syncing" | "synced" | "offline";

/**
 * 断线来源。
 *
 * 两种断线对用户意味着不同的事：`browser-offline` 是整台机器的网络断了，页面里所有
 * 网络都不通；`session-closed` 只是这一条画布连接被关闭（画布服务重启、会话被回收、
 * 权限被撤销），页面的 HTTP 读取往往仍然可用。文案与恢复入口都据此区分，不能一律说
 * 「网络已断开」。
 */
export type CanvasSyncOfflineReason = "browser-offline" | "session-closed";

export type CanvasSyncStatus = {
  /** `remote`：已与后端建立同步；`offline`：断线只读；`disabled`：同步不可用。 */
  mode: "remote" | "offline" | "disabled";
  phase: CanvasSyncPhase;
  confirmedRevision: number | null;
  pendingCount: number;
  error: string | null;
  /** 断线来源；仅 `mode === "offline"` 时有意义，省略按 `session-closed` 解释。 */
  offlineReason?: CanvasSyncOfflineReason | null;
  /** 重建连接（显式重连或浏览器恢复联网）是否仍在进行：进行中时按钮置灰。 */
  reconnecting?: boolean;
};
