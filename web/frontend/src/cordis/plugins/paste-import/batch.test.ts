/**
 * 批量导入布局与汇总测试（change: add-paste-import-workflows，任务 2.3 / 4.1）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_DIMS } from "@woohaa3/contracts";
import { createImportItemId, planImportLayout, summarizeItems, type ImportItem } from "./batch.js";

function item(stage: ImportItem["stage"], id: string): ImportItem {
  return { id, name: `${id}.png`, kind: "image", size: 1, stage };
}

describe("planImportLayout", () => {
  it("首项在锚点，后续按固定间距错开且不重叠", () => {
    const positions = planImportLayout({ x: 100, y: 200 }, 4, 1);
    expect(positions[0]).toEqual({ x: 100, y: 200 });
    expect(positions[1]!.x).toBeGreaterThan(100);
    expect(positions[3]!.y).toBeGreaterThan(200);
    // 水平步长不小于节点默认宽度（不重叠）。
    expect(positions[1]!.x - positions[0]!.x).toBeGreaterThanOrEqual(DEFAULT_NODE_DIMS.width);
  });

  it("按 zoom 缩放间距，无指针时仍确定性", () => {
    const zoomed = planImportLayout({ x: 0, y: 0 }, 2, 2);
    const plain = planImportLayout({ x: 0, y: 0 }, 2, 1);
    expect(zoomed[1]!.x).toBeLessThan(plain[1]!.x);
  });
});

describe("summarizeItems", () => {
  it("统计成功/失败并报告 ok", () => {
    const summary = summarizeItems([item("done", "a"), item("done", "b"), item("failed", "c")]);
    expect(summary).toMatchObject({ ok: false, succeeded: 2, failed: 1 });
  });
});

describe("createImportItemId", () => {
  it("生成稳定唯一 ID", () => {
    expect(createImportItemId()).not.toBe(createImportItemId());
  });
});
