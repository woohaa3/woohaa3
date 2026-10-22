/**
 * 遥测服务装配测试（change: 2026-10-20-add-local-client-telemetry，design D2/D4/D7/D8/D11）。
 *
 * 覆盖三块只有"整装配起来"才能验证的行为：
 * - 写入与保留（真 SQLite 文件 + 注入的 `now`，不 mock 时钟）；
 * - 读面（查询/聚合/异常接线）；
 * - 队列、存储降级与出口投递接缝。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
  HostTelemetryService,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryExport,
  TelemetryExportResult
} from "@woohaa3/contracts";
import { createTelemetryService } from "./service.js";
import type { TelemetrySettings } from "./settings.js";
import { SqliteTelemetryStore } from "./storage/sqlite/store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 固定的"现在"：服务通过 `now` 注入，不 mock 全局时钟。 */
const NOW = 1_700_000_040_000;

const dirs: string[] = [];
const openServices: HostTelemetryService[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-service-"));
  dirs.push(dir);
  return path.join(dir, "telemetry.sqlite");
}

/** 设置读取面：用例只覆盖它关心的那一项，其余按缺省。 */
function makeSettings(overrides: Partial<TelemetrySettings> = {}): TelemetrySettings {
  return {
    localEnabled: () => true,
    retentionDays: () => 7,
    maxRows: () => 200_000,
    exportEnabled: () => false,
    ...overrides
  };
}

function startService(
  options: {
    path?: string;
    clock?: () => number;
    settings?: Partial<TelemetrySettings>;
    logger?: (event: Record<string, unknown>) => void;
  } = {}
): HostTelemetryService {
  const service = createTelemetryService({
    path: options.path ?? tempDbPath(),
    settings: makeSettings(options.settings),
    now: options.clock ?? (() => NOW),
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  openServices.push(service);
  return service;
}

afterEach(() => {
  // 每个用例自己关服务：先 close 再删目录，避免 WAL 句柄让删除失败。
  for (const service of openServices.splice(0)) {
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

function makeInput(overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput {
  return { name: "canvas.open", result: "success", origin: "browser", ...overrides };
}

/** 让出口投递的异步链路（`void deliver(...)`）跑完。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 直接读库检查物理状态：`status()` 里的计数已经按保留期裁过，看不到"行是否真被删"。 */
function inspectStore(dbPath: string): { readonly store: SqliteTelemetryStore } {
  return { store: new SqliteTelemetryStore({ path: dbPath }) };
}

describe("写入与归一", () => {
  it("emit 只入队，flush 才落库（业务路径不等待 I/O）", async () => {
    const service = startService();

    service.emit(makeInput({ name: "canvas.open" }));
    service.emit(makeInput({ name: "canvas.save" }));

    // 还没 flush：队列里有，库里没有。
    expect((await service.status()).queued).toBe(2);
    expect((await service.query()).events).toEqual([]);

    await service.flush();

    expect((await service.status()).queued).toBe(0);
    const page = await service.query();
    expect(page.events.map((event) => event.name)).toEqual(["canvas.save", "canvas.open"]);
    expect(page.events.every((event) => event.receivedAt === NOW)).toBe(true);
  });

  it("非法事件整条丢弃并计入 droppedInvalid，同批合法事件照常落库", async () => {
    const service = startService();

    service.emit(makeInput({ name: "canvas.open" }));
    service.emit({ name: "not-a-name", result: "success", origin: "browser" } as unknown as TelemetryEventInput);
    service.emit({ name: "canvas.save", result: "weird", origin: "browser" } as unknown as TelemetryEventInput);
    await service.flush();

    const status = await service.status();
    expect(status.droppedInvalid).toBe(2);
    expect(status.eventCount).toBe(1);
    expect((await service.query()).events.map((event) => event.name)).toEqual(["canvas.open"]);
  });

  it("local.enabled 关闭时 emit 是静默 no-op", async () => {
    const service = startService({ settings: { localEnabled: () => false } });

    service.emit(makeInput());
    await service.flush();

    const status = await service.status();
    expect(status.enabled).toBe(false);
    expect(status.queued).toBe(0);
    expect(status.droppedInvalid).toBe(0);
    expect(status.eventCount).toBe(0);
  });

  it("close 之后 emit/flush 不抛错且不再写入", async () => {
    const service = startService();
    service.close();

    expect(() => service.emit(makeInput())).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
    // close 幂等。
    expect(() => service.close()).not.toThrow();
  });
});

describe("保留：时间与行数两条独立触发", () => {
  it("查询侧排除过期行：窗口 7d 也被保留期裁掉", async () => {
    const dbPath = tempDbPath();
    let clock = NOW;
    const service = startService({ path: dbPath, clock: () => clock, settings: { retentionDays: () => 1 } });

    service.emit(makeInput());
    await service.flush();
    expect((await service.query({ window: "7d" })).events).toHaveLength(1);

    // 推进两天：行已超出保留期 1d，但小时级 sweep 还没跑过。
    clock = NOW + 2 * DAY;

    expect((await service.query({ window: "7d" })).events).toEqual([]);
    expect((await service.status()).eventCount).toBe(0);

    // 行仍在磁盘上：查询侧的排除不依赖清理是否跑过。
    service.close();
    const { store } = inspectStore(dbPath);
    try {
      expect(store.count(0)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("启动时 sweep 按时间物理删除过期行", async () => {
    const dbPath = tempDbPath();
    let clock = NOW;
    const first = startService({ path: dbPath, clock: () => clock, settings: { retentionDays: () => 1 } });
    first.emit(makeInput());
    await first.flush();
    first.close();

    clock = NOW + 2 * DAY;
    // 新实例启动时先 sweep 一次（design D4）。
    const second = startService({ path: dbPath, clock: () => clock, settings: { retentionDays: () => 1 } });
    second.close();

    const { store } = inspectStore(dbPath);
    try {
      // maxRows 很大，这次删除只能来自时间保留。
      expect(store.count(0)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("启动时 sweep 按行数保留最新的 maxRows 行", async () => {
    const dbPath = tempDbPath();
    const clock = () => NOW;
    const first = startService({ path: dbPath, clock, settings: { maxRows: () => 2 } });
    for (let index = 0; index < 5; index += 1) {
      first.emit(makeInput({ name: "canvas.edit" }));
      await first.flush();
    }
    first.close();

    // retentionDays 仍是 7 天，这次删除只能来自行数保留。
    const second = startService({ path: dbPath, clock, settings: { maxRows: () => 2 } });
    second.close();

    const { store } = inspectStore(dbPath);
    try {
      expect(store.count(0)).toBe(2);
      expect(store.listEvents({ since: 0, until: NOW }).events.map((event) => event.id)).toEqual([5, 4]);
    } finally {
      store.close();
    }
  });
});

describe("查询", () => {
  it("窗口按注入时间裁切，且最新在前", async () => {
    let clock = NOW - 2 * HOUR;
    const service = startService({ clock: () => clock });

    service.emit(makeInput({ name: "canvas.open" }));
    await service.flush();

    clock = NOW;
    service.emit(makeInput({ name: "canvas.save" }));
    await service.flush();

    expect((await service.query({ window: "6h" })).events.map((event) => event.name)).toEqual([
      "canvas.save",
      "canvas.open"
    ]);
    // 1h 窗口只看得到后一条。
    expect((await service.query({ window: "1h" })).events.map((event) => event.name)).toEqual(["canvas.save"]);
    // 缺省窗口是 24h。
    expect((await service.query()).events).toHaveLength(2);
  });

  it("names / results / errorCode / limit / cursor 透传到存储", async () => {
    const service = startService();
    service.emit(makeInput({ name: "canvas.open", result: "failure", errorCode: "save-failed" }));
    service.emit(makeInput({ name: "canvas.open", result: "success" }));
    service.emit(makeInput({ name: "canvas.save", result: "failure", errorCode: "save-failed" }));
    await service.flush();

    const filtered = await service.query({ names: ["canvas.open"], results: ["failure"], errorCode: "save-failed" });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]?.name).toBe("canvas.open");

    const firstPage = await service.query({ limit: 2 });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await service.query({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
  });
});

describe("聚合", () => {
  it("按窗口给出缺省分桶、总数、明细行与时间序列", async () => {
    const service = startService();
    service.emit(makeInput({ name: "canvas.open", result: "failure", durationMs: 30 }));
    service.emit(makeInput({ name: "canvas.open", result: "success", durationMs: 10 }));
    service.emit(makeInput({ name: "sync.connect", result: "cancelled" }));
    await service.flush();

    const summary = await service.summary("24h");
    expect(summary.window).toBe("24h");
    // 24h 窗口缺省按 1h 分桶，避免把一天切成 1440 个点。
    expect(summary.bucket).toBe("1h");
    expect(summary.until).toBe(NOW);
    expect(summary.since).toBe(NOW - 24 * HOUR);
    expect(summary.total).toBe(3);

    const opened = summary.rows.find((row) => row.name === "canvas.open")!;
    expect(opened).toMatchObject({
      count: 2,
      results: { success: 1, failure: 1, cancelled: 0, rejected: 0 },
      durationSamples: 2,
      durationMax: 30
    });
    expect(summary.series).toEqual([{ at: NOW - (NOW % HOUR), name: "canvas.open", count: 2, failures: 1 }, { at: NOW - (NOW % HOUR), name: "sync.connect", count: 1, failures: 1 }]);
  });

  it("缺省分桶随窗口变化，显式 bucket 覆盖缺省", async () => {
    const service = startService();
    expect((await service.summary("1h")).bucket).toBe("1m");
    expect((await service.summary("6h")).bucket).toBe("5m");
    expect((await service.summary("7d")).bucket).toBe("1h");
    expect((await service.summary("24h", "5m")).bucket).toBe("5m");
  });

  it("聚合计数与同条件列表条数一致", async () => {
    const service = startService();
    for (let index = 0; index < 30; index += 1) {
      service.emit(makeInput({ name: index % 3 === 0 ? "canvas.save" : "canvas.open" }));
    }
    await service.flush();

    const summary = await service.summary("24h");
    const listed = await service.query({ window: "24h", limit: 200 });

    expect(summary.total).toBe(listed.events.length);
    for (const row of summary.rows) {
      expect(row.count).toBe(listed.events.filter((event) => event.name === row.name).length);
    }
  });
});

describe("异常规则接线", () => {
  it("failure-rate-spike：基线低而当前窗口失败率高时命中", async () => {
    let clock = NOW - 10 * HOUR;
    const service = startService({ clock: () => clock });

    // 前一个 6h 窗口：20 条全部成功。
    for (let index = 0; index < 20; index += 1) service.emit(makeInput({ name: "canvas.open" }));
    await service.flush();

    // 当前 6h 窗口：20 条里 10 条失败。
    clock = NOW - 3 * HOUR;
    for (let index = 0; index < 10; index += 1) service.emit(makeInput({ name: "canvas.open" }));
    for (let index = 0; index < 10; index += 1) service.emit(makeInput({ name: "canvas.open", result: "failure" }));
    await service.flush();

    clock = NOW;
    const spike = (await service.anomalies("6h")).find((anomaly) => anomaly.ruleId === "failure-rate-spike");

    expect(spike).toMatchObject({
      severity: "error",
      name: "canvas.open",
      window: "6h",
      observed: 0.5,
      baseline: 0,
      samples: 20
    });
  });

  it("new-error-code：只报保留期内从未出现过的错误码", async () => {
    let clock = NOW - 8 * HOUR;
    const service = startService({ clock: () => clock });

    // 基线窗口里已经出现过 `known-failure`。
    service.emit(makeInput({ name: "canvas.open", result: "failure", errorCode: "known-failure" }));
    await service.flush();

    clock = NOW - HOUR;
    service.emit(makeInput({ name: "canvas.open", result: "failure", errorCode: "known-failure" }));
    service.emit(makeInput({ name: "canvas.open", result: "failure", errorCode: "brand-new" }));
    await service.flush();

    clock = NOW;
    const fresh = (await service.anomalies("6h")).filter((anomaly) => anomaly.ruleId === "new-error-code");

    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.evidence.code).toBe("brand-new");
  });

  it("event-silence：当前窗口完全消失但前两窗都有足够计数", async () => {
    let clock = NOW - 14 * HOUR;
    const service = startService({ clock: () => clock });

    // 更早窗口 [NOW-18h, NOW-12h)。
    for (let index = 0; index < 5; index += 1) service.emit(makeInput({ name: "sync.connect" }));
    await service.flush();

    // 前一个窗口 [NOW-12h, NOW-6h)。
    clock = NOW - 8 * HOUR;
    for (let index = 0; index < 5; index += 1) service.emit(makeInput({ name: "sync.connect" }));
    await service.flush();

    // 当前窗口只有别的事件，`sync.connect` 一条都没有。
    clock = NOW - HOUR;
    service.emit(makeInput({ name: "canvas.open" }));
    await service.flush();

    clock = NOW;
    const silence = (await service.anomalies("6h")).find((anomaly) => anomaly.ruleId === "event-silence");

    expect(silence).toMatchObject({ name: "sync.connect", observed: 0, baseline: 5, samples: 0 });
    expect(silence?.evidence).toEqual({ current: 0, previous: 5, earlier: 5 });
  });

  it("latency-regression：当前窗口 p95 达到基线 1.5 倍时命中", async () => {
    let clock = NOW - 8 * HOUR;
    const service = startService({ clock: () => clock });

    for (let index = 0; index < 20; index += 1) service.emit(makeInput({ name: "canvas.save", durationMs: 100 }));
    await service.flush();

    clock = NOW - 2 * HOUR;
    for (let index = 0; index < 20; index += 1) service.emit(makeInput({ name: "canvas.save", durationMs: 300 }));
    await service.flush();

    clock = NOW;
    const latency = (await service.anomalies("6h")).find((anomaly) => anomaly.ruleId === "latency-regression");

    expect(latency).toMatchObject({ name: "canvas.save", observed: 300, baseline: 100, samples: 20 });
    expect(latency?.evidence.ratio).toBe(3);
  });
});

describe("队列与存储降级", () => {
  it("队列满时丢最旧并计入 droppedOverflow", async () => {
    const service = startService();
    // 同步入队期间没有 await：setImmediate 排空不会插进来。
    for (let index = 0; index < 2100; index += 1) service.emit(makeInput({ name: "canvas.edit" }));

    const status = await service.status();
    expect(status.queued).toBe(2048);
    expect(status.droppedOverflow).toBe(52);

    await service.flush();
    // 丢的是最旧的 52 条，写进去的是剩下的 2048 条。
    expect((await service.status()).eventCount).toBe(2048);
  });

  it("存储打不开时整体降级：status/store/query/summary/anomalies/emit 都不炸", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-degraded-"));
    dirs.push(dir);
    // 父级是一个普通文件 → 建目录失败，构造存储时抛错。
    const sentinel = path.join(dir, "sentinel");
    writeFileSync(sentinel, "keep-me");
    const dbPath = path.join(sentinel, "telemetry.sqlite");

    const logs: Record<string, unknown>[] = [];
    const service = startService({
      path: dbPath,
      logger: (event) => logs.push(event),
      settings: { retentionDays: () => 1, maxRows: () => 1 }
    });

    const status = await service.status();
    expect(status.store).toBe("unavailable");
    expect(status.storePath).toBe(path.resolve(dbPath));
    expect(status.eventCount).toBe(0);
    expect(status.bytes).toBe(0);
    expect(status.exports).toEqual([]);

    // 读面全部是空结果，不是异常。
    expect(await service.query()).toEqual({ events: [] });
    expect(await service.query({ window: "7d", names: ["canvas.open"] })).toEqual({ events: [] });
    expect(await service.anomalies("24h")).toEqual([]);
    expect(await service.summary("24h")).toMatchObject({ total: 0, rows: [], series: [] });
    expect(await service.clear()).toBe(0);

    // 写入路径静默丢弃，绝不抛错。
    expect(() => service.emit(makeInput())).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();

    expect(logs.map((event) => event.event)).toContain("telemetry-store-unavailable");
    // 不删除既有文件。
    expect(readFileSync(sentinel, "utf8")).toBe("keep-me");
  });

  it("既有库文件损坏时只降级，不删除、不改写文件", async () => {
    const dbPath = tempDbPath();
    const garbage = Buffer.from("this is definitely not a sqlite database\n".repeat(64));
    writeFileSync(dbPath, garbage);

    const service = startService({ path: dbPath });

    expect((await service.status()).store).toBe("unavailable");
    expect(readFileSync(dbPath).equals(garbage)).toBe(true);
  });

  it("logger 自己抛错也不影响业务路径", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-logger-"));
    dirs.push(dir);
    const sentinel = path.join(dir, "sentinel");
    writeFileSync(sentinel, "keep-me");

    // 存储不可用会触发一次日志；日志实现抛错必须被吞掉，否则构造服务就会失败。
    const service = startService({
      path: path.join(sentinel, "telemetry.sqlite"),
      logger: () => {
        throw new Error("logger boom");
      }
    });

    expect((await service.status()).store).toBe("unavailable");
    expect(() => service.emit(makeInput())).not.toThrow();
    expect(() => service.emit({ name: "nope", result: "success", origin: "browser" } as unknown as TelemetryEventInput)).not.toThrow();
  });
});

describe("导出口接缝", () => {
  type ExportSpy = {
    readonly provider: TelemetryExport;
    readonly calls: readonly (readonly TelemetryEvent[])[];
  };

  function spyExport(
    exportId: string,
    options: {
      available?: boolean;
      result?: TelemetryExportResult | (() => Promise<TelemetryExportResult>) | "throw";
    } = {}
  ): ExportSpy {
    const calls: Array<readonly TelemetryEvent[]> = [];
    const provider: TelemetryExport = {
      exportId,
      ...(options.available === undefined ? {} : { available: options.available }),
      send: (batch) => {
        calls.push(batch);
        if (options.result === "throw") throw new Error("export boom");
        if (typeof options.result === "function") return options.result();
        return options.result ?? { ok: true, accepted: batch.length };
      }
    };
    return { provider, calls };
  }

  it("export.enabled 为 false 时零调用（不是发了被拒）", async () => {
    const service = startService({ settings: { exportEnabled: () => false } });
    const spy = spyExport("alpha");
    service.registerExport(spy.provider);

    service.emit(makeInput());
    await service.flush();
    await settle();

    expect(spy.calls).toHaveLength(0);
    expect((await service.status()).exportEnabled).toBe(false);
  });

  it("投递所有可用出口，跳过 available:false", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const alpha = spyExport("alpha");
    const beta = spyExport("beta");
    const offline = spyExport("offline", { available: false });
    service.registerExport(alpha.provider);
    service.registerExport(beta.provider);
    service.registerExport(offline.provider);

    service.emit(makeInput());
    service.emit(makeInput({ name: "canvas.save" }));
    await service.flush();
    await settle();

    expect(alpha.calls).toHaveLength(1);
    expect(beta.calls).toHaveLength(1);
    expect(offline.calls).toHaveLength(0);
    expect(alpha.calls[0]).toHaveLength(2);
  });

  it("core 不挑选目的地：新注册的出口无需任何设置就参与投递", async () => {
    // 「发到哪」是出口自己的配置，core 里没有目的地列表。因此任意数量的出口都按自己的
    // available 自述参与投递，注册即生效——不存在"配了 id 才发"的第二套开关。
    const service = startService({ settings: { exportEnabled: () => true } });
    const alpha = spyExport("alpha");
    const beta = spyExport("beta");
    const gamma = spyExport("gamma");
    for (const spy of [alpha, beta, gamma]) service.registerExport(spy.provider);

    service.emit(makeInput());
    await service.flush();
    await settle();

    expect([alpha.calls.length, beta.calls.length, gamma.calls.length]).toEqual([1, 1, 1]);
    expect((await service.status()).exports.map((entry) => entry.exportId).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("出口抛错/返回 ok:false 时只记账：不抛出、不重试", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const thrower = spyExport("thrower", { result: "throw" });
    const failer = spyExport("failer", { result: { ok: false, code: "rate-limited", message: "slow down" } });
    service.registerExport(thrower.provider);
    service.registerExport(failer.provider);

    service.emit(makeInput());
    await expect(service.flush()).resolves.toBeUndefined();
    await settle();

    // 只有一次调用：重试会让远端计数翻倍（design D8）。
    expect(thrower.calls).toHaveLength(1);
    expect(failer.calls).toHaveLength(1);

    const status = await service.status();
    const throwerStatus = status.exports.find((entry) => entry.exportId === "thrower")!;
    const failerStatus = status.exports.find((entry) => entry.exportId === "failer")!;
    // 抛错没有稳定错误码，归到我们自己的 `send-failed`。
    expect(throwerStatus).toMatchObject({ dropped: 1, lastError: "send-failed", available: true });
    expect(failerStatus).toMatchObject({ dropped: 1, lastError: "rate-limited" });
  });

  it("出口返回的错误码形状不合法时收敛成 send-failed", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const badCode = spyExport("bad-code", { result: { ok: false, code: "Not A Stable Code!" } });
    service.registerExport(badCode.provider);

    service.emit(makeInput());
    await service.flush();
    await settle();

    const entry = (await service.status()).exports.find((candidate) => candidate.exportId === "bad-code")!;
    expect(entry.lastError).toBe("send-failed");
  });

  it("成功的出口不记丢弃、不留 lastError", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const spy = spyExport("alpha", { result: { ok: true, accepted: 1 } });
    service.registerExport(spy.provider);

    service.emit(makeInput());
    await service.flush();
    await settle();

    const entry = (await service.status()).exports.find((candidate) => candidate.exportId === "alpha")!;
    expect(entry).toMatchObject({ dropped: 0 });
    expect(entry.lastError).toBeUndefined();
  });

  it("按 64 条一批投递，flush 会排空全部批次", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const spy = spyExport("alpha");
    service.registerExport(spy.provider);

    for (let index = 0; index < 130; index += 1) service.emit(makeInput({ name: "canvas.edit" }));
    await service.flush();
    await settle();

    expect(spy.calls.map((batch) => batch.length)).toEqual([64, 64, 2]);
  });

  it("registerExport 的注销只作用于自己；同 id 重建后旧注销不影响新出口", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    const first = spyExport("alpha");
    const unregisterFirst = service.registerExport(first.provider);
    expect(service.listExports().map((provider) => provider.exportId)).toEqual(["alpha"]);

    // 同 id 重新注册视为替换。
    const second = spyExport("alpha");
    service.registerExport(second.provider);
    expect(service.listExports()).toHaveLength(1);

    // 旧实例的回滚不得注销新的。
    unregisterFirst();
    expect(service.listExports()).toHaveLength(1);

    service.emit(makeInput());
    await service.flush();
    await settle();
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);

    service.unregisterExport("alpha");
    expect(service.listExports()).toEqual([]);
  });
});

describe("清空与状态快照", () => {
  it("clear 先把队列写盘再删，返回删除条数", async () => {
    const service = startService();
    service.emit(makeInput({ name: "canvas.open" }));
    service.emit(makeInput({ name: "canvas.save" }));
    // 不 flush：清空也要把排队的旧事件算进去，否则清完又"冒出来"。
    expect(await service.clear()).toBe(2);

    expect((await service.status()).queued).toBe(0);
    expect((await service.query()).events).toEqual([]);

    // 已落库的行同样清掉。
    service.emit(makeInput());
    await service.flush();
    expect(await service.clear()).toBe(1);
  });

  it("status 快照给出可用状态与文件体积", async () => {
    const service = startService({ settings: { exportEnabled: () => true } });
    service.emit(makeInput());
    await service.flush();

    const status = await service.status();
    expect(status).toMatchObject({
      enabled: true,
      exportEnabled: true,
      store: "ok",
      queued: 0,
      droppedInvalid: 0,
      droppedOverflow: 0,
      writeErrors: 0,
      eventCount: 1
    });
    // 库文件位置**总是**给出：可用时它是核对占用的依据（`bytes` 对应哪个文件），
    // 不可用时它是"该去处理哪个文件"的答案。读面在启用访问控制时受 `telemetry.inspect` 保护。
    expect(typeof status.storePath).toBe("string");
    expect(status.storePath?.endsWith("telemetry.sqlite")).toBe(true);
    expect(status.bytes).toBeGreaterThan(0);
  });
});
