/**
 * 前后台状态与标签页 owner 协调（change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.3 / design D8）。
 *
 * 覆盖 claim 不能阻塞（真实浏览器有 Web Locks 时会因回调持锁而挂起，必须立即 resolve
 * 决定）、锁释放后其它实例可接管、实例级 releaseWaiters 不互相干扰。
 *
 * 纯逻辑，不采集渲染。
 */
import { describe, expect, it } from "vitest";
import {
  createReminderCoordinator,
  createForegroundState,
  broadcastForeground,
  type ReminderLocks,
  type ReminderBroadcast
} from "./coordination.js";

/** 模拟真实 Web Locks：`ifAvailable` 可用时回调并持锁到回调 promise resolve；不可用则跳过。 */
function createAsyncLocks(): ReminderLocks & {
  /** 释放指定锁，允许下一个 claim。 */
  release(name: string): void;
  /** 当前持有的锁名。 */
  current(): string | null;
  /** 等待指定锁被释放（用于测试同步断言前确保微任务已清）。 */
  untilReleased(name: string): Promise<void>;
} {
  const holders = new Map<string, () => void>();
  return {
    async request<T>(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T> {
      if (holders.has(name)) return undefined as T;
      // 回调返回的 promise（协调器内部的 hold）直到 release/dispose 才 resolve；
      // 锁在此期间一直占用，request 的返回 promise 也随之 pending。
      holders.set(name, () => undefined);
      const result = await callback({ name });
      holders.delete(name);
      return result;
    },
    release(name) {
      const resolve = holders.get(name);
      if (resolve) {
        resolve();
        holders.delete(name);
      }
    },
    current: () => (holders.size === 0 ? null : holders.keys().next().value ?? null),
    async untilReleased(name) {
      while (holders.has(name)) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };
}

function memoryChannelFactory(): { create: (name: string) => ReminderBroadcast } {
  const channels: ReminderBroadcast[] = [];
  return {
    create: (_name) => {
      const channel: ReminderBroadcast = {
        postMessage(message: unknown) {
          for (const ch of channels) {
            if (ch !== channel && ch.onmessage) ch.onmessage({ data: message });
          }
        },
        close() {},
        onmessage: null
      };
      channels.push(channel);
      return channel;
    }
  };
}

function fakeDoc(initialHidden: boolean, initialFocused: boolean) {
  const listeners = new Map<string, (() => void)[]>();
  const addEventListener = (type: string, listener: () => void) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(listener);
  };
  const removeEventListener = (type: string, listener: () => void) => {
    const arr = listeners.get(type);
    if (arr) {
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  let isHidden = initialHidden;
  let isFocused = initialFocused;
  return {
    get hidden() { return isHidden; },
    hasFocus: () => isFocused,
    addEventListener,
    removeEventListener,
    setHidden(next: boolean) {
      isHidden = next;
      fire("visibilitychange");
    },
    setFocused(next: boolean) {
      isFocused = next;
      fire("blur");
    }
  };
}

describe("标签页 owner 协调", () => {
  it("claim 在真实 Web Locks 下立即 resolve，锁仍保持到 release", async () => {
    const locks = createAsyncLocks();
    const c = createReminderCoordinator({ key: "k", locks });
    const claimed = c.claim();
    const role = await Promise.race([claimed, new Promise((_r, rej) => setTimeout(() => rej("timeout"), 200))]);
    expect(role).toBe("owner");
    // 同页再次 claim 仍是 owner（幂等）。
    expect(await c.claim()).toBe("owner");
    // 锁仍持有。
    expect(locks.current()).toBe("woohaa-task-notifications:k");
    // release 后锁释放。
    await c.release();
    await locks.untilReleased("woohaa-task-notifications:k");
    expect(locks.current()).toBeNull();
    expect(c.role()).toBe("standby");
  });

  it("另一实例尝试取得同一锁时退为 standby；释放后新实例可接管", async () => {
    const locks = createAsyncLocks();
    const first = createReminderCoordinator({ key: "k", locks });
    await first.claim();
    const second = createReminderCoordinator({ key: "k", locks });
    expect(await second.claim()).toBe("standby");
    await first.release();
    await locks.untilReleased("woohaa-task-notifications:k");
    const third = createReminderCoordinator({ key: "k", locks });
    expect(await third.claim()).toBe("owner");
  });

  it("不同协调键互不干扰", async () => {
    const locks = createAsyncLocks();
    const a = createReminderCoordinator({ key: "a", locks });
    const b = createReminderCoordinator({ key: "b", locks });
    expect(await a.claim()).toBe("owner");
    expect(await b.claim()).toBe("owner");
  });

  it("无 Web Locks 时退化为单标签页 owner", async () => {
    const c = createReminderCoordinator({ key: "k", locks: null });
    expect(await c.claim()).toBe("owner");
    await c.release();
    expect(c.role()).toBe("standby");
  });

  it("broadcastForeground 前后台状态影响 peerForeground", () => {
    const locks = createAsyncLocks();
    const c = createReminderCoordinator({ key: "k", locks });
    const doc = fakeDoc(false, true);
    const fg = createForegroundState({ doc: doc as unknown as Document });
    const updates: boolean[] = [];
    const unsubscribe = broadcastForeground(
      c,
      fg,
      (background) => updates.push(background)
    );
    expect(c.isPeerForeground()).toBe(true);
    // 切走
    doc.setHidden(true);
    expect(c.isPeerForeground()).toBe(false);
    // 返回
    doc.setHidden(false);
    expect(c.isPeerForeground()).toBe(true);
    unsubscribe();
    fg.dispose();
  });

  it("owner 的 peerForeground 为 true 时抑制后台提醒", async () => {
    const locks = createAsyncLocks();
    const c = createReminderCoordinator({ key: "k", locks });
    await c.claim();
    expect(c.role()).toBe("owner");
    c.setPeerForeground(true);
    expect(c.isPeerForeground()).toBe(true);
    c.setPeerForeground(false);
    expect(c.isPeerForeground()).toBe(false);
    await c.release();
  });

  it("dispose 释放锁并清资源", async () => {
    const locks = createAsyncLocks();
    const c = createReminderCoordinator({ key: "k", locks });
    await c.claim();
    c.dispose();
    await locks.untilReleased("woohaa-task-notifications:k");
    expect(locks.current()).toBeNull();
  });

  it("频道广播：前台标签页让 owner 抑制提醒", async () => {
    const { create } = memoryChannelFactory();
    const owner = createReminderCoordinator({ key: "k", locks: null, createChannel: create });
    const standby = createReminderCoordinator({ key: "k", locks: null, createChannel: create });
    // 先让 standby 发布前台状态（它未 claim，不是 owner，只发自身状态）。
    const fg = createForegroundState({ doc: fakeDoc(false, true) as unknown as Document });
    broadcastForeground(standby, fg, () => undefined);
    // owner 这时看到 peerForeground = true（standby 在前台）。
    await owner.claim();
    expect(owner.isPeerForeground()).toBe(true);
    // standby 切走
    fg.dispose();
    // 释放旧的 standby foreground 消息需让 owner 收到 background
    broadcastForeground(standby, createForegroundState({ doc: fakeDoc(true, false) as unknown as Document }), () => undefined);
    // standby 的 background 消息会发到 owner 的 channel。
    expect(owner.isPeerForeground()).toBe(false);
    owner.dispose();
  });
});
