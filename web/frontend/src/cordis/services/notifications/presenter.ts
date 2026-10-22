/**
 * 通知服务的平台装配
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.4 / design D9）。
 *
 * 浏览器只提供标题渠道；系统通知只在桌面壳（受控原生能力）存在。这里把平台差异收敛成
 * 一个 `PlatformPresenter`，服务本身不判断 UA、也不直接触碰原生通道。
 */
import type { PlatformPresenter } from "./service.js";
import type { NotificationClick } from "./click-landing.js";

/** 浏览器：只有标题渠道，系统通知明确 unsupported（不伪装成可开启）。 */
export function createWebPresenter(): PlatformPresenter {
  return {
    platform: "web",
    permission: () => "unsupported",
    async requestPermission() {
      return "unsupported";
    },
    async refreshPermission() {
      return "unsupported";
    },
    async notify() {
      return { ok: false as const, error: "浏览器不支持系统通知渠道" };
    }
  };
}

/**
 * 桌面壳通知端口（由桌面适配层实现；浏览器下不存在）。
 *
 * 只暴露最小能力：权限查询/申请、发送。真正的边界校验（token/来源/字段预算）在原生侧。
 */
export type DesktopNotificationPort = {
  permission(): Promise<"granted" | "denied" | "prompt" | "unsupported">;
  requestPermission(): Promise<"granted" | "denied" | "prompt" | "unsupported">;
  notify(input: {
    succeeded: number;
    failed: number;
    /** 只携带稳定任务目标；不含 prompt/参数/媒体或任意 URL。 */
    target?: { taskKey: string; canvasId?: string; nodeId?: string };
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 任务 8.4：订阅原生通知点击（可选）。
   *
   * 旧桌面产物没有这条通道，因此保持可选；宿主只在窗口重新获得焦点时取一次待处理点击，
   * 不引入轮询。返回取消订阅。
   */
  subscribeClicks?(handler: (click: NotificationClick) => void): () => void;
};

/** 桌面 presenter：系统通知 + 标题渠道并存。 */
export function createDesktopPresenter(port: DesktopNotificationPort): PlatformPresenter {
  let current: "granted" | "denied" | "prompt" | "unsupported" = "unsupported";
  const map = (value: "granted" | "denied" | "prompt" | "unsupported") =>
    value === "unsupported" ? ("unsupported" as const) : value;
  return {
    platform: "desktop",
    permission: () => map(current),
    async requestPermission() {
      current = await port.requestPermission();
      return map(current);
    },
    async refreshPermission() {
      current = await port.permission();
      return map(current);
    },
    async notify(input) {
      return port.notify(input);
    }
  };
}
