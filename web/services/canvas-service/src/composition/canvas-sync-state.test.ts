/**
 * 目录同步状态合并：文档链路与媒体字节两个维度。
 *
 * 这条规则是「资源没完全同步过去时不能显示已同步」的唯一实现处，单独锁住。
 */
import { describe, expect, it } from "vitest";
import { combineCanvasSyncState } from "../composition.js";

const asset = (state: "syncing" | "synced" | "failed") => ({ state, total: 1, copied: 0, missing: 0, failed: 0, updatedAt: 0 });

describe("combineCanvasSyncState", () => {
  it("文档已同步但媒体在补传 → syncing（不提前说已同步）", () => {
    expect(combineCanvasSyncState("synced", asset("syncing"))).toBe("syncing");
  });

  it("媒体补传失败 → failed，即使文档链路正常", () => {
    expect(combineCanvasSyncState("synced", asset("failed"))).toBe("failed");
  });

  it("媒体完成或没有媒体状态时保持文档状态", () => {
    expect(combineCanvasSyncState("synced", asset("synced"))).toBe("synced");
    expect(combineCanvasSyncState("offline", undefined)).toBe("offline");
  });

  it("纯本地画布（没有上游链路）不因媒体状态变成远端同步态", () => {
    expect(combineCanvasSyncState(undefined, asset("syncing"))).toBeUndefined();
  });
});
