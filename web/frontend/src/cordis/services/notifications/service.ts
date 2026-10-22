/**
 * App 级任务结果通知服务
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.2/7.3/7.4、9.2/9.3 / design D8–D10）。
 *
 * 唯一 owner：观察任务事实、持有本地偏好、判定前台/渠道/权限、去重与批量、调用平台 presenter。
 * 设置分区只订阅 snapshot 并调用具名操作，**不创建第二份订阅或偏好 store**。
 *
 * 关键不变量：
 * - 服务归 App scope；关闭设置、释放 Canvas page、切到历史页都不停止它；
 * - 只在应用后台发送业务提醒（前台打开设置仍算正在使用）；
 * - 首次基线不发旧终态；去重按 taskKey + 执行轮次；
 * - 回到前台取消未发送批次并清除标题计数，不改任务面板 unread；
 * - 偏好即时生效、不产生草稿；持久化失败不谎称已保存；
 * - OS 权限与用户意愿分开，只有用户开启系统通知且未询问时才申请。
 *
 * 纯逻辑 + 注入平台适配，便于无渲染回归。
 */
import type { TaskExecutionSummary } from "@woohaa3/contracts";
import {
  type TaskNotificationChannel,
  type TaskNotificationChannelState,
  type TaskNotificationDelivery,
  type TaskNotificationPermission,
  type TaskNotificationPreferences,
  type TaskNotificationService,
  type TaskNotificationSnapshot,
  type TaskNotificationTarget
} from "../../contract/notification.js";
import type { TaskHistoryReader } from "../../../shared/task-history/client.js";
import {
  createTaskNotificationPreferenceStore,
  type TaskNotificationPreferenceStore,
  type TaskNotificationStorage
} from "./preferences.js";
import { createTaskResultSource, type TaskResultEvent, type TaskResultSource } from "./task-source.js";
import { createTitlePresenter, type TitlePresenter } from "./web-presenter.js";
import {
  broadcastForeground,
  createForegroundState,
  createReminderCoordinator,
  type ForegroundState,
  type ReminderBroadcast,
  type ReminderCoordinator,
  type ReminderLocks
} from "./coordination.js";

/** 后台批量合并窗口（design D9：初始建议 2 秒）。 */
export const NOTIFICATION_BATCH_MS = 2_000;
/** 最近投递记录上限（诊断/回归）。 */
const MAX_DELIVERIES = 50;

/** 平台 presenter：只负责把已决定的提醒真正发出去。 */
export type PlatformPresenter = {
  platform: "web" | "desktop";
  /** 系统通知权限（Web 恒为 unsupported）。 */
  permission(): TaskNotificationPermission;
  /** 用户主动申请权限。 */
  requestPermission(): Promise<TaskNotificationPermission>;
  /** 重新读取外部权限变化。 */
  refreshPermission(): Promise<TaskNotificationPermission>;
  /**
   * 发送系统通知。合并批次里携带成功/失败计数与（单任务的）稳定目标。
   * 失败返回安全原因，不改写任务事实。
   */
  notify(input: {
    succeeded: number;
    failed: number;
    target?: TaskNotificationTarget;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type NotificationServiceOptions = {
  /** 任务历史只读面（缺失即 unavailable，但偏好仍可用）。 */
  reader?: TaskHistoryReader | null;
  /**
   * 数据范围过滤（授权/主体）：管理员可读不等于愿意接收所有人的任务。
   * 缺省接受全部（仅用于测试装配）；生产必须注入 scopedAccept。
   */
  accept?: (record: TaskExecutionSummary) => boolean;
  /** 当前作用域（实例 + basePath + 数据范围）。 */
  scope: () => { instanceId: string; basePath: string; dataScopeId: string };
  /** 平台 presenter；Web 用标题渠道，desktop 提供系统通知。 */
  presenter: PlatformPresenter;
  /** 本地偏好存储（测试注入）。 */
  storage?: TaskNotificationStorage | null;
  /** 前后台判定（测试注入）。 */
  foreground?: ForegroundState;
  /** 多标签页协调（测试注入）。 */
  coordinator?: ReminderCoordinator;
  /** Web Locks 注入（缺省读 `navigator.locks`；jsdom 无则退化为单标签页 owner）。 */
  locks?: ReminderLocks | null;
  /** BroadcastChannel 工厂注入（缺省用 `globalThis.BroadcastChannel`；不可用则 null）。 */
  createChannel?: (name: string) => ReminderBroadcast | null;
  /** 标题 presenter（测试注入）。 */
  title?: TitlePresenter;
  /** 部署注入的基础标题（缺省由 title presenter 读取当前 document.title）。 */
  baseTitle?: string;
  /** 批量窗口（测试可缩短）。 */
  batchMs?: number;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export type NotificationServiceHandle = TaskNotificationService & {
  /** 启动观察（App scope 装配后调用一次）。 */
  start(): Promise<void>;
  /** 数据范围变化（账号切换）：重读偏好并为新范围重建基线。 */
  handleScopeChange(): Promise<void>;
};

export function createTaskNotificationService(options: NotificationServiceOptions): NotificationServiceHandle {
  const now = options.now ?? Date.now;
  const batchMs = options.batchMs ?? NOTIFICATION_BATCH_MS;
  const log = options.logger ?? (() => undefined);
  const title = options.title ?? createTitlePresenter();
  const foreground = options.foreground ?? createForegroundState();

  const preferences: TaskNotificationPreferenceStore = createTaskNotificationPreferenceStore({
    scope: options.scope(),
    ...(options.storage !== undefined ? { storage: options.storage } : {})
  });

  const coordinator: ReminderCoordinator =
    options.coordinator ??
    createReminderCoordinator({
      key: `${options.scope().instanceId}|${options.scope().basePath}|${options.scope().dataScopeId}`,
      locks:
        options.locks !== undefined
          ? options.locks
          : (globalThis.navigator as unknown as { locks?: ReminderLocks | null } | undefined)?.locks ?? null,
      createChannel:
        options.createChannel ??
        ((name) => {
          if (typeof globalThis.BroadcastChannel !== "function") return null;
          const channel = new globalThis.BroadcastChannel(name);
          return {
            get onmessage() {
              return channel.onmessage as ((event: { data: unknown }) => void) | null;
            },
            set onmessage(listener) {
              channel.onmessage = listener ? (event) => listener({ data: event.data }) : null;
            },
            postMessage: (message) => channel.postMessage(message),
            close: () => channel.close()
          };
        })
    });

  let permission: TaskNotificationPermission =
    options.presenter.platform === "web" ? "unsupported" : options.presenter.permission();
  let sourceStatus: TaskNotificationSnapshot["source"]["status"] = options.reader ? "idle" : "unavailable";
  let sourceReason: string | null = options.reader ? null : "任务历史读面不可用，通知暂不生效";
  let pending = { succeeded: 0, failed: 0 };
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let batch: { succeeded: number; failed: number; target?: TaskNotificationTarget } | null = null;
  const deliveries: TaskNotificationDelivery[] = [];
  let disposed = false;
  let started = false;
  const listeners = new Set<() => void>();
  let snapshot: TaskNotificationSnapshot | null = null;

  const channels = (prefs: TaskNotificationPreferences) => {
    const titleState: TaskNotificationChannelState = {
      enabled: prefs.titleEnabled,
      status: "ready",
      reason: null
    };
    const systemChannel: TaskNotificationChannelState =
      options.presenter.platform === "web"
        ? { enabled: false, status: "unsupported", reason: "浏览器不支持系统通知渠道" }
        : (() => {
            const userEnabled = prefs.systemEnabled;
            if (permission === "unsupported") {
              return { enabled: userEnabled, status: "unsupported" as const, reason: "当前桌面壳不支持系统通知" };
            }
            if (permission === "denied") {
              return {
                enabled: userEnabled,
                status: "blocked" as const,
                reason: "系统通知权限被拒绝，请在系统设置中允许"
              };
            }
            if (!userEnabled) {
              return { enabled: false, status: "blocked" as const, reason: "系统通知未开启" };
            }
            if (permission !== "granted") {
              return { enabled: userEnabled, status: "blocked" as const, reason: "尚未获得系统通知权限" };
            }
            return { enabled: true, status: "ready" as const, reason: null };
          })();
    return { title: titleState, system: systemChannel };
  };

  const buildSnapshot = (): TaskNotificationSnapshot => {
    const prefs = preferences.getSnapshot();
    return {
      preferences: prefs.preferences,
      platform: options.presenter.platform,
      channels: channels(prefs.preferences),
      permission,
      pending: { ...pending },
      source: { status: sourceStatus, reason: sourceReason },
      storageError: prefs.diagnostic?.message ?? null
    };
  };

  const publish = () => {
    if (disposed) return;
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const rememberDelivery = (input: TaskNotificationDelivery) => {
    deliveries.push(input);
    if (deliveries.length > MAX_DELIVERIES) deliveries.shift();
  };

  const isBackground = () => foreground.isBackground();

  /** 是否允许该类事件发送（类别开关 + 渠道可用 + 后台 + 本页是 owner）。 */
  const allowed = (state: "succeeded" | "failed", channel: TaskNotificationChannel) => {
    const prefs = preferences.getSnapshot().preferences;
    if (!prefs.categories[state]) return false;
    if (!isBackground()) return false;
    if (coordinator.role() !== "owner") return false;
    if (coordinator.isPeerForeground()) return false;
    const stateOfChannel = channels(prefs)[channel];
    return stateOfChannel.enabled && stateOfChannel.status === "ready";
  };

  const flushBatch = async () => {
    batchTimer = null;
    const current = batch;
    batch = null;
    if (!current || disposed) return;
    // 发送前再次检查：批次等待期间可能已回到前台或关闭渠道。
    if (!isBackground() || coordinator.role() !== "owner" || coordinator.isPeerForeground()) return;
    const prefs = preferences.getSnapshot().preferences;
    const systemReady = channels(prefs).system;
    if (!systemReady.enabled || systemReady.status !== "ready") return;
    const result = await options.presenter.notify({
      succeeded: current.succeeded,
      failed: current.failed,
      ...(current.target ? { target: current.target } : {})
    });
    if (!result.ok) {
      log({ event: "task-notification-send-failed", error: result.error });
      return;
    }
    if (current.succeeded > 0) {
      rememberDelivery({
        taskKey: current.target?.taskKey ?? "*",
        state: "succeeded",
        attempt: null,
        channel: "system",
        at: now()
      });
    }
    if (current.failed > 0) {
      rememberDelivery({
        taskKey: current.target?.taskKey ?? "*",
        state: "failed",
        attempt: null,
        channel: "system",
        at: now()
      });
    }
  };

  const scheduleBatch = () => {
    if (batchTimer !== null) return;
    batchTimer = setTimeout(() => {
      void flushBatch();
    }, batchMs);
    (batchTimer as { unref?: () => void }).unref?.();
  };

  const onResult = (event: TaskResultEvent) => {
    if (disposed) return;
    // 标题渠道：累计到 snapshot，标题只在后台且渠道开启时更新。
    const titleAllowed = allowed(event.state, "title");
    const systemAllowed = allowed(event.state, "system");
    if (!titleAllowed && !systemAllowed) return;

    if (titleAllowed) {
      pending = {
        succeeded: pending.succeeded + (event.state === "succeeded" ? 1 : 0),
        failed: pending.failed + (event.state === "failed" ? 1 : 0)
      };
      title.render(pending);
      rememberDelivery({
        taskKey: event.taskKey,
        state: event.state,
        attempt: event.attempt,
        channel: "title",
        at: now()
      });
    }

    if (systemAllowed) {
      batch = {
        succeeded: (batch?.succeeded ?? 0) + (event.state === "succeeded" ? 1 : 0),
        failed: (batch?.failed ?? 0) + (event.state === "failed" ? 1 : 0),
        ...(batch?.target ?? event.target ? { target: batch?.target ?? event.target } : {})
      };
      scheduleBatch();
    }
    publish();
  };

  const source: TaskResultSource = createTaskResultSource({
    reader: options.reader ?? null,
    scope: () => `${options.scope().instanceId}|${options.scope().basePath}|${options.scope().dataScopeId}`,
    ...(options.accept ? { accept: options.accept } : {}),
    onResult,
    logger: log
  });
  source.subscribe(() => {
    const status = source.getStatus();
    sourceStatus = status.status;
    sourceReason = status.reason;
    publish();
  });

  /** 前台恢复：取消未发送批次、清标题计数、恢复标题。 */
  const clearPending = () => {
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    batch = null;
    pending = { succeeded: 0, failed: 0 };
    title.clear();
    publish();
  };

  const unsubscribeForeground = broadcastForeground(coordinator, foreground, (background) => {
    if (!background) clearPending();
    publish();
  });
  const unsubscribeCoordinator = coordinator.subscribe(publish);
  const unsubscribePreferences = preferences.subscribe(publish);

  return {
    getSnapshot: () => (snapshot ??= buildSnapshot()),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions: {
      setCategory(category, enabled) {
        const current = preferences.getSnapshot().preferences;
        preferences.setPreferences({
          ...current,
          categories: { ...current.categories, [category]: enabled }
        });
      },
      async setChannel(channel, enabled) {
        const current = preferences.getSnapshot().preferences;
        preferences.setPreferences({
          ...current,
          ...(channel === "title" ? { titleEnabled: enabled } : { systemEnabled: enabled })
        });
        if (channel === "title" && !enabled) {
          // 关闭标题渠道：恢复原标题并停止累计（已保存偏好不回滚）。
          clearPending();
        }
        if (channel === "system" && enabled && permission === "prompt") {
          // 只有用户主动开启且尚未询问时才申请。
          permission = await options.presenter.requestPermission();
          publish();
        }
        publish();
      },
      async requestPermission() {
        permission = await options.presenter.requestPermission();
        publish();
      },
      async sendTestNotification() {
        return options.presenter.notify({ succeeded: 0, failed: 0 });
      },
      async refreshPermission() {
        const next = await options.presenter.refreshPermission();
        if (next !== permission) {
          permission = next;
          publish();
        }
      },
      clearPending
    },
    deliveries: () => deliveries,
    async start() {
      if (disposed || started) return;
      started = true;
      // 基础标题由 title presenter 在构造时读取；显式传入时以它为准。
      if (options.baseTitle !== undefined) title.setBaseTitle(options.baseTitle);
      await coordinator.claim();
      await options.presenter.refreshPermission().then((next) => {
        permission = next;
        publish();
      }).catch(() => undefined);
      await source.start();
      publish();
    },
    async handleScopeChange() {
      preferences.setScope(options.scope());
      pending = { succeeded: 0, failed: 0 };
      title.clear();
      await source.restart();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeForeground();
      unsubscribeCoordinator();
      unsubscribePreferences();
      source.stop();
      if (batchTimer !== null) clearTimeout(batchTimer);
      batchTimer = null;
      title.clear();
      coordinator.dispose();
      foreground.dispose();
      preferences.dispose();
      listeners.clear();
    }
  };
}

export type { TaskExecutionSummary };
