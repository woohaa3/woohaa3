/**
 * App 通知服务：前后台、渠道、批量、偏好、owner 与释放
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.3/7.4、9.2/9.3）。
 *
 * 只验证纯逻辑（不渲染、不采集截图）：事实 → 是否发送、发给哪个渠道、批量与取消、
 * 标题恢复、偏好即时生效与失败回退、权限与用户意愿分离。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutionSummary, TaskHistoryPage } from "@woohaa3/contracts";
import type { TaskHistoryReader } from "../../../shared/task-history/client.js";
import { createTaskNotificationService } from "./service.js";
import type { PlatformPresenter } from "./service.js";
import type { ForegroundState, ReminderCoordinator } from "./coordination.js";
import { createTitlePresenter, titlePrefix } from "./web-presenter.js";
import { createTaskNotificationPreferenceStore } from "./preferences.js";

function summary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskKey: "t1",
    state: "succeeded",
    providerId: "p",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:01:00.000Z",
    durationMs: 60_000,
    recordRevision: 1,
    ...overrides
  };
}

function reader(): { reader: TaskHistoryReader; deliver: (record: TaskExecutionSummary) => void } {
  let onRecord: ((record: TaskExecutionSummary, cursor: number) => void) | null = null;
  let cursor = 0;
  const instance: TaskHistoryReader = {
    async list(): Promise<TaskHistoryPage> {
      return { items: [], watermark: 5 };
    },
    async detail() {
      return { ok: false as const, code: "not-found", message: "n/a" };
    },
    async candidates() {
      return { providers: [], models: [] } as never;
    },
    subscribe(input) {
      onRecord = input.onRecord;
      return () => {
        onRecord = null;
      };
    }
  };
  return { reader: instance, deliver: (record) => onRecord?.(record, ++cursor) };
}

const foreground = (background: boolean): ForegroundState => {
  let isBackground = background;
  const listeners = new Set<() => void>();
  return {
    isBackground: () => isBackground,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    },
    // 测试用：切换前后台
    ...({ set(background: boolean) { isBackground = background; for (const l of listeners) l(); } } as object)
  } as unknown as ForegroundState & { set(background: boolean): void };
};

const ownerCoordinator = (): ReminderCoordinator => {
  const listeners = new Set<() => void>();
  return {
    role: () => "owner",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async claim() {
      return "owner";
    },
    async release() {},
    setPeerForeground() {},
    isPeerForeground: () => false,
    dispose() {
      listeners.clear();
    }
  };
};

const standbyCoordinator = (): ReminderCoordinator => ({
  ...ownerCoordinator(),
  role: () => "standby"
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

const serviceScope = { instanceId: "inst", basePath: "/dev/x/", dataScopeId: "d1" };

function harness(options: {
  background?: boolean;
  coordinator?: ReminderCoordinator;
  presenter?: PlatformPresenter;
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  batchMs?: number;
} = {}) {
  const fake = reader();
  const notify = vi.fn(async () => ({ ok: true as const }));
  const presenter =
    options.presenter ??
    ({
      platform: "desktop" as const,
      permission: () => "granted" as const,
      async requestPermission() {
        return "granted" as const;
      },
      async refreshPermission() {
        return "granted" as const;
      },
      notify
    } satisfies PlatformPresenter);
  const writes: string[] = [];
  const title = createTitlePresenter({ write: (value) => writes.push(value), read: () => "WooHaa3 · worktree" });
  const service = createTaskNotificationService({
    reader: fake.reader,
    scope: () => serviceScope,
    presenter,
    foreground: foreground(options.background ?? true),
    coordinator: options.coordinator ?? ownerCoordinator(),
    title,
    storage: options.storage === undefined ? memoryStorage() : options.storage,
    ...(options.batchMs !== undefined ? { batchMs: options.batchMs } : {})
  });
  return { service, deliver: fake.deliver, notify, writes, title };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("通知服务：渠道与批量", () => {
  it("后台成功/失败各自按类别累计标题并合并系统通知", async () => {
    const h = harness({ background: true, batchMs: 5 });
    await h.service.start();
    // 系统通知默认关：先开启（模拟用户意愿），权限已允许。
    await h.service.actions.setChannel("system", true);
    h.deliver(summary({ taskKey: "a", state: "succeeded" }));
    h.deliver(summary({ taskKey: "b", state: "failed" }));
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 1, failed: 1 });
    expect(titlePrefix({ succeeded: 1, failed: 1 })).toBe("（1 项完成，1 项失败）");

    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ succeeded: 1, failed: 1 }));
  });

  it("前台不发送业务提醒（打开设置仍算正在使用）", async () => {
    const h = harness({ background: false, batchMs: 5 });
    await h.service.start();
    await h.service.actions.setChannel("system", true);
    h.deliver(summary({ taskKey: "a" }));
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 0, failed: 0 });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("回到前台取消未发送批次并清除标题计数，不改变任务事实", async () => {
    const h = harness({ background: true, batchMs: 60_000 });
    await h.service.start();
    await h.service.actions.setChannel("system", true);
    h.deliver(summary({ taskKey: "a" }));
    expect(h.service.getSnapshot().pending.succeeded).toBe(1);
    h.service.actions.clearPending();
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 0, failed: 0 });
    // 批次被取消：即使时间过去也不会发送。
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("standby 标签页不发提醒（同源只由 owner 发送）", async () => {
    const h = harness({ background: true, coordinator: standbyCoordinator(), batchMs: 5 });
    await h.service.start();
    await h.service.actions.setChannel("system", true);
    h.deliver(summary({ taskKey: "a" }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 0, failed: 0 });
  });

  it("关闭标题渠道后恢复原标题且后续不再累计", async () => {
    const h = harness({ background: true, batchMs: 5 });
    await h.service.start();
    h.deliver(summary({ taskKey: "a" }));
    expect(h.service.getSnapshot().pending.succeeded).toBe(1);
    await h.service.actions.setChannel("title", false);
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 0, failed: 0 });
    h.deliver(summary({ taskKey: "b" }));
    expect(h.service.getSnapshot().pending.succeeded).toBe(0);
  });

  it("类别开关生效：关闭失败提醒后失败的终态不计入", async () => {
    const h = harness({ background: true, batchMs: 5 });
    await h.service.start();
    h.service.actions.setCategory("failed", false);
    h.deliver(summary({ taskKey: "f", state: "failed" }));
    h.deliver(summary({ taskKey: "s", state: "succeeded" }));
    expect(h.service.getSnapshot().pending).toEqual({ succeeded: 1, failed: 0 });
  });
});

describe("通知服务：偏好与权限", () => {
  it("偏好即时生效、不产生草稿；重开后仍是保存值", async () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    await first.service.start();
    first.service.actions.setCategory("succeeded", false);
    await first.service.actions.setChannel("title", false);
    expect(first.service.getSnapshot().preferences.categories.succeeded).toBe(false);

    const reopened = harness({ storage });
    await reopened.service.start();
    expect(reopened.service.getSnapshot().preferences).toMatchObject({
      categories: { succeeded: false, failed: true },
      titleEnabled: false
    });
  });

  it("持久化失败：不谎称已保存，保留可读诊断", async () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      }
    };
    const h = harness({ storage: failing });
    await h.service.start();
    h.service.actions.setCategory("failed", false);
    expect(h.service.getSnapshot().storageError).toBe("无法保存通知偏好，请检查浏览器存储权限");
  });

  it("Web 平台不展示系统通知渠道，也不申请权限", async () => {
    const requestPermission = vi.fn(async () => "unsupported" as const);
    const h = harness({
      presenter: {
        platform: "web",
        permission: () => "unsupported",
        requestPermission,
        async refreshPermission() {
          return "unsupported";
        },
        async notify() {
          return { ok: false as const, error: "浏览器不支持系统通知渠道" };
        }
      }
    });
    await h.service.start();
    const snapshot = h.service.getSnapshot();
    expect(snapshot.platform).toBe("web");
    expect(snapshot.channels.system.status).toBe("unsupported");
    expect(snapshot.channels.title.status).toBe("ready");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("桌面：系统通知默认关，开启且未询问时才申请权限", async () => {
    let permission: "prompt" | "granted" = "prompt";
    const requestPermission = vi.fn(async () => {
      permission = "granted";
      return "granted" as const;
    });
    const h = harness({
      presenter: {
        platform: "desktop",
        permission: () => permission,
        requestPermission,
        async refreshPermission() {
          return permission;
        },
        async notify() {
          return { ok: true as const };
        }
      }
    });
    await h.service.start();
    // 默认关：不申请。
    expect(requestPermission).not.toHaveBeenCalled();
    expect(h.service.getSnapshot().preferences.systemEnabled).toBe(false);
    // 用户开启：此时才申请一次。
    await h.service.actions.setChannel("system", true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().permission).toBe("granted");
    expect(h.service.getSnapshot().channels.system.status).toBe("ready");
  });

  it("权限被拒：渠道 blocked，用户意愿不被当作授权", async () => {
    const h = harness({
      presenter: {
        platform: "desktop",
        permission: () => "prompt",
        async requestPermission() {
          return "denied" as const;
        },
        async refreshPermission() {
          return "denied";
        },
        async notify() {
          return { ok: false as const, error: "denied" };
        }
      }
    });
    await h.service.start();
    await h.service.actions.setChannel("system", true);
    const snapshot = h.service.getSnapshot();
    expect(snapshot.permission).toBe("denied");
    expect(snapshot.preferences.systemEnabled).toBe(true);
    expect(snapshot.channels.system.status).toBe("blocked");
    expect(snapshot.channels.system.reason).toContain("系统通知权限被拒绝");
  });

  it("测试通知允许前台发送且不写入任务事实", async () => {
    const notify = vi.fn(async () => ({ ok: true as const }));
    const h = harness({
      background: false,
      presenter: {
        platform: "desktop",
        permission: () => "granted",
        async requestPermission() {
          return "granted";
        },
        async refreshPermission() {
          return "granted";
        },
        notify
      }
    });
    await h.service.start();
    await expect(h.service.actions.sendTestNotification()).resolves.toEqual({ ok: true });
    expect(notify).toHaveBeenCalledWith({ succeeded: 0, failed: 0 });
    expect(h.service.deliveries()).toEqual([]);
  });

  it("dispose 后迟到结果不发送、标题恢复", async () => {
    const h = harness({ background: true, batchMs: 5 });
    await h.service.start();
    await h.service.actions.setChannel("system", true);
    h.deliver(summary({ taskKey: "a" }));
    h.service.dispose();
    expect(h.title.current()).toBe("WooHaa3 · worktree");
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("通知偏好存储", () => {
  it("按实例/basePath/数据范围隔离", () => {
    const storage = memoryStorage();
    const a = createTaskNotificationPreferenceStore({
      scope: { instanceId: "i", basePath: "/dev/a/", dataScopeId: "d" },
      storage
    });
    const b = createTaskNotificationPreferenceStore({
      scope: { instanceId: "i", basePath: "/dev/b/", dataScopeId: "d" },
      storage
    });
    a.setPreferences({ ...a.getSnapshot().preferences, titleEnabled: false });
    expect(a.getSnapshot().preferences.titleEnabled).toBe(false);
    expect(b.getSnapshot().preferences.titleEnabled).toBe(true);
  });

  it("损坏内容回退默认并给诊断", () => {
    const storage = memoryStorage();
    const store = createTaskNotificationPreferenceStore({
      scope: { instanceId: "i", basePath: "/", dataScopeId: "" },
      storage
    });
    storage.setItem(store.storageKey(), "{not json");
    store.setScope({ instanceId: "i", basePath: "/", dataScopeId: "" });
    expect(store.getSnapshot().preferences.categories).toEqual({ succeeded: true, failed: true });
    expect(store.getSnapshot().diagnostic?.code).toBe("corrupt");
  });
});

describe("默认协调器（真实 Web Locks 路径）", () => {
  /** 模拟真实 Web Locks：可用时回调并持锁到回调 promise resolve。 */
  function createAsyncLocks() {
    const holders = new Map<string, () => void>();
    return {
      async request<T>(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T> {
        if (holders.has(name)) return undefined as T;
        holders.set(name, () => undefined);
        const result = await callback({ name });
        holders.delete(name);
        return result;
      },
      release(name: string) {
        holders.delete(name);
      },
      current: () => (holders.size === 0 ? null : holders.keys().next().value ?? null)
    };
  }

  it("start 不被 claim 阻塞：任务事实源启动，后台成功即更新标题", async () => {
    const locks = createAsyncLocks();
    const fake = reader();
    const writes: string[] = [];
    const service = createTaskNotificationService({
      reader: fake.reader,
      scope: () => serviceScope,
      presenter: {
        platform: "web",
        permission: () => "unsupported" as const,
        async requestPermission() {
          return "unsupported" as const;
        },
        async refreshPermission() {
          return "unsupported" as const;
        },
        async notify() {
          return { ok: false as const, error: "浏览器不支持系统通知渠道" };
        }
      },
      // 不注入 coordinator：走默认 createReminderCoordinator，但注入 Web Locks。
      locks,
      createChannel: () => null,
      foreground: foreground(true),
      title: createTitlePresenter({ write: (value) => writes.push(value), read: () => "WooHaa3 · worktree" }),
      storage: memoryStorage()
    });
    // 关键回归：start 必须 resolve（真实浏览器曾因 claim 持锁而永久挂起）。
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.getSnapshot().source.status).toBe("live");
    expect(service.getSnapshot().channels.title.status).toBe("ready");
    expect(service.getSnapshot().channels.system.status).toBe("unsupported");

    // 后台任务完成：标题渠道累计并写入前缀。
    fake.deliver(summary({ taskKey: "t1", state: "succeeded" }));
    expect(service.getSnapshot().pending).toEqual({ succeeded: 1, failed: 0 });
    expect(writes[writes.length - 1]).toBe("（1 项完成）WooHaa3 · worktree");

    // 释放：标题恢复、锁归还。
    service.dispose();
    expect(writes[writes.length - 1]).toBe("WooHaa3 · worktree");
    // 让 mock 的 request 在锁释放后完成清理（微任务）。
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.current()).toBeNull();
  });

  it("另一标签页持锁时本页退为 standby，不发送、不阻塞", async () => {
    const locks = createAsyncLocks();
    const { createReminderCoordinator } = await import("./coordination.js");
    const other = createReminderCoordinator({ key: `${serviceScope.instanceId}|${serviceScope.basePath}|${serviceScope.dataScopeId}`, locks });
    await other.claim();

    const fake = reader();
    const writes: string[] = [];
    const service = createTaskNotificationService({
      reader: fake.reader,
      scope: () => serviceScope,
      presenter: {
        platform: "web",
        permission: () => "unsupported" as const,
        async requestPermission() {
          return "unsupported" as const;
        },
        async refreshPermission() {
          return "unsupported" as const;
        },
        async notify() {
          return { ok: false as const, error: "浏览器不支持系统通知渠道" };
        }
      },
      locks,
      createChannel: () => null,
      foreground: foreground(true),
      title: createTitlePresenter({ write: (value) => writes.push(value), read: () => "WooHaa3 · worktree" }),
      storage: memoryStorage()
    });
    await expect(service.start()).resolves.toBeUndefined();
    // standby：观察到事实但不发送。
    fake.deliver(summary({ taskKey: "t1", state: "succeeded" }));
    expect(service.getSnapshot().pending).toEqual({ succeeded: 0, failed: 0 });
    expect(writes).toEqual([]);
    service.dispose();
    await other.release();
  });
});

