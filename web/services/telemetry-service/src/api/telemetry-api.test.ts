/**
 * 遥测 HTTP 读面测试（change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 用真的 `IncomingMessage` / `ServerResponse`（不引 supertest）：要守的是路由命中、状态码、
 * 稳定错误码与 64 KiB 上限这些"接口边界"，而这些只有走一遍真实请求/响应的形态才可信。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { HostTelemetryService } from "@woohaa3/contracts";
import { createTelemetryService } from "../service.js";
import type { TelemetrySettings } from "../settings.js";
import { handleTelemetryRequest } from "./telemetry-api.js";

const NOW = 1_700_000_040_000;

const dirs: string[] = [];
const services: HostTelemetryService[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-api-"));
  dirs.push(dir);
  return path.join(dir, "telemetry.sqlite");
}

function makeSettings(overrides: Partial<TelemetrySettings> = {}): TelemetrySettings {
  return {
    localEnabled: () => true,
    retentionDays: () => 7,
    maxRows: () => 200_000,
    exportEnabled: () => false,
    ...overrides
  };
}

function startService(): HostTelemetryService {
  const service = createTelemetryService({
    path: tempDbPath(),
    settings: makeSettings(),
    now: () => NOW
  });
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) {
    try {
      service.close();
    } catch {
      // 关闭失败不掩盖断言结果。
    }
  }
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRequest(options: { method: string; url: string; body?: Buffer | string }): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = options.method;
  req.url = options.url;
  if (options.body !== undefined) {
    // 请求体走真正的 Readable 缓冲：handler 用的是 `for await (const chunk of req)`，
    // 手工 `emit("data")` 不会被异步迭代器消费。
    req.push(Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body));
    req.push(null);
  }
  return req;
}

/** 只接管 `writeHead`/`end`：状态码与响应体自己收集，避免真的写 socket。 */
function mockResponse(req: IncomingMessage): {
  res: ServerResponse;
  written: string[];
  headers: Record<string, string>;
} {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const res = new ServerResponse(req);
  res.writeHead = ((statusCode: number, statusMessageOrHeaders?: unknown, maybeHeaders?: unknown) => {
    res.statusCode = statusCode;
    const headerObject =
      typeof statusMessageOrHeaders === "object" && statusMessageOrHeaders !== null
        ? statusMessageOrHeaders
        : maybeHeaders;
    if (headerObject && typeof headerObject === "object") {
      Object.assign(headers, headerObject as Record<string, string>);
    }
    return res;
  }) as typeof res.writeHead;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  return { res, written, headers };
}

type CallResult = {
  readonly handled: boolean;
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly contentType?: string;
};

async function call(
  service: HostTelemetryService,
  options: { method: string; url: string; body?: Buffer | string }
): Promise<CallResult> {
  const req = makeRequest(options);
  const { res, written, headers } = mockResponse(req);
  const handled = await handleTelemetryRequest(service, req, res);
  const text = written.join("");
  return {
    handled,
    status: res.statusCode,
    body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
    contentType: headers["content-type"]
  };
}

const VALID_EVENT = { name: "canvas.open", result: "success", origin: "browser" };

describe("路由命中", () => {
  it("未命中路径返回 false，响应不被写入", async () => {
    const service = startService();
    for (const url of ["/api/other", "/api/telemetry", "/", "/api/telemetry/events/extra"]) {
      const result = await call(service, { method: "GET", url });
      expect(result.handled, url).toBe(false);
      expect(result.body, url).toBeNull();
    }
  });

  it("命中路径返回 true，响应是 JSON 且带稳定内容类型", async () => {
    const service = startService();
    const result = await call(service, { method: "GET", url: "/api/telemetry/status" });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(result.body).not.toBeNull();
  });

  it("非 GET 访问只读路由返回 405 method-not-allowed", async () => {
    const service = startService();
    for (const [method, url] of [
      ["POST", "/api/telemetry/summary"],
      ["PUT", "/api/telemetry/summary"],
      ["POST", "/api/telemetry/anomalies"],
      ["POST", "/api/telemetry/status"]
    ] as const) {
      const result = await call(service, { method, url });
      expect(result.status, `${method} ${url}`).toBe(405);
      expect(result.body).toEqual({ error: "method-not-allowed" });
    }
  });
});

describe("POST /api/telemetry/events", () => {
  it("正常上报返回 202 与 accepted/dropped 计数，事件随后可查", async () => {
    const service = startService();
    const result = await call(service, {
      method: "POST",
      url: "/api/telemetry/events",
      body: JSON.stringify({ events: [VALID_EVENT, { name: "bogus", result: "success", origin: "browser" }] })
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: 1, dropped: 1 });

    await service.flush();
    const page = await service.query();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.name).toBe("canvas.open");
  });

  it("空 body / 非 JSON / 形状不对都是 400 invalid-body", async () => {
    const service = startService();
    for (const body of ["", "not json", "[1,2,3]", JSON.stringify({ events: "nope" }), JSON.stringify({})]) {
      const result = await call(service, { method: "POST", url: "/api/telemetry/events", body });
      expect(result.status, body).toBe(400);
      expect(result.body).toEqual({ error: "invalid-body" });
    }
  });

  it("body 超过 64 KiB 返回 413 payload-too-large", async () => {
    const service = startService();
    const result = await call(service, {
      method: "POST",
      url: "/api/telemetry/events",
      body: Buffer.alloc(64 * 1024 + 1, 0x61)
    });

    expect(result.status).toBe(413);
    expect(result.body).toEqual({ error: "payload-too-large" });
  });

  it("单批超过 100 条返回 413 payload-too-large", async () => {
    const service = startService();
    const events = Array.from({ length: 101 }, () => VALID_EVENT);
    const result = await call(service, {
      method: "POST",
      url: "/api/telemetry/events",
      body: JSON.stringify({ events })
    });

    expect(result.status).toBe(413);
    expect(result.body).toEqual({ error: "payload-too-large" });
  });
});

describe("GET /api/telemetry/events", () => {
  it("合法查询返回 200 与分页形状", async () => {
    const service = startService();
    service.emit({ name: "canvas.open", result: "success", origin: "browser" });
    await service.flush();

    const result = await call(service, {
      method: "GET",
      url: "/api/telemetry/events?window=1h&name=canvas.open&result=success&limit=10"
    });

    expect(result.status).toBe(200);
    const events = result.body?.events as unknown[];
    expect(events).toHaveLength(1);
  });

  it("非法参数返回 400，错误码来自 parseTelemetryEventFilter", async () => {
    const service = startService();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["window=bogus", "invalid-window"],
      ["name=bogus", "invalid-name"],
      ["result=bogus", "invalid-result"],
      ["errorCode=Not%20A%20Code!", "invalid-error-code"],
      ["limit=0", "invalid-limit"],
      ["limit=1.5", "invalid-limit"],
      ["cursor=" + "x".repeat(65), "invalid-cursor"]
    ];

    for (const [query, code] of cases) {
      const result = await call(service, { method: "GET", url: `/api/telemetry/events?${query}` });
      expect(result.status, query).toBe(400);
      expect(result.body, query).toEqual({ error: code });
    }
  });
});

describe("DELETE /api/telemetry/events", () => {
  it("清空并返回 removed 条数", async () => {
    const service = startService();
    service.emit({ name: "canvas.open", result: "success", origin: "browser" });
    service.emit({ name: "canvas.save", result: "success", origin: "browser" });
    await service.flush();

    const result = await call(service, { method: "DELETE", url: "/api/telemetry/events" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: 2 });
    expect((await service.query()).events).toEqual([]);
  });
});

describe("GET summary / anomalies / status", () => {
  it("summary 用缺省窗口与显式分桶", async () => {
    const service = startService();
    service.emit({ name: "canvas.open", result: "success", origin: "browser" });
    await service.flush();

    const withBucket = await call(service, { method: "GET", url: "/api/telemetry/summary?window=1h&bucket=5m" });
    expect(withBucket.status).toBe(200);
    expect(withBucket.body).toMatchObject({ window: "1h", bucket: "5m", total: 1 });

    // 不传窗口按缺省 24h，分桶取该窗口的缺省值。
    const defaulted = await call(service, { method: "GET", url: "/api/telemetry/summary" });
    expect(defaulted.body).toMatchObject({ window: "24h", bucket: "1h" });

    const invalidWindow = await call(service, { method: "GET", url: "/api/telemetry/summary?window=bogus" });
    expect(invalidWindow.status).toBe(400);
    expect(invalidWindow.body).toEqual({ error: "invalid-window" });

    const invalidBucket = await call(service, { method: "GET", url: "/api/telemetry/summary?bucket=2h" });
    expect(invalidBucket.status).toBe(400);
    expect(invalidBucket.body).toEqual({ error: "invalid-bucket" });
  });

  it("summary 支持 groupBy；未知分组键返回 invalid-attribute（不静默降级成不分组）", async () => {
    const service = startService();
    service.emit({
      name: "perf.interaction",
      result: "success",
      origin: "browser",
      durationMs: 12,
      attributes: { mode: "dev", kind: "pan" }
    });
    service.emit({
      name: "perf.interaction",
      result: "success",
      origin: "browser",
      durationMs: 20,
      attributes: { mode: "dev", kind: "zoom" }
    });
    await service.flush();

    const grouped = await call(service, { method: "GET", url: "/api/telemetry/summary?window=1h&groupBy=kind" });
    expect(grouped.status).toBe(200);
    expect(grouped.body).toMatchObject({ groupBy: "kind", total: 2 });
    expect((grouped.body?.rows as Array<{ attributeValue?: string }>).map((row) => row.attributeValue)).toEqual([
      "pan",
      "zoom"
    ]);

    const unknown = await call(service, { method: "GET", url: "/api/telemetry/summary?groupBy=prompt" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: "invalid-attribute" });

    // 空串表示不分组（URL 里删掉值是很自然的手改结果），不该报错。
    const blank = await call(service, { method: "GET", url: "/api/telemetry/summary?groupBy=" });
    expect(blank.status).toBe(200);
    expect(blank.body).not.toHaveProperty("groupBy");
  });

  it("anomalies 返回数组；非法窗口 400 invalid-window", async () => {
    const service = startService();
    const ok = await call(service, { method: "GET", url: "/api/telemetry/anomalies?window=6h" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ anomalies: [] });

    const invalid = await call(service, { method: "GET", url: "/api/telemetry/anomalies?window=2h" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "invalid-window" });

    const unknownGroup = await call(service, { method: "GET", url: "/api/telemetry/anomalies?groupBy=prompt" });
    expect(unknownGroup.status).toBe(400);
    expect(unknownGroup.body).toEqual({ error: "invalid-attribute" });
  });

  it("summary / anomalies 的属性筛选成对校验；无关参数不会把聚合打成 400", async () => {
    const service = startService();

    // 只给键：这是"无法回答"的请求，与列表口径一致返回 invalid-attribute。
    const halfPair = await call(service, { method: "GET", url: "/api/telemetry/summary?attributeKey=mode" });
    expect(halfPair.status).toBe(400);
    expect(halfPair.body).toEqual({ error: "invalid-attribute" });

    const unknownKey = await call(
      service,
      { method: "GET", url: "/api/telemetry/summary?attributeKey=prompt&attributeValue=secret" }
    );
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body).toEqual({ error: "invalid-attribute" });

    // 从列表链接带过来的 cursor/limit 与聚合无关，不应导致 400。
    const withListParams = await call(
      service,
      { method: "GET", url: "/api/telemetry/summary?window=1h&cursor=abc&limit=10&name=perf.frame" }
    );
    expect(withListParams.status).toBe(200);

    // 成对且合法：按 mode 筛选后只统计该模式的样本。
    service.emit({
      name: "perf.frame",
      result: "success",
      origin: "browser",
      durationMs: 6,
      attributes: { mode: "dev" }
    });
    service.emit({
      name: "perf.frame",
      result: "success",
      origin: "browser",
      durationMs: 60,
      attributes: { mode: "production" }
    });
    await service.flush();

    const devOnly = await call(
      service,
      { method: "GET", url: "/api/telemetry/summary?window=1h&attributeKey=mode&attributeValue=dev" }
    );
    expect(devOnly.status).toBe(200);
    expect(devOnly.body).toMatchObject({ total: 1 });
    expect((devOnly.body?.rows as Array<{ durationP50?: number }>)[0]?.durationP50).toBe(6);
  });

  it("status 返回存储可用与计数", async () => {
    const service = startService();
    const result = await call(service, { method: "GET", url: "/api/telemetry/status" });

    expect(result.body).toMatchObject({ store: "ok", enabled: true, eventCount: 0, queued: 0 });
  });
});

describe("存储异常", () => {
  it("服务实现抛错时只回 500 unavailable，不泄漏内部细节", async () => {
    const broken = {
      query: async () => {
        throw new Error("SQLITE_CORRUPT: /secret/path/telemetry.sqlite");
      }
    } as unknown as HostTelemetryService;

    const result = await call(broken, { method: "GET", url: "/api/telemetry/events" });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "unavailable" });
  });
});
