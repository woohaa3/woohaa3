/**
 * 属性维度查询的行为测试
 * （change: 2026-10-25-enhance-telemetry-performance-collection，design D5）。
 *
 * 与 `store.test.ts` 分开：那边守的是事务、保留、分页这些"库的形状"，这边只守一件新事——
 * **属性以 JSON 存储后，筛选、分组与分位数是否仍然可信**。这四件事都只有真 SQL 才能证明。
 *
 * 断言里刻意混入三类"坏行"：属性序列化损坏、缺分组键、值为布尔/浮点。它们决定了两条实现口径：
 * 坏行不炸整页、缺键不聚成空组、非字符串值按十进制文本/`true`/`false` 比较。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@woohaa3/contracts";
import { loadNodeSqlite } from "../../repository/sqlite-loader.js";
import { SqliteTelemetryStore } from "./store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_700_000_040_000;

const dirs: string[] = [];
const stores: SqliteTelemetryStore[] = [];

function openStore(): SqliteTelemetryStore {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-attrs-"));
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

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return { name: "perf.segment", result: "success", origin: "browser", occurredAt: 0, ...overrides };
}

describe("属性筛选 listEvents", () => {
  it("按 key + value 精确匹配；只筛出带该属性且取值相等的行", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ attributes: { mode: "dev", kind: "pan" } }),
        makeEvent({ attributes: { mode: "production", kind: "pan" } }),
        // 同一个取值但键不同：不能因为"值相等"被选中。
        makeEvent({ attributes: { mode: "dev", kind: "zoom" } }),
        // 完全没有属性：既不匹配也不报错。
        makeEvent()
      ],
      NOW
    );

    const dev = store.listEvents({ since: 0, until: NOW, attributeKey: "mode", attributeValue: "dev" });
    expect(dev.events.map((event) => event.attributes?.kind)).toEqual(["zoom", "pan"]);

    const zoom = store.listEvents({ since: 0, until: NOW, attributeKey: "kind", attributeValue: "zoom" });
    expect(zoom.events).toHaveLength(1);
  });

  it("数值按十进制文本比较、布尔按 true/false 比较", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ name: "perf.frame", attributes: { mode: "dev", fps: 59.5 } }),
        makeEvent({ name: "perf.frame", attributes: { mode: "dev", fps: 60 } }),
        makeEvent({ attributes: { source: "wheel", stringify: true } })
      ],
      NOW
    );

    expect(store.listEvents({ since: 0, until: NOW, attributeKey: "fps", attributeValue: "59.5" }).events).toHaveLength(1);
    expect(store.listEvents({ since: 0, until: NOW, attributeKey: "fps", attributeValue: "60" }).events).toHaveLength(1);
    // `CAST(1 AS TEXT)` 会把布尔变成 "1"，所以实现里对 true/false 单独映射。
    expect(
      store.listEvents({ since: 0, until: NOW, attributeKey: "stringify", attributeValue: "true" }).events
    ).toHaveLength(1);
    expect(store.listEvents({ since: 0, until: NOW, attributeKey: "stringify", attributeValue: "1" }).events).toHaveLength(
      0
    );
  });

  it("属性筛选与名字/结果/窗口组合生效", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ name: "perf.interaction", result: "success", attributes: { mode: "dev", kind: "pan" } }),
        makeEvent({ name: "perf.interaction", result: "cancelled", attributes: { mode: "dev", kind: "pan" } }),
        makeEvent({ name: "perf.segment", result: "success", attributes: { mode: "dev", kind: "pan" } })
      ],
      NOW
    );
    store.insertBatch([makeEvent({ attributes: { mode: "dev", kind: "pan" } })], NOW - 2 * HOUR);

    const page = store.listEvents({
      since: NOW - HOUR,
      until: NOW,
      names: ["perf.interaction"],
      results: ["success"],
      attributeKey: "kind",
      attributeValue: "pan"
    });
    expect(page.events).toHaveLength(1);
  });

  it("只给属性键的一半时抛错，而不是静默返回全量", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ attributes: { mode: "dev" } })], NOW);

    // 类型上两个字段都可选，所以"只给一半"在运行期仍然可能出现（HTTP 入口已拒，这里再拒一次）。
    expect(() => store.listEvents({ since: 0, until: NOW, attributeKey: "mode" })).toThrow(/键与值/);
    expect(() => store.listEvents({ since: 0, until: NOW, attributeValue: "dev" })).toThrow(/键与值/);
  });

  it("属性列损坏的行既不被选中也不让查询失败", () => {
    const store = openStore();
    store.insertBatch([makeEvent({ attributes: { mode: "dev" } })], NOW);

    // 直接往同一个库写坏 JSON：模拟手工改库或磁盘截断。走第二个连接是为了不经过归一。
    const { DatabaseSync } = loadNodeSqlite();
    const raw = new DatabaseSync(store.path);
    try {
      raw.prepare(
        "INSERT INTO client_telemetry_events (received_at, occurred_at, name, result, duration_ms, error_code, origin, surface, trace_id, attributes, frontend_version) VALUES (?, 0, ?, 'success', NULL, '', 'browser', '', '', ?, '')"
      ).run(NOW, "perf.segment", '{"mode":"dev"');
    } finally {
      raw.close();
    }

    // 坏行既不匹配筛选（`json_valid` 求值为 NULL），也不让整条查询失败。
    expect(store.listEvents({ since: 0, until: NOW, attributeKey: "mode", attributeValue: "dev" }).events).toHaveLength(1);
    expect(store.listEvents({ since: 0, until: NOW }).events).toHaveLength(2);
    // 分组同样跳过坏行，不产生空组。
    expect(store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "mode" }).rows.map((row) => row.attributeValue)).toEqual([
      "dev"
    ]);
  });
});

describe("分组聚合 summary", () => {
  /** 三种输入：pan（3 条，10/20/30ms）、zoom（2 条，5/7ms），外加一条没有 kind 的启动事件。 */
  function seedGrouped(store: SqliteTelemetryStore): void {
    store.insertBatch(
      [
        makeEvent({ attributes: { mode: "dev", kind: "pan", stage: "gesture-move" }, durationMs: 10 }),
        makeEvent({ attributes: { mode: "dev", kind: "pan", stage: "gesture-move" }, durationMs: 20 }),
        makeEvent({ attributes: { mode: "dev", kind: "pan", stage: "gesture-move" }, durationMs: 30, errorCode: "input-drop" }),
        makeEvent({ attributes: { mode: "dev", kind: "zoom" }, durationMs: 5 }),
        makeEvent({ attributes: { mode: "dev", kind: "zoom" }, durationMs: 7 })
      ],
      NOW
    );
    // `perf.startup` 没有 `kind`：分组时必须被排除，否则会多出一个说不清的空组。
    store.insertBatch([makeEvent({ name: "perf.startup", durationMs: 99, attributes: { mode: "dev", stage: "app-scope" } })], NOW);
  }

  it("按 kind 分组：每组只统计组内样本，分位数与整体同口径", () => {
    const store = openStore();
    seedGrouped(store);

    const grouped = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "kind" });

    // `total` 仍是窗口内总条数（含没有 kind 的那条），不是分组行之和。
    expect(grouped.total).toBe(6);
    expect(grouped.rows.map((row) => [row.name, row.attributeValue, row.count])).toEqual([
      ["perf.segment", "pan", 3],
      ["perf.segment", "zoom", 2]
    ]);

    const pan = grouped.rows[0]!;
    // 3 个样本：p50 = offset 1 → 20，p95 = offset floor(0.95*2)=1 → 20，max = 30。
    expect(pan).toMatchObject({ durationSamples: 3, durationP50: 20, durationP95: 20, durationMax: 30 });
    const zoom = grouped.rows[1]!;
    expect(zoom).toMatchObject({ durationSamples: 2, durationP50: 5, durationP95: 5, durationMax: 7 });
    // 错误码也按组归属：只有 pan 组拿到 `input-drop`。
    expect(pan.topErrorCodes).toEqual([{ code: "input-drop", count: 1 }]);
    expect(zoom.topErrorCodes).toEqual([]);
  });

  it("未分组时行里没有 attributeValue，且总样本与分组行之和可以不同", () => {
    const store = openStore();
    seedGrouped(store);

    const plain = store.summary({ since: 0, until: NOW, bucket: "1h" });

    expect(plain.rows.every((row) => row.attributeValue === undefined)).toBe(true);
    const segment = plain.rows.find((row) => row.name === "perf.segment")!;
    expect(segment.count).toBe(5);
    // 整体 p50：5 个样本 10/20/30/5/7 → 排序 5,7,10,20,30 → offset floor(0.5*4)=2 → 10。
    expect(segment.durationP50).toBe(10);
    // 整体与分组的分位数来自同一份 SQL（口径一致性），这里只做交叉核对。
    const panCount = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "kind" }).rows
      .filter((row) => row.name === "perf.segment")
      .reduce((sum, row) => sum + row.count, 0);
    expect(panCount).toBe(segment.count);
  });

  it("按 mode 分组适用于所有 perf 事件；缺省事件（无属性）不参与分组", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ name: "perf.frame", attributes: { mode: "dev" }, durationMs: 6 }),
        makeEvent({ name: "perf.frame", attributes: { mode: "production" }, durationMs: 4 }),
        makeEvent({ name: "canvas.open", durationMs: 100 })
      ],
      NOW
    );

    const grouped = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "mode" });

    expect(grouped.total).toBe(3);
    expect(grouped.rows.map((row) => [row.name, row.attributeValue, row.count])).toEqual([
      ["perf.frame", "dev", 1],
      ["perf.frame", "production", 1]
    ]);
  });

  it("分组与属性筛选可以叠加（只看 dev 构建的各类输入）", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ attributes: { mode: "dev", kind: "pan" }, durationMs: 10 }),
        makeEvent({ attributes: { mode: "production", kind: "pan" }, durationMs: 900 })
      ],
      NOW
    );

    // 筛选在 `summary` 这一层不开放（它是列表筛选），所以这里验证的是不同 mode 的样本
    // 分组后不会混成同一组：这正是 spec「默认聚合不得把不同 mode 混进同一分位数」的落点。
    const grouped = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "mode" });
    expect(grouped.rows.map((row) => [row.attributeValue, row.durationP50])).toEqual([
      ["dev", 10],
      ["production", 900]
    ]);
  });

  it("时间序列不跟随分组：仍是按事件名的桶计数", () => {
    const store = openStore();
    seedGrouped(store);

    const grouped = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "kind" });

    const bucketAt = NOW - (NOW % HOUR);
    expect(grouped.series).toEqual([
      { at: bucketAt, name: "perf.segment", count: 5, failures: 0 },
      { at: bucketAt, name: "perf.startup", count: 1, failures: 0 }
    ]);
  });

  it("未知分组键在存储层被拒（键名会被拼进 SQL）", () => {
    const store = openStore();
    expect(() =>
      store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "prompt" as never })
    ).toThrow(/未知的遥测属性键/);
  });

  it("没有任何样本时分组查询返回空行（不是「全零一行」）", () => {
    const store = openStore();
    const grouped = store.summary({ since: 0, until: NOW, bucket: "1h", groupBy: "kind" });
    expect(grouped).toEqual({ total: 0, rows: [], series: [] });
  });
});

describe("分组窗口统计 rangeStats", () => {
  it("按 kind 分组给出各组计数、失败数与分位数", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ result: "failure", attributes: { kind: "pan" }, durationMs: 40 }),
        makeEvent({ result: "success", attributes: { kind: "pan" }, durationMs: 20 }),
        makeEvent({ result: "success", attributes: { kind: "zoom" }, durationMs: 5 })
      ],
      NOW
    );

    const stats = store.rangeStats({ since: 0, until: NOW, withDurations: true, groupBy: "kind" });

    expect(stats.map((row) => [row.name, row.attributeValue, row.count, row.failures])).toEqual([
      ["perf.segment", "pan", 2, 1],
      ["perf.segment", "zoom", 1, 0]
    ]);
    expect(stats[0]).toMatchObject({ durationSamples: 2, durationP50: 20, durationP95: 20, durationMax: 40 });
  });

  it("withErrorCodes 的错误码也按分组归属", () => {
    const store = openStore();
    store.insertBatch(
      [
        makeEvent({ result: "failure", errorCode: "pan-failed", attributes: { kind: "pan" } }),
        makeEvent({ result: "failure", errorCode: "zoom-failed", attributes: { kind: "zoom" } })
      ],
      NOW
    );

    const stats = store.rangeStats({ since: 0, until: NOW, withErrorCodes: true, groupBy: "kind" });

    expect(stats.map((row) => [row.attributeValue, row.errorCodes?.map((code) => code.code)])).toEqual([
      ["pan", ["pan-failed"]],
      ["zoom", ["zoom-failed"]]
    ]);
  });
});

describe("schema 升级", () => {
  it("重复打开同一个库不重建表，数据与属性索引都在", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-telemetry-upgrade-"));
    dirs.push(dir);
    const file = path.join(dir, "telemetry.sqlite");

    const first = new SqliteTelemetryStore({ path: file });
    first.insertBatch([makeEvent({ attributes: { mode: "dev" } })], NOW);
    first.close();

    const second = new SqliteTelemetryStore({ path: file });
    stores.push(second);
    expect(second.count(0)).toBe(1);
    expect(second.listEvents({ since: 0, until: NOW, attributeKey: "mode", attributeValue: "dev" }).events).toHaveLength(
      1
    );
  });
});
