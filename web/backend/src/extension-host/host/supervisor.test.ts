import { describe, expect, it } from "vitest";
import type { IsolatedController } from "./controller.js";
import type { InstanceExit } from "./manager.js";
import { backoffDelay, createExtensionSupervisor, CRASH_WINDOW_MS, RESTART_BACKOFF_MAX_MS, RESTART_STABLE_MS } from "./supervisor.js";

const exit: InstanceExit = { instanceId: "x#1", reason: "exit", exitCode: 1, signal: null };

function harness(overrides: { activate?: () => Promise<void>; observation?: () => boolean } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const activations: string[] = [];
  const quarantines: string[] = [];
  const unquarantines: string[] = [];
  let active = false;
  const controller = {
    extensionId: "fx",
    active: () => (active ? ({} as never) : null),
    values: () => ({ k: 1 }),
    directory: () => "/v1",
    activate: async (_values: unknown, directory: string) => {
      activations.push(directory);
      if (overrides.activate) await overrides.activate();
      active = true;
    }
  } as unknown as IsolatedController;
  const supervisor = createExtensionSupervisor({
    controller,
    log: () => undefined,
    now: () => clock,
    random: () => 0.5, // 抖动为 0
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    onObservationCrash: () => overrides.observation?.() ?? false,
    onQuarantine: (id) => void quarantines.push(id),
    onUnquarantine: (id) => void unquarantines.push(id)
  });
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  /** 推进时钟并触发到期的计时器。 */
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
  };
  const crash = async () => {
    active = false;
    supervisor.handleCrash(exit);
    await flush();
  };
  return { supervisor, activations, quarantines, unquarantines, advance, crash, flush, timers, pending: () => timers.map((timer) => timer.at - clock) };
}

describe("退避时序", () => {
  it("1s → 2s → 4s … 上限 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoffDelay(20)).toBe(RESTART_BACKOFF_MAX_MS);
  });

  it("抖动在 ±20% 内", async () => {
    const delays: number[] = [];
    for (const random of [0, 1]) {
      const timers: number[] = [];
      const supervisor = createExtensionSupervisor({
        controller: { extensionId: "fx", active: () => null, values: () => ({}), directory: () => "/v1", activate: async () => undefined } as never,
        log: () => undefined,
        random: () => random,
        setTimer: (_fn, ms) => {
          timers.push(ms);
          return timers.length;
        },
        clearTimer: () => undefined
      });
      supervisor.handleCrash(exit);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      delays.push(timers[0]!);
    }
    expect(delays).toEqual([800, 1200]);
  });
});

describe("崩溃后自动重启", () => {
  it("崩溃 → 1s 后以同一目录与配置重启；稳定 60s 后退避归零", async () => {
    const h = harness();
    await h.crash();
    expect(h.supervisor.snapshot()).toMatchObject({ state: "restarting", crashCount: 1, nextRestartMs: 1000 });
    await h.advance(999);
    expect(h.activations).toEqual([]);
    await h.advance(1);
    expect(h.activations).toEqual(["/v1"]);
    expect(h.supervisor.snapshot().state).toBe("running");
    // 第二次崩溃（未稳定）退避翻倍。
    await h.crash();
    expect(h.supervisor.snapshot().nextRestartMs).toBe(2000);
    await h.advance(2000);
    await h.advance(RESTART_STABLE_MS);
    // 稳定后再崩溃：退避回到 1s（窗口仍记着前两次之外的时间已过 → 由窗口自然过期决定是否隔离）。
    await h.advance(CRASH_WINDOW_MS);
    await h.crash();
    expect(h.supervisor.snapshot()).toMatchObject({ nextRestartMs: 1000, crashCount: 1 });
  });

  it("重启本身激活失败：计入窗口并继续退避", async () => {
    let fail = true;
    const h = harness({ activate: async () => {
      if (fail) throw new Error("boom");
    } });
    await h.crash();
    await h.advance(1000);
    expect(h.supervisor.snapshot()).toMatchObject({ state: "restarting", crashCount: 2, nextRestartMs: 2000 });
    fail = false;
    await h.advance(2000);
    expect(h.supervisor.snapshot().state).toBe("running");
  });
});

describe("熔断与解除", () => {
  it("5 分钟内第 3 次崩溃 → quarantined，停止重启；解除后清空窗口并重新激活", async () => {
    const h = harness();
    await h.crash();
    await h.advance(1000);
    await h.crash();
    await h.advance(2000);
    await h.crash();
    expect(h.supervisor.quarantined()).toBe(true);
    expect(h.quarantines).toEqual(["fx"]);
    expect(h.supervisor.snapshot()).toMatchObject({ state: "quarantined", crashCount: 3 });
    expect(h.supervisor.snapshot().quarantinedAt).not.toBeNull();
    expect(h.timers).toHaveLength(0);
    const before = h.activations.length;
    await h.advance(RESTART_BACKOFF_MAX_MS * 3);
    expect(h.activations.length).toBe(before);
    // 隔离期间再收到崩溃信号不再计数、不重启。
    h.supervisor.handleCrash(exit);
    await h.flush();
    expect(h.supervisor.snapshot().crashCount).toBe(3);
    await h.supervisor.unquarantine("principal:admin");
    // 接了控制面：由控制面按 desiredEnabled 重新协调激活，supervisor 自己不激活。
    expect(h.unquarantines).toEqual(["fx"]);
    expect(h.activations.length).toBe(before);
    expect(h.supervisor.snapshot()).toMatchObject({ state: "idle", crashCount: 0, quarantinedAt: null });
  });

  it("窗口外的崩溃不累计：间隔超过 5 分钟的三次崩溃不隔离", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await h.crash();
      await h.advance(CRASH_WINDOW_MS + 1);
    }
    expect(h.supervisor.quarantined()).toBe(false);
  });

  it("换版本 reset：解除隔离并清空窗口（不自动激活）", async () => {
    const h = harness();
    await h.crash();
    await h.advance(1000);
    await h.crash();
    await h.advance(2000);
    await h.crash();
    const before = h.activations.length;
    h.supervisor.reset();
    expect(h.supervisor.quarantined()).toBe(false);
    expect(h.unquarantines).toEqual(["fx"]);
    expect(h.supervisor.snapshot().crashCount).toBe(0);
    expect(h.activations.length).toBe(before);
  });
});

describe("与 P1 观察期衔接", () => {
  it("观察期内崩溃且 Manager 接手回滚：不重启、不隔离", async () => {
    const h = harness({ observation: () => true });
    await h.crash();
    expect(h.supervisor.snapshot().state).toBe("idle");
    expect(h.timers).toHaveLength(0);
    await h.advance(RESTART_BACKOFF_MAX_MS);
    expect(h.activations).toEqual([]);
  });

  it("没有上一版本（Manager 不接手）：按普通崩溃退避，满阈值隔离", async () => {
    const h = harness({ observation: () => false });
    await h.crash();
    expect(h.supervisor.snapshot().state).toBe("restarting");
  });
});

describe("主动停用", () => {
  it("handleDeactivated 取消待重启", async () => {
    const h = harness();
    await h.crash();
    h.supervisor.handleDeactivated();
    await h.advance(RESTART_BACKOFF_MAX_MS);
    expect(h.activations).toEqual([]);
    expect(h.supervisor.snapshot().state).toBe("idle");
  });
});
