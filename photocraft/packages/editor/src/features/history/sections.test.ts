/**
 * 本域入口声明回归（U74/U75/U76）。
 *
 * 只断言本域自己贡献的 section 与面板；共享 `features/boundaries.test.ts` 的 section 总数是
 * 聚合事实，由集成负责人按最终合并顺序统一（本 change 已按最小改动从 12 补到 16）。
 */
import { describe, expect, it } from "vitest";
import { feature } from "./index.js";
import { sections } from "./sections.js";

describe("历史/动作/数据驱动域入口", () => {
  it("本域只贡献面板，不抢画布手势", () => {
    expect(feature.id).toBe("history");
    expect(feature.tools).toEqual([]);
  });

  it("四个工作流各有一个入口，顺序稳定且落在高级区域", () => {
    expect(sections.map((section) => ({
      id: section.id,
      placement: section.placement,
      order: section.order,
      menu: section.menu,
      menuOrder: section.menuOrder
    }))).toEqual([
      { id: "history", placement: "advanced", order: 13, menu: "窗口", menuOrder: 0 },
      { id: "actions", placement: "advanced", order: 14, menu: "窗口", menuOrder: 1 },
      { id: "dataSets", placement: "advanced", order: 15, menu: "窗口", menuOrder: 2 },
      { id: "automation", placement: "advanced", order: 16, menu: "文件", menuOrder: 0 }
    ]);
    // 12 属同级 change（动画域时间轴）；本域从 13 起，避免两分支合入后顺序抖动。
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    expect(new Set(sections.map((section) => section.order)).size).toBe(sections.length);
  });

  it("面板同时经 FEATURE_PANELS 暴露，两处渲染同一组件", () => {
    expect(Object.keys(feature.panels).sort()).toEqual(["ActionsPanel", "AutomationPanel", "DataSetsPanel", "HistoryPanel"]);
  });
});
