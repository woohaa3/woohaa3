// 定义处：@woohaa3/contracts —— 前端 Cordis 根的服务契约；web/frontend 只做实现与 re-export。
/**
 * App 级任务结果通知契约（change: 2026-10-17-move-settings-into-canvas-dialog，design D8/D9/D10）。
 *
 * **纯类型**：不 import React/DOM/Node，供 Context 增强、设置分区、Web/Tauri presenter 与测试共用。
 *
 * 通知是任务事实的**呈现**，不是任务状态源，也不是持久通知中心：
 * - 事实来自授权的任务历史只读面（watermark + 增量订阅）；
 * - 服务归 App scope 所有，不随设置弹窗、Canvas page 或任务活动扩展释放；
 * - 偏好是本地非敏感数据，不写 `/api/settings`、画布 Y.Doc 或共享宿主配置。
 */

/** 事件类别开关（成功 / 失败分开）。 */
export type TaskNotificationCategories = {
  succeeded: boolean;
  failed: boolean;
};

/** 平台呈现渠道。 */
export type TaskNotificationChannel = "title" | "system";

/** 系统通知权限的真实状态（与用户意愿分开）。 */
export type TaskNotificationPermission = "unknown" | "prompt" | "granted" | "denied" | "unsupported";

/** 渠道的运行状态（是否真的能发送，以及原因）。 */
export type TaskNotificationChannelState = {
  /** 用户意愿开关。 */
  enabled: boolean;
  /** 实际可用性：权限/平台能力。 */
  status: "ready" | "blocked" | "unsupported";
  /** 面向用户的安全原因；ready 时为 null。 */
  reason: string | null;
};

/** 本地偏好（版本化持久化的内容）。 */
export type TaskNotificationPreferences = {
  categories: TaskNotificationCategories;
  /** Web 标题渠道（默认开）。 */
  titleEnabled: boolean;
  /** Tauri 系统通知渠道（默认关；开启时才申请权限）。 */
  systemEnabled: boolean;
};

export const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences = {
  categories: { succeeded: true, failed: true },
  titleEnabled: true,
  systemEnabled: false
};

/** 服务快照（`useSyncExternalStore` 稳定引用）。 */
export type TaskNotificationSnapshot = {
  preferences: TaskNotificationPreferences;
  /** 当前呈现平台。 */
  platform: "web" | "desktop";
  /** 当前会话能用的渠道（Web 只有 title；桌面为 title? + system）。 */
  channels: {
    title: TaskNotificationChannelState;
    system: TaskNotificationChannelState;
  };
  permission: TaskNotificationPermission;
  /** 在应用处于后台时累计的未读结果（标题前缀来源）。 */
  pending: { succeeded: number; failed: number };
  /** 观察源状态：不可用时 preferences 仍可读写，但不会产生提醒。 */
  source: {
    status: "idle" | "starting" | "live" | "unavailable";
    /** 面向用户的安全原因（含授权不足）；ready 时为 null。 */
    reason: string | null;
  };
  /** 最近一次偏好持久化失败的安全文案；无错误为 null。 */
  storageError: string | null;
};

/** 具名操作（设置分区只调用这些，不直接改内部状态）。 */
export type TaskNotificationActions = {
  setCategory(category: keyof TaskNotificationCategories, enabled: boolean): void;
  setChannel(channel: TaskNotificationChannel, enabled: boolean): Promise<void>;
  /** 用户主动申请 OS 通知权限（只在开启系统通知且未询问时调用）。 */
  requestPermission(): Promise<void>;
  /** 用户主动发送测试通知（允许前台；不写入任务事实）。 */
  sendTestNotification(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 重新读取外部权限变化（应用聚焦/重新进入分区）。 */
  refreshPermission(): Promise<void>;
  /** 前台恢复：清除标题计数与未发送批次（不改变任务面板未读）。 */
  clearPending(): void;
};

/** 证据/诊断所需的最近一次提醒记录（有界，不含明文内容）。 */
export type TaskNotificationDelivery = {
  taskKey: string;
  state: "succeeded" | "failed";
  attempt: number | null;
  channel: TaskNotificationChannel;
  at: number;
};

export type TaskNotificationService = {
  getSnapshot(): TaskNotificationSnapshot;
  subscribe(listener: () => void): () => void;
  readonly actions: TaskNotificationActions;
  /** 最近投递（诊断/回归；有界）。 */
  deliveries(): readonly TaskNotificationDelivery[];
  dispose(): void;
};

/**
 * 通知选中一条历史记录后，用户点击要跳转的目标。
 *
 * 只携带**稳定身份**（taskKey 与可选画布/节点），不含 prompt、参数、媒体 URL 或任意外部地址。
 */
export type TaskNotificationTarget = {
  taskKey: string;
  canvasId?: string;
  nodeId?: string;
};
