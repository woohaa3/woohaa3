/**
 * 片场总览 LOD 遥测采样测试（2026-10-28）。
 *
 * 守三条口径：
 * - 缩放停止后只写一条，连续缩放只在停止后写；
 * - LOD 还在准备时按重试等待，稳定后再写；
 * - 定时心跳对相同结果去重，静止画布不会堆同一条事实。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import {
  installOverviewLodTelemetry,
  readOverviewLodDistribution,
  OVERVIEW_LOD_TELEMETRY,
  type OverviewLodTelemetryOptions
} from "./overview-lod-telemetry.js";
import { setTelemetryBuildModeForTesting, setTelemetryClientForTesting } from "../../services/telemetry-performance.js";

type Root = {
  nodeId?: string;
  published?: string;
  desired?: string;
  preparing?: boolean;
  viewportFraction?: number | null;
  reason?: string;
};

function diagnostics(roots: readonly Root[], pins?: readonly string[]): unknown {
  return { models: { overviewLod: { roots, ...(pins ? { pins } : {}) } } };
}

function client() {
  const events: TelemetryEventInput[] = [];
  return {
    events,
    record: (input: TelemetryEventInput) => events.push(input),
    flush: () => undefined,
    status: () => ({ queued: events.length, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 }),
    dispose: () => undefined
  };
}

/** 可控时钟 + 定时器：测试自己决定"过多久"。 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const entries = new Map<number, { at: number; handler: () => void; interval?: number }>();
  const schedule = (handler: () => void, ms: number, interval: boolean): number => {
    const id = nextId++;
    entries.set(id, { at: now + ms, handler, ...(interval ? { interval: ms } : {}) });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (handler: () => void, ms: number) => schedule(handler, ms, false),
    clearTimeout: (id: unknown) => {
      entries.delete(id as number);
    },
    setInterval: (handler: () => void, ms: number) => schedule(handler, ms, true),
    clearInterval: (id: unknown) => {
      entries.delete(id as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let next: [number, { at: number; handler: () => void; interval?: number }] | null = null;
        for (const entry of entries) {
          if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry;
        }
        if (next === null) break;
        const [id, entry] = next;
        now = entry.at;
        if (entry.interval === undefined) entries.delete(id);
        else entry.at = now + entry.interval;
        entry.handler();
      }
      now = target;
    },
    pending: () => entries.size
  };
}

function install(clock: ReturnType<typeof fakeClock>, options: Partial<OverviewLodTelemetryOptions> & { read: () => unknown }) {
  return installOverviewLodTelemetry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    now: clock.now,
    isHidden: () => false,
    ...options
  });
}

afterEach(() => {
  setTelemetryClientForTesting(undefined);
  setTelemetryBuildModeForTesting(undefined);
});

describe("总览 LOD 分布提取", () => {
  it("按已发布档位计数，并把准备中与最大占比一并给出", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([
        { published: "Low", desired: "Low", preparing: false, viewportFraction: 0.12, reason: "overview" },
        { published: "Medium", desired: "High", preparing: false, viewportFraction: 0.7, reason: "overview" },
        { published: "High", desired: "Low", preparing: true, viewportFraction: 0.34, reason: "offscreen" },
        // 未知档位/非法占比不参与计数，也不污染最大值；未知原因并入 other。
        { published: "OverviewLow", viewportFraction: null, reason: "medium-dwell" }
      ])
    );
    expect(distribution).toEqual({
      low: 1,
      medium: 1,
      high: 1,
      preparing: 2,
      fractionMax: 0.7,
      reasons: { overview: 2, offscreen: 1, other: 1 }
    });
  });

  it("缺 overviewLod / roots 不是数组时返回 null（不猜档位）", () => {
    expect(readOverviewLodDistribution({})).toBeNull();
    expect(readOverviewLodDistribution({ models: {} })).toBeNull();
    expect(readOverviewLodDistribution({ models: { overviewLod: { roots: "nope" } } })).toBeNull();
  });

  it("没有有限占比时省略 fractionMax", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([{ published: "Low", desired: "Low", reason: "overview" }])
    );
    expect(distribution).toEqual({ low: 1, medium: 0, high: 0, preparing: 0, reasons: { overview: 1 } });
  });

  it("有场景时把 high-owner 细分为选中/聚焦/编辑/声明缺失", () => {
    const scene = {
      selection: { nodes: ["aaaaaaaaaaaa"] },
      modelFocus: { nodeId: "bbbbbbbbbbbb" },
      modelEditor: { nodeId: "cccccccccccc" },
      nodes: [
        { id: "aaaaaaaaaaaa", compositeAsset: { geometryQuality: "overview-primitives-v1" } },
        { id: "bbbbbbbbbbbb", compositeAsset: { geometryQuality: "overview-primitives-v1" } },
        { id: "cccccccccccc", compositeAsset: { geometryQuality: "overview-primitives-v1" } },
        // 渲染器仍按总览根保留，但这一帧场景没带声明。
        { id: "dddddddddddd" },
        { id: "eeeeeeeeeeee", compositeAsset: { geometryQuality: "overview-primitives-v1" } }
      ]
    };
    const distribution = readOverviewLodDistribution(
      diagnostics(
        ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "eeeeeeeeeeee"].map((nodeId) => ({
          nodeId,
          published: "High",
          desired: "High",
          reason: "high-owner"
        }))
      ),
      scene
    );
    expect(distribution?.reasons).toEqual({
      "high-selected": 1,
      "high-focus": 1,
      "high-edit": 1,
      "high-undeclared": 1,
      "high-owner": 1
    });
    expect(distribution?.owners?.map((owner) => owner.reason)).toEqual([
      "high-selected",
      "high-focus",
      "high-edit",
      "high-undeclared",
      "high-owner"
    ]);
  });

  it("根已不在这一帧场景里时标记 high-missing（档位是上一帧残留）", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([{ nodeId: "aaaaaaaaaaaa", published: "High", desired: "High", reason: "high-owner" }]),
      { selection: { nodes: [] }, nodes: [{ id: "some-other-node" }] }
    );
    expect(distribution?.reasons).toEqual({ "high-missing": 1 });
  });

  it("渲染器已细分的高优先原因按原词统计", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([
        { nodeId: "aaaaaaaaaaaa", published: "High", desired: "High", reason: "high-capture" },
        { nodeId: "bbbbbbbbbbbb", published: "High", desired: "High", reason: "high-world" },
        { nodeId: "cccccccccccc", published: "High", desired: "High", reason: "high-selected" }
      ])
    );
    expect(distribution?.reasons).toEqual({ "high-capture": 1, "high-world": 1, "high-selected": 1 });
  });

  it("把截图 pin 目标压成排序去重的末 12 字符摘要", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics(
        [{ nodeId: "root-root-root", published: "High", desired: "High", reason: "high-capture" }],
        ["shot-preview:pin-bbbbbbbbbbbb", "shot-preview:pin-aaaaaaaaaaaa", "shot-preview:pin-bbbbbbbbbbbb"]
      )
    );
    expect(distribution?.pins).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(distribution?.pinsOmitted).toBeUndefined();
  });

  it("优先用 captureRequests 的节点 + 来源标识 pin（谁把根按在 High）", () => {
    const distribution = readOverviewLodDistribution({
      models: {
        overviewLod: {
          roots: [{ nodeId: "root-root-root", published: "High", desired: "High", reason: "high-capture" }],
          pins: ["1f2770cab380", "9948c12fa6c1"],
          captureRequests: [
            { nodeId: "film-set-aaaaaaaaaaaa", source: "video-export" },
            { nodeId: "film-set-aaaaaaaaaaaa", source: "video-export" },
            { nodeId: "film-set-bbbbbbbbbbbb", source: "shot-image" }
          ]
        }
      }
    });
    expect(distribution?.pins).toEqual(["aaaaaaaaaaaa:video-export", "bbbbbbbbbbbb:shot-image"]);
  });

  it("截图 pin 超过保留上限时记下省略条数", () => {
    const pins = Array.from({ length: 10 }, (_, index) => `pin-${String(index).padStart(12, "0")}`);
    const distribution = readOverviewLodDistribution(
      diagnostics([{ nodeId: "root-root-root", published: "High", desired: "High", reason: "high-capture" }], pins)
    );
    expect(distribution?.pins).toHaveLength(8);
    expect(distribution?.pinsOmitted).toBe(2);
  });

  it("没有场景时保留笼统的 high-owner", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([{ nodeId: "aaaaaaaaaaaa", published: "High", desired: "High", reason: "high-owner" }])
    );
    expect(distribution?.reasons).toEqual({ "high-owner": 1 });
  });

  it("非总览根按原因优先级给出可回查摘要，总览根不进 owners", () => {
    const distribution = readOverviewLodDistribution(
      diagnostics([
        { nodeId: "aaaaaaaaaaaa", published: "Low", desired: "Low", reason: "overview" },
        { nodeId: "bbbbbbbbbbbb", published: "High", desired: "High", reason: "offscreen" },
        { nodeId: "cccccccccccc", published: "High", desired: "High", reason: "high-owner" },
        { nodeId: "dddddddddddd", published: "High", desired: "High", reason: "degenerate" }
      ])
    );
    // 摘要是节点 id 的末 12 个字符；同原因按摘要排序，屏外排在高优先消费者之后。
    expect(distribution?.owners).toEqual([
      { digest: "cccccccccccc", reason: "high-owner" },
      { digest: "dddddddddddd", reason: "degenerate" },
      { digest: "bbbbbbbbbbbb", reason: "offscreen" }
    ]);
  });
});

describe("总览 LOD 遥测采样", () => {
  it("缩放停止后写一条聚合分布，不带 nodeId", () => {
    setTelemetryBuildModeForTesting("production");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, {
      read: () =>
        diagnostics([
          { nodeId: "film-a", published: "Low", desired: "Low", viewportFraction: 0.2, reason: "overview" },
          { nodeId: "film-b", published: "Low", desired: "Low", viewportFraction: 0.4, reason: "overview" }
        ])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      name: "perf.lod",
      result: "success",
      origin: "browser",
      surface: "canvas",
      attributes: {
        mode: "production",
        low: 2,
        medium: 0,
        high: 0,
        preparing: 0,
        fractionMax: 0.4,
        reasons: "overview=2"
      }
    });
    expect(sink.events[0]!.attributes).not.toHaveProperty("node");
    handle.dispose();
  });

  it("dev 构建带非总览根摘要（最多 3 条，其余折成 +N），发布构建不带", () => {
    const roots: Root[] = [
      { nodeId: "aaaaaaaaaaaa", published: "Low", desired: "Low", reason: "overview" },
      { nodeId: "bbbbbbbbbbbb", published: "High", desired: "High", reason: "offscreen" },
      { nodeId: "cccccccccccc", published: "High", desired: "High", reason: "high-owner" },
      { nodeId: "dddddddddddd", published: "High", desired: "High", reason: "high-owner" },
      { nodeId: "eeeeeeeeeeee", published: "High", desired: "High", reason: "degenerate" },
      { nodeId: "ffffffffffff", published: "High", desired: "High", reason: "motion-bounds" }
    ];
    for (const mode of ["dev", "production"] as const) {
      setTelemetryBuildModeForTesting(mode);
      const sink = client();
      setTelemetryClientForTesting(sink);
      const clock = fakeClock();
      const handle = install(clock, { read: () => diagnostics(roots) });
      clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
      expect(sink.events).toHaveLength(1);
      if (mode === "dev") {
        expect(sink.events[0]!.attributes).toMatchObject({
          reasons: "high-owner=2,degenerate=1,motion-bounds=1,offscreen=1,overview=1",
          owners: "cccccccccccc:high-owner,dddddddddddd:high-owner,eeeeeeeeeeee:degenerate,+2"
        });
      } else {
        expect(sink.events[0]!.attributes).not.toHaveProperty("owners");
      }
      handle.dispose();
    }
  });

  it("dev 构建把截图 pin 目标写进 pins（最多 3 条 +N），发布构建不带", () => {
    const roots: Root[] = [{ nodeId: "owner-zzzzzzzzzzzz", published: "High", desired: "High", reason: "high-capture" }];
    const pins = [
      "shot-preview:pin-aaaaaaaaaaaa",
      "shot-preview:pin-bbbbbbbbbbbb",
      "shot-preview:pin-cccccccccccc",
      "shot-preview:pin-dddddddddddd"
    ];
    for (const mode of ["dev", "production"] as const) {
      setTelemetryBuildModeForTesting(mode);
      const sink = client();
      setTelemetryClientForTesting(sink);
      const clock = fakeClock();
      const handle = install(clock, { read: () => diagnostics(roots, pins) });
      clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
      expect(sink.events).toHaveLength(1);
      if (mode === "dev") {
        expect(sink.events[0]!.attributes).toMatchObject({
          reasons: "high-capture=1",
          owners: "zzzzzzzzzzzz:high-capture",
          pins: "aaaaaaaaaaaa,bbbbbbbbbbbb,cccccccccccc,+1"
        });
      } else {
        expect(sink.events[0]!.attributes).not.toHaveProperty("pins");
      }
      handle.dispose();
    }
  });

  it("非总览根集合变化会打破心跳去重", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    let nodeId = "aaaaaaaaaaaa";
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ nodeId, published: "High", desired: "High", reason: "high-owner" }])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    // 档位与原因都不变，只有「是哪个根」变了：仍应补一条新事实。
    nodeId = "bbbbbbbbbbbb";
    clock.advance(OVERVIEW_LOD_TELEMETRY.heartbeatMs - OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]!.attributes).toMatchObject({ owners: "bbbbbbbbbbbb:high-owner" });
    handle.dispose();
  });

  it("dev 构建用最近场景把 high-owner 细分成 high-selected", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ nodeId: "aaaaaaaaaaaa", published: "High", desired: "High", reason: "high-owner" }]),
      readScene: () => ({ selection: { nodes: ["aaaaaaaaaaaa"] }, nodes: [] })
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.attributes).toMatchObject({
      reasons: "high-selected=1",
      owners: "aaaaaaaaaaaa:high-selected"
    });
    handle.dispose();
  });

  it("读取场景失败时退回 high-owner，不丢弃采样", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ nodeId: "aaaaaaaaaaaa", published: "High", desired: "High", reason: "high-owner" }]),
      readScene: () => {
        throw new Error("scene unavailable");
      }
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.attributes).toMatchObject({
      reasons: "high-owner=1",
      owners: "aaaaaaaaaaaa:high-owner"
    });
    handle.dispose();
  });

  it("连续缩放只在最后一次变化停止后写一条", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, { read: () => diagnostics([{ published: "Medium", desired: "Medium" }]) });
    handle.viewportChanged(1.1);
    clock.advance(800);
    handle.viewportChanged(1.2);
    clock.advance(800);
    expect(sink.events).toHaveLength(0);
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    handle.dispose();
  });

  it("相同 zoom 的重复回调不重臂采样", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, { read: () => diagnostics([{ published: "Low", desired: "Low" }]) });
    handle.viewportChanged(2);
    clock.advance(1_000);
    handle.viewportChanged(2);
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs - 1_000);
    expect(sink.events).toHaveLength(1);
    handle.dispose();
  });

  it("仍在准备时按重试等待，稳定后只写最终分布", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    let settled = false;
    const clock = fakeClock();
    const handle = install(clock, {
      read: () =>
        settled
          ? diagnostics([{ published: "Low", desired: "Low", preparing: false, viewportFraction: 0.1 }])
          : diagnostics([{ published: "High", desired: "Low", preparing: true, viewportFraction: 0.1 }])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(0);
    settled = true;
    clock.advance(OVERVIEW_LOD_TELEMETRY.retryMs);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.attributes).toMatchObject({ low: 1, high: 0, preparing: 0 });
    handle.dispose();
  });

  it("重试次数用尽后按当前实际档位写入，并保留准备中计数", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ published: "High", desired: "Low", preparing: true }])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    for (let index = 0; index < OVERVIEW_LOD_TELEMETRY.maxRetries; index += 1) {
      clock.advance(OVERVIEW_LOD_TELEMETRY.retryMs);
    }
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.attributes).toMatchObject({ high: 1, preparing: 1 });
    handle.dispose();
  });

  it("定时心跳对相同结果去重，超过 10 分钟再写一条", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, { read: () => diagnostics([{ published: "Low", desired: "Low" }]) });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    // 一个心跳窗口内结果未变：跳过。
    clock.advance(OVERVIEW_LOD_TELEMETRY.heartbeatMs - OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    // 超过去重窗口后的第一次心跳补齐时间线。
    clock.advance(OVERVIEW_LOD_TELEMETRY.heartbeatDedupeMs);
    expect(sink.events).toHaveLength(2);
    handle.dispose();
  });

  it("原因变化会打破心跳去重：同一档位分布也能看出从屏外变成总览", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    let reason = "offscreen";
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ published: "High", desired: "High", reason }])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.attributes).toMatchObject({ high: 1, reasons: "offscreen=1" });
    reason = "high-owner";
    clock.advance(OVERVIEW_LOD_TELEMETRY.heartbeatMs - OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]!.attributes).toMatchObject({ high: 1, reasons: "high-owner=1" });
    handle.dispose();
  });

  it("原因计数按数量降序压成单行，未知原因并入 other", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, {
      read: () =>
        diagnostics([
          { published: "Low", desired: "Low", reason: "overview" },
          { published: "Low", desired: "Low", reason: "overview" },
          { published: "Low", desired: "Low", reason: "overview" },
          { published: "High", desired: "High", reason: "high-owner" },
          { published: "High", desired: "High", reason: "high-owner" },
          { published: "High", desired: "High", reason: "preparing" },
          { published: "Low", desired: "Low", reason: "held" }
        ])
    });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events[0]!.attributes).toMatchObject({ reasons: "overview=3,high-owner=2,other=2" });
    handle.dispose();
  });

  it("页面隐藏丢弃在途采样，恢复后重新采样", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    let hidden = false;
    const clock = fakeClock();
    const handle = install(clock, {
      read: () => diagnostics([{ published: "Medium", desired: "Medium" }]),
      isHidden: () => hidden
    });
    clock.advance(1_000);
    hidden = true;
    handle.visibilityChanged(true);
    clock.advance(5_000);
    expect(sink.events).toHaveLength(0);
    hidden = false;
    handle.visibilityChanged(false);
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(1);
    handle.dispose();
  });

  it("没有声明总览 LOD 的根、或诊断形状不可读时不写事件", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const empty = fakeClock();
    const emptyHandle = install(empty, { read: () => diagnostics([]) });
    empty.advance(OVERVIEW_LOD_TELEMETRY.settleMs + OVERVIEW_LOD_TELEMETRY.heartbeatMs);
    expect(sink.events).toHaveLength(0);
    emptyHandle.dispose();

    const broken = fakeClock();
    const brokenHandle = install(broken, { read: () => ({ models: {} }) });
    broken.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(0);
    brokenHandle.dispose();
  });

  it("构建模式缺失时不发，也不留待发状态", () => {
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    const handle = install(clock, { read: () => diagnostics([{ published: "Low", desired: "Low" }]) });
    clock.advance(OVERVIEW_LOD_TELEMETRY.settleMs);
    expect(sink.events).toHaveLength(0);
    handle.dispose();
  });

  it("dispose 后不再读写诊断或定时器", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const clock = fakeClock();
    let reads = 0;
    const handle = install(clock, {
      read: () => {
        reads += 1;
        return diagnostics([{ published: "Low", desired: "Low" }]);
      }
    });
    handle.dispose();
    const before = reads;
    clock.advance(OVERVIEW_LOD_TELEMETRY.heartbeatMs * 2);
    expect(reads).toBe(before);
    expect(sink.events).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });
});
