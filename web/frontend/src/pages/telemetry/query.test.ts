/**
 * 复盘页 URL 编解码测试
 * （change: 2026-10-25-enhance-telemetry-performance-collection，任务 4.3 / design D5）。
 *
 * 这一层守的是三件容易被"顺手改坏"的事：
 * 1. `mode` / `groupBy` 进 URL 后必须能原样解回来（否则分享链接丢筛选）；
 * 2. 非法值静默丢弃而不是抛错（URL 是用户可编辑的输入）；
 * 3. 换 `mode` 要重置游标，换 `groupBy` **不**重置——列表结果集没变。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEMETRY_WINDOW,
  decodeTelemetrySearch,
  encodeTelemetrySearch,
  hasTelemetryFilters,
  patchTelemetryQuery,
  type TelemetryQuery
} from "./query.js";

describe("遥测 URL 编解码", () => {
  it("缺省查询只有窗口", () => {
    expect(decodeTelemetrySearch(new URLSearchParams(""))).toEqual({ window: DEFAULT_TELEMETRY_WINDOW });
  });

  it("mode 与 groupBy 往返不丢", () => {
    const query: TelemetryQuery = {
      window: "7d",
      name: "perf.interaction",
      mode: "production",
      groupBy: "kind",
      cursor: "120",
      canvasId: "c1"
    };
    const encoded = encodeTelemetrySearch(query);
    expect(encoded.get("mode")).toBe("production");
    expect(encoded.get("groupBy")).toBe("kind");
    expect(decodeTelemetrySearch(encoded)).toEqual(query);
  });

  it("非法 mode / groupBy 静默丢弃（不让整页不可用）", () => {
    expect(decodeTelemetrySearch(new URLSearchParams("?mode=staging&groupBy=prompt"))).toEqual({
      window: DEFAULT_TELEMETRY_WINDOW
    });
  });

  it("mode 也算筛选（空态文案要区分「没有匹配条件」）", () => {
    expect(hasTelemetryFilters({ window: "1h" })).toBe(false);
    expect(hasTelemetryFilters({ window: "1h", mode: "dev" })).toBe(true);
  });
});

describe("筛选补丁与游标", () => {
  it("换 mode 清游标与选中项", () => {
    const next = patchTelemetryQuery({ window: "24h", mode: "dev", cursor: "9", eventId: "42" }, { mode: "production" });
    expect(next.mode).toBe("production");
    expect(next.cursor).toBeUndefined();
    expect(next.eventId).toBeUndefined();
  });

  it("换 groupBy 不重置游标——事件列表结果集没变", () => {
    const next = patchTelemetryQuery({ window: "24h", cursor: "9", eventId: "42" }, { groupBy: "kind" });
    expect(next.groupBy).toBe("kind");
    expect(next.cursor).toBe("9");
    expect(next.eventId).toBe("42");
  });

  it("空串表示取消筛选（与「未提供」区分）", () => {
    const next = patchTelemetryQuery({ window: "24h", mode: "dev", groupBy: "kind" }, { mode: "", groupBy: "" });
    expect(next.mode).toBeUndefined();
    expect(next.groupBy).toBeUndefined();
  });

  it("任何筛选补丁都保留 canvasId（它是返回目标，不是筛选）", () => {
    const next = patchTelemetryQuery({ window: "24h", canvasId: "c1", mode: "dev" }, { mode: "production" });
    expect(next.canvasId).toBe("c1");
  });
});
