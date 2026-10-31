/**
 * 核心层 · telemetry 插件测试（change: 2026-10-20-add-local-client-telemetry，任务 6.6 / design D2/D7/D11）。
 *
 * 守的是装配层的四件事，不是服务包的业务逻辑（那是 `@woohaa3/telemetry-service` 自己的测试）：
 * - 设置读进服务：缺省「本地记录开、外部上报关」，关闭开关真的传下去；
 * - 路由登记在 `ROUTE_ORDER.telemetry`，且**只对遥测路径负责**（其它请求必须立刻交下游）；
 * - 鉴权在装配层完成：本地单实例跳过、无身份 401、无 action 403、通过后交给服务；
 * - 不参与启动就绪：存储坏了不能拖住宿主启动；
 * - 卸载时关闭服务（释放 SQLite 与定时器）。
 *
 * 测试用真实的临时 SQLite 文件：这一层最容易出错的地方正是"设置/路径没接对但类型没问题"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostTelemetryService } from "@woohaa3/contracts";
import type { HostContext } from "../context.js";
import { ROUTE_ORDER, READINESS_ORDER } from "../order.js";
import { telemetryPlugin, telemetryStorePath } from "./telemetry.js";

const temps: string[] = [];
/** 用例建出来的 harness：teardown 时必须先跑 disposer 关掉 SQLite，再删目录。 */
const harnesses: Array<{ disposers: Array<() => void> }> = [];

afterEach(() => {
  // Windows 上 SQLite 句柄没关就删不掉临时目录（EPERM，重试也无效）。
  // `applyPlugin` 把 close 注册在 `ctx.effect` 的 disposer 里，这里要先执行它们。
  for (const harness of harnesses.splice(0)) {
    for (const dispose of harness.disposers.splice(0)) dispose();
  }
  for (const directory of temps.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempStore(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-telemetry-host-"));
  temps.push(directory);
  return directory;
}

type CapturedResponse = { status?: number; body?: string; headers?: Record<string, string> };

function fakeRequest(url: string, method = "GET"): IncomingMessage {
  // 只实现被测路径用到的最小面：url/method/异步迭代（POST 读 body 时为空）。
  return {
    url,
    method,
    [Symbol.asyncIterator]: async function* empty() {
      // 无 body
    }
  } as unknown as IncomingMessage;
}

function fakeResponse(sink: CapturedResponse): ServerResponse {
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      sink.status = status;
      if (headers) sink.headers = headers;
      return this;
    },
    end(body?: string) {
      if (typeof body === "string") sink.body = body;
    }
  } as unknown as ServerResponse;
}

type HarnessOptions = {
  /** 本次装配使用的存储目录（缺省新建临时目录）。 */
  directory?: string;
  values?: Record<string, unknown>;
  /** 缺省：本地单实例（`runtime.enabled === false`），鉴权跳过。 */
  access?: {
    enabled?: boolean;
    principal?: unknown;
    denyAction?: boolean;
  };
};

function applyPlugin(options: HarnessOptions = {}) {
  const values = options.values ?? {};
  const provided: Record<string, unknown> = {};
  const routes: Array<{ order: number; handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }> = [];
  const readiness: number[] = [];
  const disposers: Array<() => void> = [];

  const accessEnabled = options.access?.enabled ?? false;
  const ctx = {
    config: { get: (key: string) => values[key] },
    log: { scope: () => () => undefined },
    gateway: {
      route: (order: number, handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>) => {
        routes.push({ order, handle });
        return () => undefined;
      },
      readiness: (order: number) => {
        readiness.push(order);
        return () => undefined;
      }
    },
    access: {
      runtime: { enabled: accessEnabled },
      authenticator: async () => options.access?.principal ?? null,
      accessEnforcer: {
        assertAction: async () => {
          if (options.access?.denyAction) throw Object.assign(new Error("denied"), { name: "AccessDeniedError" });
        }
      }
    },
    provide: (name: string, value: unknown) => {
      provided[name] = value;
    },
    effect: (callback: () => unknown) => {
      const disposer = callback();
      if (typeof disposer === "function") disposers.push(disposer as () => void);
    }
  } as unknown as HostContext;

  telemetryPlugin.apply(ctx, { env: { WOOHAA3_TASK_STORE_PATH: path.join(optionsPath(options), "task.sqlite") } });
  harnesses.push({ disposers });
  return { provided, routes, readiness, disposers };
}

/** 让每个 harness 用独立临时目录，避免用例之间共享同一个 SQLite 文件。 */
function optionsPath(options: HarnessOptions & { directory?: string }): string {
  if (options.directory) return options.directory;
  return tempStore();
}

async function getRoute(routes: Array<{ order: number; handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }>) {
  const route = routes.find((entry) => entry.order === ROUTE_ORDER.telemetry);
  if (!route) throw new Error("没有登记 telemetry 路由");
  return route;
}

describe("telemetryStorePath", () => {
  it("与任务库同目录，文件名固定 telemetry.sqlite", () => {
    // 期望值用 path.resolve 拼：Windows 上分隔符是反斜杠。
    // 期望值按实现的同一套 path 语义拼：Windows 上分隔符是反斜杠，且这里不加盘符。
    expect(telemetryStorePath({ WOOHAA3_TASK_STORE_PATH: "/var/data/task.sqlite" })).toBe(path.join(path.dirname("/var/data/task.sqlite"), "telemetry.sqlite"));
  });

  it("未配置存储路径时按 cwd 推导（readStorePath 的空串 → '.'）", () => {
    expect(telemetryStorePath({})).toBe(path.join(".", "telemetry.sqlite"));
  });
});

describe("装配与设置", () => {
  it("提供 ctx.telemetry，并把本地记录缺省打开、外部上报缺省关闭", async () => {
    const directory = tempStore();
    const harness = applyPlugin({ directory });
    const service = harness.provided.telemetry as HostTelemetryService;
    expect(service).toBeDefined();

    const status = await service.status();
    expect(status.enabled).toBe(true);
    expect(status.exportEnabled).toBe(false);
    expect(status.store).toBe("ok");
    service.close();
  });

  it("关闭开关真的传下去（telemetry.local.enabled=false）", async () => {
    const directory = tempStore();
    const harness = applyPlugin({ directory, values: { "telemetry.local.enabled": false } });
    const service = harness.provided.telemetry as HostTelemetryService;
    expect((await service.status()).enabled).toBe(false);
    service.close();
  });

  it("外部上报开关同样即时生效", async () => {
    const directory = tempStore();
    const harness = applyPlugin({ directory, values: { "telemetry.export.enabled": true } });
    const service = harness.provided.telemetry as HostTelemetryService;
    expect((await service.status()).exportEnabled).toBe(true);
    service.close();
  });

  it("注册在 ROUTE_ORDER.telemetry，且不参与启动就绪", () => {
    const harness = applyPlugin({ directory: tempStore() });
    expect(harness.routes.map((route) => route.order)).toEqual([ROUTE_ORDER.telemetry]);
    expect(harness.readiness).toEqual([]);
    // 就绪顺序里没有遥测：它坏了业务仍必须可用（design D11）。
    expect(Object.keys(READINESS_ORDER)).not.toContain("telemetry");
  });

  it("卸载时关闭服务", () => {
    const directory = tempStore();
    const harness = applyPlugin({ directory });
    const service = harness.provided.telemetry as HostTelemetryService;
    const close = service.close.bind(service);
    let closed = false;
    (service as unknown as { close: () => void }).close = () => {
      closed = true;
      close();
    };
    for (const disposer of harness.disposers) disposer();
    expect(closed).toBe(true);
  });
});

describe("路由归属", () => {
  it("非遥测路径立刻交下游（不替其它 /api 做处理）", async () => {
    const harness = applyPlugin({ directory: tempStore() });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    const handled = await route.handle(fakeRequest("/api/canvas"), fakeResponse(sink));
    expect(handled).toBe(false);
    expect(sink.status).toBeUndefined();
    // 前缀相同但不是子路径也不能抢（/api/telemetry2 ≠ /api/telemetry/*）。
    expect(await route.handle(fakeRequest("/api/telemetry2"), fakeResponse({}))).toBe(false);
  });

  it("遥测路径交给服务处理（本地单实例直接可用）", async () => {
    const harness = applyPlugin({ directory: tempStore() });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    const handled = await route.handle(fakeRequest("/api/telemetry/status"), fakeResponse(sink));

    expect(handled).toBe(true);
    expect(sink.status).toBe(200);
    const body = JSON.parse(String(sink.body)) as { enabled: boolean; store: string };
    expect(body.enabled).toBe(true);
    expect(body.store).toBe("ok");
  });
});

describe("鉴权（启用访问控制时）", () => {
  it("无身份返回 401，且不触达服务", async () => {
    const harness = applyPlugin({ directory: tempStore(), access: { enabled: true, principal: null } });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    const handled = await route.handle(fakeRequest("/api/telemetry/events", "DELETE"), fakeResponse(sink));

    expect(handled).toBe(true);
    expect(sink.status).toBe(401);
    expect(sink.body).toContain("unauthorized");
  });

  it("有身份但缺 telemetry.inspect 返回 403", async () => {
    const harness = applyPlugin({
      directory: tempStore(),
      access: { enabled: true, principal: { subject: "user:1" }, denyAction: true }
    });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    const handled = await route.handle(fakeRequest("/api/telemetry/events", "DELETE"), fakeResponse(sink));

    expect(handled).toBe(true);
    expect(sink.status).toBe(403);
    expect(sink.body).toContain("forbidden");
  });

  it("通过鉴权后照常走到服务", async () => {
    const harness = applyPlugin({ directory: tempStore(), access: { enabled: true, principal: { subject: "user:1" } } });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    const handled = await route.handle(fakeRequest("/api/telemetry/status"), fakeResponse(sink));

    expect(handled).toBe(true);
    expect(sink.status).toBe(200);
  });

  it("未启用访问控制时不要求身份（本地单实例）", async () => {
    const harness = applyPlugin({ directory: tempStore(), access: { enabled: false } });
    const route = await getRoute(harness.routes);
    const sink: CapturedResponse = {};
    expect(await route.handle(fakeRequest("/api/telemetry/status"), fakeResponse(sink))).toBe(true);
    expect(sink.status).toBe(200);
  });
});
