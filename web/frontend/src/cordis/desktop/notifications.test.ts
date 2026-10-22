/**
 * 桌面通知适配（原生协议边界）
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.2/8.3 / design D9）。
 *
 * 只通过既有 `woohaa-native` 受控协议调用最小操作：
 * - 无桌面 bootstrap / 旧桌面产物缺能力 → 返回 null，由调用方回退 Web presenter；
 * - 能力版本不匹配 → 不假装支持；
 * - 请求只带稳定身份与计数，不带 prompt/参数/媒体/任意 URL；
 * - 原生错误归一成安全文案，不把通知失败改写成任务失败。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_NOTIFICATION_CAPABILITY_VERSION,
  createDesktopNotificationPort
} from "./notifications.js";

type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

function bootstrapTarget() {
  return {
    __WOOHAA_NATIVE__: { protocol: "woohaa-native-v1", token: "test-token" },
    XMLHttpRequest: function XMLHttpRequest() {
      // 占位：真实请求由注入的 request 代替。
    }
  } as unknown as typeof globalThis;
}

function adapter(responses: Record<string, Envelope>) {
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const request = (method: string, args: readonly unknown[]): Envelope => {
    calls.push({ method, args });
    return responses[method] ?? { ok: false, error: "unsupported" };
  };
  return { calls, port: createDesktopNotificationPort({ target: bootstrapTarget(), request }) };
}

const CAPABILITY: Envelope = {
  ok: true,
  value: { version: NATIVE_NOTIFICATION_CAPABILITY_VERSION, click_restore: true, platforms: ["macos"] }
};

describe("桌面通知适配", () => {
  it("没有桌面 bootstrap 时返回 null（浏览器走 Web presenter）", () => {
    expect(createDesktopNotificationPort({ target: {} as typeof globalThis })).toBeNull();
  });

  it("协议不匹配时返回 null", () => {
    const target = {
      __WOOHAA_NATIVE__: { protocol: "woohaa-native-v0", token: "t" }
    } as unknown as typeof globalThis;
    expect(createDesktopNotificationPort({ target })).toBeNull();
  });

  it("旧桌面产物缺通知能力（或版本不符）时返回 null，不假装支持", () => {
    const target = bootstrapTarget();
    expect(
      createDesktopNotificationPort({
        target,
        request: () => ({ ok: false, error: "Unsupported native method: notification_capability" })
      })
    ).toBeNull();
    expect(
      createDesktopNotificationPort({
        target,
        request: () => ({ ok: true, value: { version: 99, click_restore: false, platforms: [] } })
      })
    ).toBeNull();
  });

  it("能力探测通过后提供最小端口（权限查询/申请/发送）", async () => {
    const { calls, port } = adapter({
      notification_capability: CAPABILITY,
      notification_permission: { ok: true, value: { permission: "prompt" } },
      notification_request_permission: { ok: true, value: { permission: "granted" } },
      notification_show: { ok: true, value: { delivered: true, test: false } }
    });
    expect(port).not.toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["notification_capability"]);
    await expect(port!.permission()).resolves.toBe("prompt");
    await expect(port!.requestPermission()).resolves.toBe("granted");
    await expect(port!.notify({ succeeded: 2, failed: 1 })).resolves.toEqual({ ok: true });
  });

  it("发送 payload 只含计数与稳定身份，不含 prompt/参数/URL", async () => {
    const { calls, port } = adapter({
      notification_capability: CAPABILITY,
      notification_show: { ok: true, value: { delivered: true } }
    });
    await port!.notify({ succeeded: 1, failed: 0, target: { taskKey: "t1", canvasId: "c1", nodeId: "n1" } });
    const show = calls.find((call) => call.method === "notification_show")!;
    const payload = JSON.parse(String(show.args[0])) as Record<string, unknown>;
    expect(payload).toEqual({
      test: false,
      succeeded: 1,
      failed: 0,
      target: { task_key: "t1", canvas_id: "c1", node_id: "n1" }
    });
    // 只有白名单字段。
    expect(Object.keys(payload).sort()).toEqual(["failed", "succeeded", "target", "test"]);
  });

  it("原生错误归一成安全文案（预算/权限/不支持/其它）", async () => {
    const cases: Array<[string, string]> = [
      ["Native notification request exceeds budget", "通知内容超出预算"],
      ["Native notification permission denied", "系统通知权限未授予"],
      ["Native notifications unsupported: plugin", "当前桌面壳不支持系统通知"],
      ["Native notification delivery failed: boom", "系统通知发送失败"]
    ];
    for (const [raw, expected] of cases) {
      const { port } = adapter({
        notification_capability: CAPABILITY,
        notification_show: { ok: false, error: raw }
      });
      await expect(port!.notify({ succeeded: 1, failed: 0 })).resolves.toEqual({ ok: false, error: expected });
    }
  });

  it("权限查询失败不当作已授权", async () => {
    const { port } = adapter({ notification_capability: CAPABILITY });
    await expect(port!.permission()).resolves.toBe("unsupported");
    await expect(port!.requestPermission()).resolves.toBe("unsupported");
  });

  it("通信异常（传输失败）只返回安全结果，不抛出到业务", async () => {
    const port = createDesktopNotificationPort({
      target: bootstrapTarget(),
      request: (method) => {
        if (method === "notification_capability") return CAPABILITY;
        throw new Error("transport down");
      }
    });
    await expect(port!.notify({ succeeded: 1, failed: 0 })).resolves.toEqual({
      ok: false,
      error: "transport down"
    });
  });

  it("原生 unknown 权限归入「尚未询问」，不显示成已授权", async () => {
    const { port } = adapter({
      notification_capability: CAPABILITY,
      notification_permission: { ok: true, value: { permission: "unknown" } }
    });
    await expect(port!.permission()).resolves.toBe("prompt");
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
  });

  it("点击通道：窗口重新聚焦时取走稳定目标且不重复导航", () => {
    const listeners = new Map<string, () => void>();
    const target = {
      __WOOHAA_NATIVE__: { protocol: "woohaa-native-v1", token: "test-token" },
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); }
    } as unknown as typeof globalThis;
    let pending: Envelope = {
      ok: true,
      value: { clicked: true, test: false, target: { taskKey: "t1", canvasId: "c1" } }
    };
    const port = createDesktopNotificationPort({
      target,
      request: (method) => {
        if (method === "notification_capability") return CAPABILITY;
        if (method === "notification_take_click") {
          const value = pending;
          pending = { ok: true, value: { clicked: false, test: false, target: null } };
          return value;
        }
        return { ok: false, error: "unsupported" };
      }
    });
    const seen: unknown[] = [];
    const detach = port!.subscribeClicks!((click) => seen.push(click));
    // 页面在点击之后才加载：订阅时补取一次。
    expect(seen).toEqual([{ test: false, target: { taskKey: "t1", canvasId: "c1" } }]);
    // 已取走 → 之后的聚焦不重复导航。
    listeners.get("focus")!();
    expect(seen).toHaveLength(1);
    detach();
    expect(listeners.has("focus")).toBe(false);
  });

  it("点击目标再做形状校验：URL 或结构不合法降级为无目标", () => {
    const cases: unknown[] = [
      { taskKey: "https://evil.example/x" },
      { taskKey: "" },
      { canvasId: "c1" },
      "not-an-object"
    ];
    for (const rawTarget of cases) {
      const target = {
        __WOOHAA_NATIVE__: { protocol: "woohaa-native-v1", token: "test-token" },
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      } as unknown as typeof globalThis;
      const port = createDesktopNotificationPort({
        target,
        request: (method) =>
          method === "notification_capability"
            ? CAPABILITY
            : { ok: true, value: { clicked: true, test: false, target: rawTarget } }
      });
      const seen: Array<{ test: boolean; target: unknown }> = [];
      port!.subscribeClicks!((click) => seen.push(click));
      expect(seen).toEqual([{ test: false, target: null }]);
    }
  });

  it("点击通道没有待处理点击时不派发（不误导航）", () => {
    const target = {
      __WOOHAA_NATIVE__: { protocol: "woohaa-native-v1", token: "test-token" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    } as unknown as typeof globalThis;
    const port = createDesktopNotificationPort({
      target,
      request: (method) =>
        method === "notification_capability"
          ? CAPABILITY
          : { ok: true, value: { clicked: false, test: false, target: null } }
    });
    const handler = vi.fn();
    port!.subscribeClicks!(handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
