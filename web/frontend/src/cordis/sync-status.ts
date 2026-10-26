/**
 * 右下角控件面板同步状态展示模型
 * （change: 2026-09-28-move-sync-status-to-corner-panel，design D3；
 *   2026-09-29-move-mcp-guide-to-bottom-hint：MCP 指引移出气泡，改由底部中央一行字承载；
 *   2026-10-21-recover-canvas-connection-explicitly：断线区分来源并给出显式重连入口）。
 *
 * 纯函数：把 `CanvasSessionStatus.remote` 派生为可渲染的展示模型。稳态（已同步、
 * 无待保存）只需静置图标 + hover/聚焦气泡；异常态（断线、待保存、同步错误）需要
 * 不依赖 hover 就能看见，因此用 `pinned` 让 tooltip 气泡常驻展开。纯展示，不写
 * Y.Doc、不提交命令、不改变写入门禁。
 */

export type SyncStatusTone = "ok" | "warning" | "danger";

/** 气泡里的显式动作（目前只有「重新连接」）。 */
export type SyncStatusAction = {
  kind: "reconnect";
  /** 按钮文案。 */
  label: string;
  /** 重建进行中：按钮置灰，避免重复触发。 */
  busy: boolean;
};

export type SyncStatusView = {
  tone: SyncStatusTone;
  /** 图标的可访问名称，也是气泡里的短状态文案。 */
  label: string;
  /** 气泡正文：只承载同步信息（不含 MCP 指引，后者在底部中央单独展示）。 */
  detail: string;
  /** 是否需要常驻显示（异常态为 true；稳态为 false）。 */
  pinned: boolean;
  /** 需要用户显式恢复动作时的按钮；稳态/待保存/不可用态不提供。 */
  action?: SyncStatusAction;
};

export type SyncStatusInput = {
  mode: "remote" | "offline" | "disabled";
  phase: "idle" | "syncing" | "synced" | "offline";
  pendingCount: number;
  error: string | null;
  /** canonical confirmed revision（稳态气泡显示用）。 */
  revision: number;
  /** 断线来源：浏览器断网 / 画布服务关闭连接；省略按后者解释。 */
  offlineReason?: "browser-offline" | "session-closed" | null;
  /** 重建连接是否仍在进行。 */
  reconnecting?: boolean;
  /** 内容权限只读（服务端判定）：链路可能正常，但这个账号写不了这张画布。 */
  readOnly?: boolean;
  /** 只读原因文案。 */
  readOnlyReason?: string | null;
  /**
   * 这张画布此刻有没有**宿主→远端**的上游链路（目录 `sync === "unlinked"` 时传 `"unlinked"`）。
   *
   * 与 `mode`/`phase` 不是一回事：那两个说的是「浏览器↔本机宿主」，它们全绿也只能证明改动
   * 到了本机。本文件此前只表达那一段，于是上游整条断掉时气泡仍然显示「已同步」——
   * 2026-10-26 的现场就是这样（宿主重启后房间先建好、解析拿不到凭据，之后没有任何重试）。
   * 省略表示调用方不掌握这个事实（例如纯本机画布），不显示任何提示。
   */
  upstream?: "linked" | "unlinked";
};

const OFFLINE_LABEL = "画布连接已断开，只读";
const OFFLINE_MESSAGE = "与画布服务的连接已断开，编辑已暂时锁定为只读。";
const BROWSER_OFFLINE_LABEL = "网络已断开，画布只读";
const BROWSER_OFFLINE_MESSAGE = "网络已断开，画布只读。";
const RECONNECTING_LABEL = "正在重新连接…";
const RECONNECTING_MESSAGE = "正在重新连接画布服务…";

const RECONNECT_ACTION = (busy: boolean): SyncStatusAction => ({ kind: "reconnect", label: "重新连接", busy });

/**
 * 由同步状态派生展示模型。
 *
 * 判定优先级：重建中 → 断线 → 错误/不可用 → 上游未连接 → 待保存 → 同步中 → 稳态。
 * 断线/错误都必须给出显式「重新连接」入口：页面不依赖浏览器 `online` 事件或
 * 刷新才能恢复（change: 2026-10-21-recover-canvas-connection-explicitly）。
 */
export function syncStatusView(input: SyncStatusInput): SyncStatusView {
  const revision = input.revision ?? 0;
  if (input.reconnecting) {
    return {
      tone: "warning",
      label: RECONNECTING_LABEL,
      detail: RECONNECTING_MESSAGE,
      pinned: true,
      action: RECONNECT_ACTION(true)
    };
  }
  if (input.mode === "offline" || input.phase === "offline") {
    const browserOffline = input.offlineReason === "browser-offline";
    return {
      tone: "danger",
      label: browserOffline ? BROWSER_OFFLINE_LABEL : OFFLINE_LABEL,
      detail: browserOffline ? BROWSER_OFFLINE_MESSAGE : OFFLINE_MESSAGE,
      pinned: true,
      action: RECONNECT_ACTION(false)
    };
  }
  if (input.error) {
    return { tone: "danger", label: "同步异常", detail: input.error, pinned: true, action: RECONNECT_ACTION(false) };
  }
  // 权限只读是**稳态**，不是故障：不提供"重新连接"（重连也不会改变权限），
  // 但必须常驻可见——否则用户会一路编辑到第一次服务端写入才被拒。
  if (input.readOnly) {
    return {
      tone: "warning",
      label: "只读画布",
      detail: input.readOnlyReason ?? "你对这张画布只有只读权限，修改不会被保存。",
      pinned: true
    };
  }
  // 上游链路缺失：本机一切正常（mode/phase 都是绿的），但改动没有发往远端。
  // 必须常驻可见——稳态文案「已同步」在这里是错误陈述。
  if (input.upstream === "unlinked") {
    return {
      tone: "warning",
      label: "未同步到远端",
      detail: "与远端的同步链路没有建立：改动目前只保存在本机。重新打开这张画布或重启应用后会重新建链。",
      pinned: true
    };
  }
  if (input.mode === "disabled") {
    return { tone: "danger", label: "同步异常", detail: "同步不可用", pinned: true };
  }
  if (input.pendingCount > 0) {
    const label = `等待确认（${input.pendingCount} 项待保存）`;
    return { tone: "warning", label, detail: `${label} · revision ${revision}`, pinned: true };
  }
  if (input.phase === "syncing" || input.phase === "idle") {
    const label = "正在连接同步…";
    return { tone: "warning", label, detail: label, pinned: true };
  }
  return { tone: "ok", label: "已同步", detail: `已同步 · revision ${revision}`, pinned: false };
}
