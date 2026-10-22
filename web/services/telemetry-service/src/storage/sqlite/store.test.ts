/**
 * 遥测 SQLite 存储的行为测试（change: 2026-10-20-add-local-client-telemetry，design D4/D5）。
 *
 * 这里直接用真实的临时 SQLite 文件，不 mock 驱动：本文件要守的正是"事务、保留、分页、分位数"
 * 这些只有真实 SQL 才能证明的行为。每个用例自己建库、自己删库。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TelemetryEvent, TelemetryEventName } from "@woohaa3/contracts";
import { SqliteTelemetryStore } from "./store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 固定的"现在"：不依赖真实时钟，分桶与保留的期望值才能写死。 */
const NOW = 1_700_000_040_000;

const dirs: string[] = [];
const stores: SqliteTelemetryStore[] = [];

function openStore(): SqliteTelemetryStore {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-store-"));
  dirs.push(dir);
  const store = new SqliteTelemetryStore({ path: path.join(dir, "telemetry.sqlite") });
  stores.push(store);
  return store;
}

afterAll(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // 用例可能已经关过；清理阶段不掩盖断言结果。
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一条事件。默认 `canvas.open`/`success`/`browser`，只覆盖用例关心的字段，
 * 让每个断言里的差异一眼可见。
 */
function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    name: "canvas.open",
    result: "success",
    origin: "browser",
    occurredAt: 0,
    ...overrides
  };
}

describe("批量插入（事务原子性）", () => {
  it("一批合法事件整批落库，且共用宿主给的接收时间", () => {
    const store = openStore();
    store.insertBatch(
      [makeEvent({ name: "canvas.open" }), makeEvent({ name: "canvas.save" }), makeEvent({ name: "sync.connect" })],
      NOW
    );

    const page = store.listEvents({ since: 0, until: NOW });
    expect(page.events).toHaveLength(3);
    // 时间口径只认 received_at（宿主接收时间），不认上报端时钟。
    expect(page.events.map((event) => event.receivedAt)).toEqual([NOW, NOW, NOW]);
  });

  it("空批不产生写入", () => {
    const store = openStore();
    store.insertBatch([], NOW);
    expect(store.count(0)).toBe(0);
  });

  it("批中一条绑不上时整批回滚：不留半批脏数据", () => {
    const store = openStore();
    const broken = { ...makeEvent({ name: "canvas.save" }), name: undefined } as unknown as TelemetryEvent;

    expect(() => store.insertBatch([makeEvent(), broken], NOW)).toThrow();
    // 事务原子性：第一条合法事件也不能留下来。
    expect(store.count(0)).toBe(0);

    // 回滚之后连接仍可用，后续正常写入不受影响。
    store.insertBatch([makeEvent()], NOW);
    expect(store.count(0)).toBe(1);
  });
});

describe("保留清理 prune", () => {
  it("按时间清理：早于 cutoff 的行被删，边界上的行保留", () => {
    const store = openStore();
    const cutoff = NOW - 3 * DAY;
    store.insertBatch([makeEvent({ name: "canvas.open" })], cutoff - 1);
    store.insertBatch([makeEvent({ name: "canvas.save" })], cutoff);
    store.insertBatch([makeEvent({ name: "sync.connect" })], NOW);

    const removed = store.prune({ cutoff, maxRows: 1_000_000 });

    expect(removed).toBe(1);
    const remaining = store.listEvents({ since: 0, until: NOW }).events.map((event) => event.name);
    expect(remaining).toEqual(["sync.connect", "canvas.save"]);
  });

  it("按行数清理：只保留最新 maxRows 行（与时间上限独立触发）", () => {
    const store = openStore();
    // 五条都在保留期内；只让行数上限生效。
    for (let index = 0; index < 5; index += 1) {
      store.insertBatch([makeEvent({ name: "canvas.edit", attributes: { node: index } })], NOW - index * MINUTE);
    }

    const removed = store.prune({ cutoff: NOW - 30 * DAY, maxRows: 3 });

    expect(removed).toBe(2);
    const page = store.listEvents({ since: 0, until: NOW });
    // id 是自增的插入顺序，保留的是最后插入的三条。
    expect(page.events.map((event) => event.id)).toEqual([5, 4, 3]);
  });

  it("时间与行数两条上限同时生效时，删除数是两者之和", () => {
    const store = openStore();
    const cutoff = NOW - DAY;
    // 两条过期。
    store.insertBatch([makeEvent({ name: "canvas.open" })], cutoff - HOUR);
    store.insertBatch([makeEvent({ name: "canvas.open" })], cutoff - 1);
    // 四条未过期，但行数上限是 2。
    for (let index = 0; index < 4; index += 1) {
      store.insertBatch([makeEvent({ name: "canvas.save" })], NOW - index * MINUTE);
    }

    const removed = store.prune({ cutoff, maxRows: 2 });

    expect(removed).toBe(4);
    expect(store.count(cutoff)).toBe(2);
  });

  it("空表清理是 no-op", () => {
    const store = openStore();
    expect(store.prune({ cutoff: NOW, maxRows: 10 })).toBe(0);
  });
});

describe("事件列表 listEvents", () => {
  function seedFive(store: SqliteTelemetryStore): void {
    // 五条不同事件名/结果/错误码，`receivedAt` 都相同，排序只能靠 id，便于验证游标口径。
    store.insertBatch([makeEvent({ name: "canvas.open", result: "success" })], NOW);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "failure", errorCode: "save-failed" })], NOW);
    store.insertBatch([makeEvent({ name: "canvas.save", result: "success" })], NOW);
    store.insertBatch([makeEvent({ name: "sync.connect", result: "rejected", errorCode: "auth-failed" })], NOW);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "cancelled", errorCode: "save-failed" })], NOW);
  }

  it("最新在前（id 降序）", () => {
    const store = openStore();
    seedFive(store);

    const page = store.listEvents({ since: 0, until: NOW });

    expect(page.events.map((event) => event.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it("游标分页稳定：两页之间插入新事件不造成重复或漏读", () => {
    const store = openStore();
    seedFive(store);

    const first = store.listEvents({ since: 0, until: NOW, limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual([5, 4]);
    expect(first.nextCursor).toBe("4");

    // 翻页途中来了新事件（id 更大）；它必须只出现在"重新拉第一页"里，不能挤进下一页。
    store.insertBatch([makeEvent({ name: "canvas.edit" })], NOW);

    const second = store.listEvents({ since: 0, until: NOW, limit: 2, cursor: first.nextCursor });
    expect(second.events.map((event) => event.id)).toEqual([3, 2]);
    // 两页合起来没有重复、没有漏条。
    expect([...first.events, ...second.events].map((event) => event.id)).toEqual([5, 4, 3, 2]);
  });

  it("最后一页没有 nextCursor", () => {
    const store = openStore();
    seedFive(store);
    const page = store.listEvents({ since: 0, until: NOW, limit: 5 });
    expect(page.events).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it("非法游标降级为第一页而不是报错", () => {
    const store = openStore();
    seedFive(store);
    const page = store.listEvents({ since: 0, until: NOW, cursor: "not-a-cursor" });
    expect(page.events.map((event) => event.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it("names / results / errorCode 组合筛选", () => {
    const store = openStore();
    seedFive(store);

    const byName = store.listEvents({ since: 0, until: NOW, names: ["canvas.open"] });
    expect(byName.events.map((event) => event.id)).toEqual([5, 2, 1]);

    const byResult = store.listEvents({ since: 0, until: NOW, results: ["failure", "rejected"] });
    expect(byResult.events.map((event) => event.id)).toEqual([4, 2]);

    const byCode = store.listEvents({ since: 0, until: NOW, errorCode: "save-failed" });
    expect(byCode.events.map((event) => event.id)).toEqual([5, 2]);

    const combined = store.listEvents({
      since: 0,
      until: NOW,
      names: ["canvas.open"],
      results: ["failure"],
      errorCode: "save-failed"
    });
    expect(combined.events.map((event) => event.id)).toEqual([2]);
  });

  it("时间窗是闭区间", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW - HOUR);
    store.insertBatch([makeEvent({ name: "canvas.save" })], NOW);

    const page = store.listEvents({ since: NOW - HOUR, until: NOW });
    expect(page.events).toHaveLength(2);
    expect(store.listEvents({ since: NOW - HOUR + 1, until: NOW }).events.map((event) => event.name)).toEqual([
      "canvas.save"
    ]);
  });

  it("单页缺省 50 条、上限 200 条", () => {
    const store = openStore();
    const events: TelemetryEvent[] = Array.from({ length: 210 }, (_unused, index) =>
      makeEvent({ name: index % 2 === 0 ? "canvas.open" : "canvas.save" })
    );
    store.insertBatch(events, NOW);

    const defaultPage = store.listEvents({ since: 0, until: NOW });
    expect(defaultPage.events).toHaveLength(50);
    expect(defaultPage.nextCursor).toBeDefined();

    const maxPage = store.listEvents({ since: 0, until: NOW, limit: 5_000 });
    expect(maxPage.events).toHaveLength(200);

    // 非法 limit 收敛到 [1, 200]，不会退化成"一页零条"或一次拉全表。
    expect(store.listEvents({ since: 0, until: NOW, limit: 0 }).events).toHaveLength(1);
    expect(store.listEvents({ since: 0, until: NOW, limit: Number.NaN }).events).toHaveLength(50);
  });

  it("读回的记录保留可选字段形状，缺省字段不出现", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({
          name: "canvas.save",
          surface: "editor",
          durationMs: 42,
          errorCode: "save-failed",
          traceId: "0123456789abcdef0123456789abcdef",
          frontendVersion: "0.1.0",
          attributes: { node: "n1", status: "ok" }
        })
      ],
      NOW
    );
    store.insertBatch([makeEvent({ name: "sync.connect" })], NOW);

    const [plain, rich] = store.listEvents({ since: 0, until: NOW }).events;
    expect(plain).toMatchObject({ name: "sync.connect", result: "success", origin: "browser" });
    // 空字符串在库里表示"没有"，读回时不能变成空字段。
    expect(plain?.surface).toBeUndefined();
    expect(plain?.errorCode).toBeUndefined();
    expect(plain?.traceId).toBeUndefined();
    expect(plain?.attributes).toBeUndefined();

    expect(rich).toMatchObject({
      name: "canvas.save",
      surface: "editor",
      durationMs: 42,
      errorCode: "save-failed",
      traceId: "0123456789abcdef0123456789abcdef",
      frontendVersion: "0.1.0",
      attributes: { node: "n1", status: "ok" }
    });
  });
});

describe("窗口聚合 summary", () => {
  function seedAggregate(store: SqliteTelemetryStore): void {
    store.insertBatch(
      [
        makeEvent({ name: "canvas.open", result: "success", durationMs: 10 }),
        makeEvent({ name: "canvas.open", result: "success", durationMs: 20, errorCode: "save-failed" }),
        makeEvent({ name: "canvas.open", result: "failure", durationMs: 30, errorCode: "save-failed" }),
        makeEvent({ name: "canvas.open", result: "rejected", durationMs: 40, errorCode: "quota-exceeded" })
      ],
      NOW
    );
    store.insertBatch(
      [
        makeEvent({ name: "sync.connect", result: "cancelled" }),
        makeEvent({ name: "sync.connect", result: "success", durationMs: 7 })
      ],
      NOW
    );
  }

  it("按事件名给出计数、结果四项分布、分位数、最大耗时与高频错误码", () => {
    const store = openStore();
    seedAggregate(store);

    const result = store.summary({ since: 0, until: NOW, bucket: "1h" });

    expect(result.total).toBe(6);
    // 最活跃的名字在前。
    expect(result.rows.map((row) => row.name)).toEqual(["canvas.open", "sync.connect"]);

    const opened = result.rows[0]!;
    expect(opened).toMatchObject({
      name: "canvas.open",
      count: 4,
      results: { success: 2, failure: 1, cancelled: 0, rejected: 1 },
      durationSamples: 4,
      // 排序取位：p50 = offset floor(0.5*3)=1 → 20；p95 = offset floor(0.95*3)=2 → 30。
      durationP50: 20,
      durationP95: 30,
      durationMax: 40,
      topErrorCodes: [
        { code: "save-failed", count: 2 },
        { code: "quota-exceeded", count: 1 }
      ]
    });

    const connected = result.rows[1]!;
    expect(connected).toMatchObject({
      name: "sync.connect",
      count: 2,
      results: { success: 1, failure: 0, cancelled: 1, rejected: 0 },
      durationSamples: 1,
      durationP50: 7,
      durationP95: 7,
      durationMax: 7,
      topErrorCodes: []
    });
  });

  it("没有耗时样本时不给分位数（只给 durationSamples: 0）", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.edit", result: "success" })], NOW);

    const row = store.summary({ since: 0, until: NOW, bucket: "1h" }).rows[0]!;
    expect(row.durationSamples).toBe(0);
    expect(row.durationP50).toBeUndefined();
    expect(row.durationP95).toBeUndefined();
    expect(row.durationMax).toBeUndefined();
  });

  it("分位数边界：单样本两端同值", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.save", durationMs: 123 })], NOW);

    const row = store.summary({ since: 0, until: NOW, bucket: "1h" }).rows[0]!;
    expect([row.durationP50, row.durationP95, row.durationMax]).toEqual([123, 123, 123]);
  });

  it("分位数边界：两个样本时 p50 与 p95 都取到较小值（排序取位口径）", () => {
    const store = openStore();
    store.insertBatch(
      [makeEvent({ name: "canvas.save", durationMs: 300 }), makeEvent({ name: "canvas.save", durationMs: 100 })],
      NOW
    );

    const row = store.summary({ since: 0, until: NOW, bucket: "1h" }).rows[0]!;
    // offset = floor(p * (n-1))：n=2 时 p50 与 p95 的 offset 都是 0，因此都取最小值。
    expect(row.durationP50).toBe(100);
    expect(row.durationP95).toBe(100);
    expect(row.durationMax).toBe(300);
  });

  it("分位数边界：全部同值时 p50 = p95 = max", () => {
    const store = openStore();
    store.insertBatch(
      Array.from({ length: 5 }, () => makeEvent({ name: "canvas.edit", durationMs: 5 })),
      NOW
    );

    const row = store.summary({ since: 0, until: NOW, bucket: "1h" }).rows[0]!;
    expect([row.durationP50, row.durationP95, row.durationMax]).toEqual([5, 5, 5]);
    expect(row.durationSamples).toBe(5);
  });

  it("分桶序列按桶起点升序，失败数含 cancelled", () => {
    const store = openStore();
    const bucketStart = NOW - (NOW % MINUTE);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "success" })], bucketStart);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "failure" })], bucketStart + 30_000);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "cancelled" })], bucketStart + 90_000);
    store.insertBatch([makeEvent({ name: "canvas.save", result: "rejected" })], bucketStart + 90_000);

    const result = store.summary({ since: bucketStart, until: bucketStart + 2 * MINUTE, bucket: "1m" });

    expect(result.series).toEqual([
      { at: bucketStart, name: "canvas.open", count: 2, failures: 1 },
      { at: bucketStart + MINUTE, name: "canvas.open", count: 1, failures: 1 },
      { at: bucketStart + MINUTE, name: "canvas.save", count: 1, failures: 1 }
    ]);
  });

  it("聚合计数与同条件列表条数一致", () => {
    const store = openStore();
    seedAggregate(store);
    const range = { since: 0, until: NOW };

    const summary = store.summary({ ...range, bucket: "1h" });
    const listed = store.listEvents({ ...range, limit: 200 });

    expect(summary.total).toBe(listed.events.length);
    for (const row of summary.rows) {
      const sameName = store.listEvents({ ...range, names: [row.name as TelemetryEventName], limit: 200 });
      expect(row.count).toBe(sameName.events.length);
      // 结果分布也不能与逐条计数脱节。
      const successes = sameName.events.filter((event) => event.result === "success").length;
      expect(row.results.success).toBe(successes);
    }
  });

  it("只统计时间范围内的行", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW - 2 * HOUR);
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW);

    const result = store.summary({ since: NOW - HOUR, until: NOW, bucket: "1h" });
    expect(result.total).toBe(1);
  });
});

describe("窗口统计 rangeStats 与错误码统计", () => {
  it("failures 只算 failure + rejected，cancelled 不算失败", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ name: "canvas.open", result: "failure" }),
        makeEvent({ name: "canvas.open", result: "rejected" }),
        makeEvent({ name: "canvas.open", result: "cancelled" }),
        makeEvent({ name: "canvas.open", result: "success" })
      ],
      NOW
    );

    const [stats] = store.rangeStats({ since: 0, until: NOW, withDurations: true });
    expect(stats).toMatchObject({ name: "canvas.open", count: 4, failures: 2, durationSamples: 0 });
  });

  it("withErrorCodes 时给出窗口内每个码的计数与首次出现时间", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open", result: "failure", errorCode: "save-failed" })], NOW - 2 * MINUTE);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "failure", errorCode: "save-failed" })], NOW - MINUTE);
    store.insertBatch([makeEvent({ name: "canvas.open", result: "failure", errorCode: "quota-exceeded" })], NOW);

    const [stats] = store.rangeStats({ since: 0, until: NOW, withErrorCodes: true });
    expect(stats?.errorCodes).toEqual([
      { name: "canvas.open", code: "save-failed", count: 2, firstSeenAt: NOW - 2 * MINUTE },
      { name: "canvas.open", code: "quota-exceeded", count: 1, firstSeenAt: NOW }
    ]);
  });

  it("hasErrorCodeBefore 只看 [since, before) 区间", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open", errorCode: "save-failed" })], NOW - 10 * MINUTE);

    expect(store.hasErrorCodeBefore("save-failed", { since: 0, before: NOW })).toBe(true);
    expect(store.hasErrorCodeBefore("save-failed", { since: 0, before: NOW - 10 * MINUTE })).toBe(false);
    expect(store.hasErrorCodeBefore("other-code", { since: 0, before: NOW })).toBe(false);
  });
});

describe("计数、体积与清空", () => {
  it("count 只数 since 之后的行", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW - DAY);
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW);

    expect(store.count(0)).toBe(2);
    expect(store.count(NOW - HOUR)).toBe(1);
  });

  it("sizeBytes 覆盖主库文件", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open" })], NOW);
    expect(store.sizeBytes()).toBeGreaterThan(0);
  });

  it("clear 删除全部行并返回删除条数", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ name: "canvas.open" }), makeEvent({ name: "canvas.save" })], NOW);

    expect(store.clear()).toBe(2);
    expect(store.count(0)).toBe(0);
    expect(store.clear()).toBe(0);
  });
});
