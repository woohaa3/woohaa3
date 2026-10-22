/**
 * 通知点击落地（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.4）。
 *
 * 点击只映射成既有 App Router 的 task-history 位置：单任务定位 taskKey，合并通知/失效目标
 * 落到历史列表，测试通知不导航。
 */
import { describe, expect, it } from "vitest";
import { notificationClickLocation } from "./click-landing.js";

describe("通知点击落地", () => {
  it("单任务目标定位历史详情（带 canvas/node 身份）", () => {
    expect(
      notificationClickLocation({ test: false, target: { taskKey: "t1", canvasId: "c1", nodeId: "n1" } })
    ).toEqual({
      page: "task-history",
      history: { taskKey: "t1", canvasId: "c1", nodeId: "n1" }
    });
  });

  it("合并通知或失效目标落到历史列表，不猜测归属", () => {
    expect(notificationClickLocation({ test: false, target: null })).toEqual({
      page: "task-history",
      history: {}
    });
  });

  it("测试通知点击不导航", () => {
    expect(notificationClickLocation({ test: true, target: null })).toBeNull();
    expect(
      notificationClickLocation({ test: true, target: { taskKey: "t1" } })
    ).toBeNull();
  });

  it("只产生 task-history 位置，不携带任意 URL 或额外页面", () => {
    const location = notificationClickLocation({ test: false, target: { taskKey: "t1" } });
    expect(location?.page).toBe("task-history");
    expect(Object.keys(location!).sort()).toEqual(["history", "page"]);
    expect(JSON.stringify(location)).not.toContain("://");
  });
});
