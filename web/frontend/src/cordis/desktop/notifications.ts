/**
 * 桌面壳通知适配（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.3 / design D9）。
 *
 * 只经**既有** `woohaa-native` 受控协议（token + main webview 来源校验）调用最小通知操作：
 * 能力查询、权限查询/申请、发送。不开放通用 IPC，也不把原生层当任务状态源。
 *
 * 平台支持按 `notification_capability` 的独立版本判断，不靠 UA 或窗口能力推断。
 * 失败一律返回安全原因，绝不把通知失败改写成任务失败。
 */
import type { DesktopNotificationPort } from "../services/notifications/presenter.js";
import type { NotificationClick, NotificationClickTarget } from "../services/notifications/click-landing.js";
import { nativeProtocolUrl } from "../../desktop/native-protocol.js";

/** 原生通知能力版本（与 `desktop/src/notifications.rs` 对齐）。 */
export const NATIVE_NOTIFICATION_CAPABILITY_VERSION = 1;

type NativeBootstrap = { protocol: string; token: string };

type NativeNotificationCapability = {
  version: number;
  click_restore: boolean;
  platforms: readonly string[];
};

/** 桌面端口只暴露四种确定状态；原生 `unknown` 归入 `prompt`（尚未询问）。 */
type NativePermission = "prompt" | "granted" | "denied" | "unsupported";

type NativeEnvelope<T> = { ok: true; value: T } | { ok: false; error: string };

export type DesktopNotificationAdapterOptions = {
  /** 注入目标全局（测试）；缺省 `globalThis`。 */
  target?: typeof globalThis;
  /** 注入请求实现（测试）；缺省同步 XHR + token 头。 */
  request?: (method: string, args: readonly unknown[]) => NativeEnvelope<unknown>;
};

function nativeBootstrap(target: typeof globalThis): NativeBootstrap | undefined {
  return (target as typeof globalThis & { __WOOHAA_NATIVE__?: NativeBootstrap }).__WOOHAA_NATIVE__;
}

/** 默认请求：与画布 native RPC 共用同一协议路径与 token 头。 */
function defaultRequest(target: typeof globalThis, token: string) {
  return (method: string, args: readonly unknown[]): NativeEnvelope<unknown> => {
    const xhr = new target.XMLHttpRequest();
    xhr.open("POST", nativeProtocolUrl("rpc", target), false);
    xhr.setRequestHeader("X-Woohaa-Token", token);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify({ method, args }));
    if (xhr.status !== 200) throw new Error(`桌面通知通信失败 (${xhr.status})`);
    return JSON.parse(xhr.responseText) as NativeEnvelope<unknown>;
  };
}

function mapPermission(value: unknown): NativePermission {
  switch (value) {
    case "granted":
    case "denied":
    case "prompt":
      return value;
    case "unknown":
      return "prompt";
    default:
      return "unsupported";
  }
}

/**
 * 探测桌面通知能力。
 *
 * 返回 `null` 表示当前不是桌面壳 / 该壳没有通知能力（浏览器或旧桌面产物）：
 * 调用方应回退到 Web presenter，而不是假装支持系统通知。
 */
export function createDesktopNotificationPort(
  options: DesktopNotificationAdapterOptions = {}
): DesktopNotificationPort | null {
  const target = options.target ?? globalThis;
  const bootstrap = nativeBootstrap(target);
  if (!bootstrap || bootstrap.protocol !== "woohaa-native-v1") return null;
  const request = options.request ?? defaultRequest(target, bootstrap.token);

  // 能力探测失败（旧桌面产物没有该能力）→ 视为无通知能力。
  try {
    const capability = request("notification_capability", []);
    if (!capability.ok) return null;
    const value = capability.value as NativeNotificationCapability;
    if (!value || value.version !== NATIVE_NOTIFICATION_CAPABILITY_VERSION) return null;
  } catch {
    return null;
  }

  const permission = async (): Promise<NativePermission> => {
    const result = request("notification_permission", []);
    if (!result.ok) return "unsupported";
    return mapPermission((result.value as { permission?: unknown }).permission);
  };

  /**
   * 任务 8.4：取走原生待处理的点击。
   *
   * 原生侧在点击后恢复/聚焦窗口；前端在重新获得焦点时取一次。目标在这里再做一次形状
   * 校验（防御性，不信任回传），非法值降级为「无目标」→ 历史列表。
   */
  const takeClick = (): NotificationClick | null => {
    try {
      const result = request("notification_take_click", []);
      if (!result.ok) return null;
      const value = result.value as { clicked?: unknown; test?: unknown; target?: unknown };
      if (value?.clicked !== true) return null;
      return { test: value.test === true, target: clickTarget(value.target) };
    } catch {
      return null;
    }
  };

  const clickSubscribers = new Set<(click: NotificationClick) => void>();
  const drainClick = () => {
    const click = takeClick();
    if (!click) return;
    for (const handler of clickSubscribers) handler(click);
  };
  const focusTarget = target as unknown as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  let focusBound = false;
  const subscribeClicks = (handler: (click: NotificationClick) => void) => {
    clickSubscribers.add(handler);
    if (!focusBound) {
      focusTarget.addEventListener?.("focus", drainClick);
      focusBound = true;
      // 页面在点击之后才加载时，补取一次。
      drainClick();
    }
    return () => {
      clickSubscribers.delete(handler);
      if (clickSubscribers.size === 0 && focusBound) {
        focusTarget.removeEventListener?.("focus", drainClick);
        focusBound = false;
      }
    };
  };

  return {
    permission,
    async requestPermission() {
      const result = request("notification_request_permission", []);
      if (!result.ok) return "unsupported";
      return mapPermission((result.value as { permission?: unknown }).permission);
    },
    async notify(input) {
      const payload = {
        test: false,
        succeeded: input.succeeded,
        failed: input.failed,
        ...(input.target ? { target: toNativeTarget(input.target) } : {})
      };
      try {
        const result = request("notification_show", [JSON.stringify(payload)]);
        return result.ok ? { ok: true as const } : { ok: false as const, error: safeError(result.error) };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "桌面通知发送失败" };
      }
    },
    subscribeClicks
  };
}

/** 稳定 ID 形状：与原生侧 `is_stable_id` 对齐（无空白、无 URL 特征、有长度上界）。 */
function isStableId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function clickTarget(value: unknown): NotificationClickTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const taskKey = record.taskKey;
  if (typeof taskKey !== "string" || !isStableId(taskKey)) return null;
  const canvasId = typeof record.canvasId === "string" && isStableId(record.canvasId) ? record.canvasId : undefined;
  const nodeId = typeof record.nodeId === "string" && isStableId(record.nodeId) ? record.nodeId : undefined;
  return { taskKey, ...(canvasId ? { canvasId } : {}), ...(nodeId ? { nodeId } : {}) };
}

/** 目标只保留稳定身份：不传 prompt、参数、媒体地址或任意 URL。 */
function toNativeTarget(target: { taskKey: string; canvasId?: string; nodeId?: string }) {
  return {
    task_key: target.taskKey,
    ...(target.canvasId ? { canvas_id: target.canvasId } : {}),
    ...(target.nodeId ? { node_id: target.nodeId } : {})
  };
}

/** 原生错误只回安全文案（不转发底层细节以外的内容）。 */
function safeError(error: string): string {
  if (/budget/i.test(error)) return "通知内容超出预算";
  if (/permission/i.test(error)) return "系统通知权限未授予";
  if (/unsupported/i.test(error)) return "当前桌面壳不支持系统通知";
  return "系统通知发送失败";
}
