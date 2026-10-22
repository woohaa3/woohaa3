/**
 * 浏览器遥测采集客户端测试（change: 2026-10-20-add-local-client-telemetry，任务 6.7）。
 *
 * 守的是三条硬约束（design D7）：
 * - **不阻塞**：`record()` 同步入队、立即返回，投递在内部被 `void` 掉；
 * - **不抛错**：非法输入、fetch 同步抛错、HTTP 失败、网络异常都不冒泡到调用点；
 * - **不重试**：失败只记账并丢弃整批——重试会在无响应的 intake 上堆请求，且遥测没有幂等键。
 *
 * 另有两条采集策略：有界缓冲（满则丢最旧）与两条"可能来不及完成"的触发路径（`pagehide` /
 * `visibilitychange`）使用 `keepalive`。
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import {
  TELEMETRY_CLIENT_LIMITS,
  activeTelemetryClient,
  createTelemetryClient,
  installTelemetryClient,
  setTelemetryClientForTesting,
  stableTelemetryErrorCode,
  type TelemetryClientTarget
} from "./telemetry-client.js";

function event(overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput {
  return { name: "canvas.edit", result: "success", origin: "browser", ...overrides };
}

type FetchCall = { path: string; init: RequestInit };

/** 记录每次 fetch 的假实现；每个 `respond` 决定该次的响应形态。 */
function fakeFetch(respond: (call: FetchCall) => Promise<Response> | Response = () => response(202)) {
  const calls: FetchCall[] = [];
  const impl = (async (path: string, init: RequestInit) => {
    const call = { path, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

/** 让 `void request.then(...)` 里的失败记账跑完。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** 页面环境假件：收集监听器与定时器，便于手动触发。 */
function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  let timer: (() => void) | null = null;
  const cleared: unknown[] = [];
  const target: TelemetryClientTarget = {
    document: {
      hidden: false,
      visibilityState: "visible",
      addEventListener: (type, handler) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type, handler) => {
        listeners.get(type)?.delete(handler);
      }
    },
    addEventListener: (type, handler) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    setInterval: (handler) => {
      timer = handler;
      return "timer-1";
    },
    clearInterval: (handle) => {
      cleared.push(handle);
      timer = null;
    }
  };
  return {
    target,
    fire(type: string) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    tick: () => timer?.(),
    cleared,
    hasTimer: () => timer !== null
  };
}

describe("有界缓冲", () => {
  it("超过缓冲上限时丢最旧，并计入 droppedOverflow", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({
      fetchImpl: impl,
      target: {},
      bufferLimit: 3,
      flushThreshold: 100
    });
    for (let index = 0; index < 5; index += 1) client.record(event({ errorCode: `code.e${index}` }));

    expect(client.status().queued).toBe(3);
    expect(client.status().droppedOverflow).toBe(2);
    // 没到阈值也不会有定时器：此时一次请求都不该发出。
    expect(calls).toHaveLength(0);
    client.dispose();
  });

  it("status 初始为空", () => {
    const client = createTelemetryClient({ fetchImpl: fakeFetch().impl, target: {}, flushIntervalMs: 1_000_000 });
    expect(client.status()).toEqual({ queued: 0, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 });
    client.dispose();
  });
});

describe("投递触发", () => {
  it("达到阈值立即投递，且请求体是合法 JSON 的批", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, bufferLimit: 100, flushThreshold: 3 });
    client.record(event());
    client.record(event({ result: "failure" }));
    expect(calls).toHaveLength(0);
    client.record(event());

    expect(calls).toHaveLength(1);
    expect(client.status().queued).toBe(0);
    const body = JSON.parse(String(calls[0]?.init.body)) as { events: TelemetryEventInput[] };
    expect(body.events).toHaveLength(3);
    expect(body.events[1]?.result).toBe("failure");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    client.dispose();
  });

  it("单批不超过协议上限，超出部分切成多批", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({
      fetchImpl: impl,
      target: {},
      bufferLimit: 100,
      flushThreshold: 100,
      maxBatchEvents: 2
    });
    for (let index = 0; index < 5; index += 1) client.record(event());
    client.flush();

    expect(calls.map((call) => (JSON.parse(String(call.init.body)) as { events: unknown[] }).events.length)).toEqual([
      2, 2, 1
    ]);
    client.dispose();
  });

  it("flush() 投递后缓冲清空", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, bufferLimit: 100, flushThreshold: 100 });
    client.record(event());
    client.flush();
    expect(calls).toHaveLength(1);
    expect(client.status().queued).toBe(0);
    client.dispose();
  });

  it("定时器到点自动投递", () => {
    const { impl, calls } = fakeFetch();
    const environment = fakeTarget();
    const client = createTelemetryClient({
      fetchImpl: impl,
      target: environment.target,
      bufferLimit: 100,
      flushThreshold: 100,
      flushIntervalMs: 5_000
    });
    client.record(event());
    environment.tick();
    expect(calls).toHaveLength(1);
    client.dispose();
  });
});

describe("离开页面使用 keepalive", () => {
  it("pagehide 触发 keepalive 投递", () => {
    const { impl, calls } = fakeFetch();
    const environment = fakeTarget();
    const client = createTelemetryClient({ fetchImpl: impl, target: environment.target, flushThreshold: 100 });
    client.record(event());
    environment.fire("pagehide");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBe(true);
    client.dispose();
  });

  it("visibilitychange 到 hidden 才投递，且是 keepalive", () => {
    const { impl, calls } = fakeFetch();
    const environment = fakeTarget();
    const client = createTelemetryClient({ fetchImpl: impl, target: environment.target, flushThreshold: 100 });

    client.record(event());
    environment.fire("visibilitychange");
    expect(calls).toHaveLength(0);

    environment.target.document!.hidden = true;
    environment.fire("visibilitychange");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBe(true);
    client.dispose();
  });

  it("dispose 前做最后一次 keepalive 投递，并解绑定时器与监听", () => {
    const { impl, calls } = fakeFetch();
    const environment = fakeTarget();
    const client = createTelemetryClient({ fetchImpl: impl, target: environment.target, flushThreshold: 100 });
    client.record(event());
    client.dispose();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBe(true);
    expect(environment.cleared).toEqual(["timer-1"]);
    expect(environment.listenerCount("pagehide")).toBe(0);
    expect(environment.listenerCount("visibilitychange")).toBe(0);
    // 关闭之后不再接受事件，也不再投递。
    client.record(event());
    client.flush();
    expect(client.status().queued).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("失败不重试、不抛错、不外泄正文", () => {
  it("HTTP 非 2xx 只记账，且请求次数不增长", async () => {
    const { impl, calls } = fakeFetch(() => response(503));
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 1 });
    client.record(event());
    await settle();

    expect(calls).toHaveLength(1);
    expect(client.status().droppedFailed).toBe(1);
    expect(client.status().lastError).toBe("http-503");
    client.dispose();
  });

  it("网络异常只记账", async () => {
    const { impl, calls } = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 1 });
    client.record(event());
    await settle();

    expect(calls).toHaveLength(1);
    expect(client.status().droppedFailed).toBe(1);
    expect(client.status().lastError).toBe("unavailable");
    client.dispose();
  });

  it("fetch 同步抛错不冒泡到 record", async () => {
    const impl = (() => {
      throw new Error("no fetch");
    }) as unknown as typeof globalThis.fetch;
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 1 });
    expect(() => client.record(event())).not.toThrow();
    await settle();
    expect(client.status().droppedFailed).toBe(1);
    client.dispose();
  });

  it("失败不会把事件重新入队", async () => {
    const { impl } = fakeFetch(() => response(500));
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 100 });
    client.record(event());
    client.flush();
    await settle();
    expect(client.status().queued).toBe(0);
    expect(client.status().droppedFailed).toBe(1);
    client.dispose();
  });
});

describe("客户端预过滤", () => {
  it("白名单外的 name/result/origin 计入 droppedInvalid 且不发请求", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 100 });
    client.record({ name: "prompt.viewed", result: "success", origin: "browser" } as unknown as TelemetryEventInput);
    client.record({ name: "canvas.edit", result: "partial", origin: "browser" } as unknown as TelemetryEventInput);
    client.record({ name: "canvas.edit", result: "success", origin: "server" } as unknown as TelemetryEventInput);
    client.flush();

    expect(client.status().droppedInvalid).toBe(3);
    expect(client.status().queued).toBe(0);
    expect(calls).toHaveLength(0);
    client.dispose();
  });

  it("record 对 null/非对象输入不抛错", () => {
    const client = createTelemetryClient({ fetchImpl: fakeFetch().impl, target: {}, flushThreshold: 100 });
    expect(() => client.record(null as unknown as TelemetryEventInput)).not.toThrow();
    expect(client.status().droppedInvalid).toBe(1);
    client.dispose();
  });
});

describe("构建标识", () => {
  /** 取一次投递请求体里的事件。 */
  const sentEvents = (call: FetchCall): TelemetryEventInput[] =>
    (JSON.parse(String(call.init.body)) as { events: TelemetryEventInput[] }).events;

  it("默认给每条事件盖上构建期注入的版本", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({
      fetchImpl: impl,
      target: {},
      flushThreshold: 1,
      frontendVersion: "abc1234"
    });
    client.record(event());
    client.record(event({ result: "failure" }));

    expect(calls).toHaveLength(2);
    expect(sentEvents(calls[0]!).map((item) => item.frontendVersion)).toEqual(["abc1234"]);
    expect(sentEvents(calls[1]!).map((item) => item.frontendVersion)).toEqual(["abc1234"]);
    client.dispose();
  });

  it("调用点显式给的版本优先于客户端默认", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({
      fetchImpl: impl,
      target: {},
      flushThreshold: 1,
      frontendVersion: "abc1234"
    });
    client.record(event({ frontendVersion: "v9.9.9" }));

    expect(sentEvents(calls[0]!)[0]?.frontendVersion).toBe("v9.9.9");
    client.dispose();
  });

  it("显式空串表示这次构建不盖章（未注入版本）", () => {
    const { impl, calls } = fakeFetch();
    const client = createTelemetryClient({ fetchImpl: impl, target: {}, flushThreshold: 1, frontendVersion: "" });
    client.record(event());

    expect(sentEvents(calls[0]!)[0]?.frontendVersion).toBeUndefined();
    client.dispose();
  });
});

describe("安装与解析", () => {
  it("installTelemetryClient 提供 telemetryClient，并在释放时 dispose", () => {
    setTelemetryClientForTesting(undefined);
    const provided = new Map<string, unknown>();
    const effects: Array<() => unknown> = [];
    const ctx = {
      provide: (name: string, value: unknown) => provided.set(name, value),
      effect: (factory: () => unknown) => effects.push(factory)
    } as unknown as Context;

    const client = installTelemetryClient(ctx, { fetchImpl: fakeFetch().impl, target: {}, flushThreshold: 100 });
    expect(provided.get("telemetryClient")).toBe(client);
    expect(activeTelemetryClient()).toBe(client);

    // effect 的返回值就是 disposer（Cordis 约定）。
    for (const effect of effects) {
      const disposer = effect();
      if (typeof disposer === "function") (disposer as () => void)();
    }
    expect(activeTelemetryClient()).toBeUndefined();
  });

  it("未安装时 activeTelemetryClient 为 undefined（埋点因此 no-op）", () => {
    setTelemetryClientForTesting(undefined);
    expect(activeTelemetryClient()).toBeUndefined();
  });
});

describe("稳定短码", () => {
  it("只接受契约形状的码，其余落回 fallback", () => {
    expect(stableTelemetryErrorCode("canvas.save.timeout")).toBe("canvas.save.timeout");
    expect(stableTelemetryErrorCode("CANVAS.SAVE")).toBe("canvas.save");
    expect(stableTelemetryErrorCode("保存失败")).toBe("unknown");
    expect(stableTelemetryErrorCode("has space")).toBe("unknown");
    expect(stableTelemetryErrorCode("")).toBe("unknown");
    expect(stableTelemetryErrorCode(undefined)).toBe("unknown");
    // 单字符也是合法形状（首字符字母数字即可），所以只换 fallback、不换判定。
    expect(stableTelemetryErrorCode("x")).toBe("x");
    expect(stableTelemetryErrorCode("has space", "fallback.code")).toBe("fallback.code");
  });
});

describe("客户端策略常量", () => {
  it("与契约的批上限一致，且本机策略有界", () => {
    expect(TELEMETRY_CLIENT_LIMITS.maxBatchEvents).toBe(100);
    expect(TELEMETRY_CLIENT_LIMITS.bufferEvents).toBeGreaterThan(0);
    expect(TELEMETRY_CLIENT_LIMITS.flushThreshold).toBeLessThanOrEqual(TELEMETRY_CLIENT_LIMITS.bufferEvents);
  });
});
