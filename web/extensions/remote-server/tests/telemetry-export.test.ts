/**
 * 遥测上报出口测试（change: 2026-10-20-add-local-client-telemetry，tasks 7.6；
 * change: 2026-10-25-enhance-telemetry-performance-collection 改为无损映射）。
 *
 * 守五件事：
 * - **枚举映射与跳过是对的**：`task.terminal` 与 `perf.*` 没有对应 `Action` 必须跳过，
 *   `task` surface 不写；
 * - **保真字段无损**：`durationMs` / `errorCode` / `attributes` 全部上报，属性值统一字符串化；
 * - **切批同时受条数与字节约束**（目标契约是 ≤100 条且 ≤16 KiB）；
 * - **不重试**：失败只回错误码，请求次数不增加——proto 没有幂等键，重投会让计数翻倍；
 * - **没有会话时立刻失败**且不发请求（"开着开关但没连服务端"要能说清）。
 */
import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@woohaa3/contracts";
import { createRemoteTelemetryExport, splitClientEvents, toClientEvent } from "../src/backend/telemetry-export.js";
import type { RemoteSessionSource } from "../src/backend/session.js";

const SERVER_URL = "https://canvas.example.com";

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    name: "canvas.edit",
    result: "success",
    origin: "browser",
    occurredAt: 1_760_000_000_000,
    ...overrides
  };
}

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

/**
 * 出口只读 `serverUrl` / `token`，但依赖的类型是完整的 `RemoteSession`；这里按契约补齐其余
 * 字段（而不是用断言绕过），改名/加字段时 typecheck 会直接把这里指出来。
 */
function sessionSource(session: { serverUrl: string; token: string } | null): Pick<RemoteSessionSource, "current"> {
  return {
    current: async () =>
      session === null
        ? null
        : {
            serverUrl: session.serverUrl,
            token: session.token,
            subject: "session-test",
            displayName: null,
            expiresAt: 0
          }
  };
}

const logs: Array<Record<string, unknown>> = [];
const log = (entry: Record<string, unknown>) => {
  logs.push(entry);
};

describe("事件映射", () => {
  it("枚举一一对应，可选的 surface/traceId/frontendVersion 只在存在时写入", () => {
    expect(
      toClientEvent(
        event({
          name: "sync.reconcile",
          result: "failure",
          origin: "local-host",
          surface: "sync",
          traceId: "0123456789abcdef0123456789abcdef",
          frontendVersion: "v1.2.3"
        })
      )
    ).toEqual({
      action: "ACTION_SYNC_RECONCILE",
      result: "RESULT_FAILURE",
      client: "CLIENT_LOCAL_HOST",
      surface: "SURFACE_SYNC",
      traceId: "0123456789abcdef0123456789abcdef",
      frontendVersion: "v1.2.3"
    });
  });

  it("task.terminal 没有对应 Action，返回 null（不是塞一个别的值）", () => {
    expect(toClientEvent(event({ name: "task.terminal", origin: "local-host" }))).toBeNull();
  });

  it("四个 perf.* 也没有对应 Action，全部跳过", () => {
    // change: 2026-10-25-enhance-telemetry-performance-collection。
    // 塞进 ACTION_EDITOR_EDIT 之类会让服务端的分类计数撒谎，所以显式返回 null。
    for (const name of ["perf.startup", "perf.interaction", "perf.segment", "perf.frame"] as const) {
      expect(toClientEvent(event({ name, attributes: { mode: "dev", stage: "app-scope" } }))).toBeNull();
    }
  });

  it("保真字段无损上报：耗时按 int64 字符串、错误码与属性原样", () => {
    const mapped = toClientEvent(
      event({
        name: "canvas.save",
        durationMs: 250,
        errorCode: "save-failed",
        attributes: { mode: "production", fps: 59.5, stringify: true }
      })
    );
    expect(mapped).toMatchObject({ durationMs: "250", errorCode: "save-failed" });
    // 属性值一律字符串：proto 是 map<string,string>，且与本地 SQLite 的比较语义一致。
    expect(mapped?.attributes).toEqual({ mode: "production", fps: "59.5", stringify: "true" });
  });

  it("零耗时与非法错误码不上报（proto3 JSON 省略零值，本地归一也已丢弃非法值）", () => {
    const mapped = toClientEvent(event({ name: "canvas.open", durationMs: 0, errorCode: "" }));
    expect(mapped).not.toHaveProperty("durationMs");
    expect(mapped).not.toHaveProperty("errorCode");
    expect(mapped).not.toHaveProperty("attributes");
  });

  it("surface 必填：本地声明 task（proto 无此值）时按名称推导，绝不省略", () => {
    // 服务端 CleanEvent 要求 surface 落在 1..4，缺省会**整批**拒绝，所以这里必须有值。
    const mapped = toClientEvent(event({ name: "canvas.open", surface: "task" }));
    expect(mapped).not.toBeNull();
    expect(mapped?.surface).toBe("SURFACE_CANVAS");
  });

  it("未声明 surface 时按事件名推导", () => {
    expect(toClientEvent(event({ name: "canvas.save" }))?.surface).toBe("SURFACE_CANVAS");
    expect(toClientEvent(event({ name: "canvas.edit" }))?.surface).toBe("SURFACE_EDITOR");
    expect(toClientEvent(event({ name: "sync.connect" }))?.surface).toBe("SURFACE_SYNC");
    expect(toClientEvent(event({ name: "sync.reconcile" }))?.surface).toBe("SURFACE_SYNC");
    expect(toClientEvent(event({ name: "local.validation" }))?.surface).toBe("SURFACE_LOCAL_VALIDATION");
  });

  it("声明了合法 surface 时以声明为准", () => {
    expect(toClientEvent(event({ name: "canvas.edit", surface: "canvas" }))?.surface).toBe("SURFACE_CANVAS");
  });

  it("四个结果值与四个来源都能映射", () => {
    for (const result of ["success", "failure", "cancelled", "rejected"] as const) {
      expect(toClientEvent(event({ result }))?.result).toBe(`RESULT_${result.toUpperCase()}`);
    }
    for (const [origin, expected] of [
      ["browser", "CLIENT_BROWSER"],
      ["desktop", "CLIENT_DESKTOP"],
      ["local-host", "CLIENT_LOCAL_HOST"]
    ] as const) {
      expect(toClientEvent(event({ origin }))?.client).toBe(expected);
    }
  });
});

describe("切批", () => {
  it("按条数上限切分", () => {
    const events = Array.from({ length: 250 }, (_, index) => ({ action: "ACTION_CANVAS_SAVE", index }));
    const sizes = splitClientEvents(events).map((batch) => batch.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("按字节上限切分（单批序列化不超过 16 KiB）", () => {
    // 每条约 1 KiB 的 traceId 填充，确保字节上限先触发。
    const events = Array.from({ length: 20 }, (_, index) => ({
      action: "ACTION_CANVAS_SAVE",
      pad: String(index).padEnd(1000, "x")
    }));
    const batches = splitClientEvents(events);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify({ events: batch }), "utf8")).toBeLessThanOrEqual(20 * 1024);
    }
    expect(batches.flat()).toHaveLength(20);
  });

  it("空输入不产生批次", () => {
    expect(splitClientEvents([])).toEqual([]);
  });
});

describe("投递", () => {
  it("没有会话时立刻失败且不发请求", async () => {
    logs.length = 0;
    const { impl, calls } = fakeFetch(() => json(200, {}));
    const provider = createRemoteTelemetryExport({ sessionSource: sessionSource(null), fetchImpl: impl, log });

    const result = await provider.send([event()]);
    expect(result).toEqual({ ok: false, code: "unconfigured", message: "未连接服务端" });
    expect(calls).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({ event: "remote-telemetry-export-failed", code: "unconfigured" });
  });

  it("整批都映射不了时算成功（没有可发的东西，不是失败）", async () => {
    const { impl, calls } = fakeFetch(() => json(200, {}));
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "t" }),
      fetchImpl: impl,
      log
    });

    expect(await provider.send([event({ name: "task.terminal" })])).toEqual({ ok: true, accepted: 0 });
    expect(calls).toHaveLength(0);
  });

  it("成功时按 Connect 路径上报并带上 Bearer，返回服务端计数", async () => {
    const { impl, calls } = fakeFetch(() => json(200, { acceptedCount: 2 }));
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "session-token" }),
      fetchImpl: impl,
      log
    });

    const result = await provider.send([event(), event({ name: "canvas.open" })]);
    expect(result).toEqual({ ok: true, accepted: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVER_URL}/woohaa.telemetry.v1alpha1.TelemetryService/ReportEvents`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token");
    const body = JSON.parse(String(calls[0].init.body)) as { events: unknown[] };
    expect(body.events).toHaveLength(2);
  });

  it("acceptedCount 缺失按 0 处理（proto3 JSON 省略零值）", async () => {
    const { impl } = fakeFetch(() => json(200, {}));
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "t" }),
      fetchImpl: impl,
      log
    });
    expect(await provider.send([event()])).toEqual({ ok: true, accepted: 0 });
  });

  it("失败不重试：只发一次并回错误码", async () => {
    const { impl, calls } = fakeFetch(() => json(500, { code: "internal", message: "boom" }));
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "t" }),
      fetchImpl: impl,
      log
    });

    const result = await provider.send([event()]);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("服务端没有该接口时给出可行动的错误码", async () => {
    const { impl } = fakeFetch(() => json(404, { code: "unimplemented" }));
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "t" }),
      fetchImpl: impl,
      log
    });

    const result = await provider.send([event()]);
    expect(result).toEqual({ ok: false, code: "unimplemented", message: "服务端尚未实现遥测上报接口" });
  });

  it("多批时累加计数；同一错误码只记一次日志", async () => {
    let call = 0;
    const { impl, calls } = fakeFetch(() => {
      call += 1;
      return call === 1 ? json(200, { acceptedCount: 100 }) : json(500, { code: "internal" });
    });
    logs.length = 0;
    const provider = createRemoteTelemetryExport({
      sessionSource: sessionSource({ serverUrl: SERVER_URL, token: "t" }),
      fetchImpl: impl,
      log
    });

    // 150 条 → 两批（100 + 50），第二批失败。
    const batch = Array.from({ length: 150 }, () => event());
    const result = await provider.send(batch);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(logs.filter((entry) => entry.event === "remote-telemetry-export-failed")).toHaveLength(1);
  });
});
