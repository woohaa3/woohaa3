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
  /**
   * 内容权限只读（服务端判定，与断线无关）。
   *
   * 与 `mode === "offline"` 是两件事：链路可能完全正常，只是这个账号在这张画布上没有
   * 写权限（viewer 协作者、只读链接、或者根本不是这张画布的参与者）。界面据此显示常驻
   * 只读提示，并禁用生成/编辑入口——不能等到第一次服务端写入被拒绝才告诉用户。
   */
  readOnly?: boolean;
  /** 只读原因（面向用户的一句话）；`readOnly` 为真时展示。 */
  readOnlyReason?: string | null;
};
