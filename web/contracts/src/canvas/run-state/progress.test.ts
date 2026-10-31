/**
 * 生成进度显示规则（change: 2026-10-31-unify-node-and-activity-progress）。
 *
 * 覆盖：上报值单位归一、按种类的时间估算、`max(估算, 上报)` 与 95% 封顶。节点进度环
 * （Rust `generation_progress.rs`）用同一套常量与公式，这里固定它们在 Web 侧的镜像。
 */
import { describe, expect, it } from "vitest";
import {
  GENERATION_ESTIMATE_CEILING,
  GENERATION_ESTIMATE_SECONDS,
  displayGenerationPercent,
  estimateGenerationPercent,
  generationEstimateSeconds,
  reportedProgressPercent,
  roundedGenerationPercent
} from "./progress.js";

const START = "2026-10-31T00:00:00.000Z";
const at = (seconds: number) => Date.parse(START) + seconds * 1000;

describe("上报进度单位归一", () => {
  it("0..1 分数换算为百分比", () => {
    expect(reportedProgressPercent(0)).toBe(0);
    expect(reportedProgressPercent(0.42)).toBeCloseTo(42);
    expect(reportedProgressPercent(1)).toBe(100);
  });

  it("已经是百分比的值原样保留", () => {
    expect(reportedProgressPercent(42)).toBe(42);
    expect(reportedProgressPercent(150)).toBe(100);
    expect(reportedProgressPercent(-5)).toBe(0);
  });

  it("缺失或非法值返回 undefined，不伪造", () => {
    expect(reportedProgressPercent(undefined)).toBeUndefined();
    expect(reportedProgressPercent(Number.NaN)).toBeUndefined();
    expect(reportedProgressPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("按种类的时间估算", () => {
  it("与 Rust 的分类时长一致", () => {
    expect(generationEstimateSeconds("image")).toBe(45);
    expect(generationEstimateSeconds("video")).toBe(180);
    expect(generationEstimateSeconds("audio")).toBe(60);
    expect(generationEstimateSeconds("text")).toBe(15);
    // `language` 是任务模型类型里的文本。
    expect(generationEstimateSeconds("language")).toBe(15);
    // 未识别种类回退图片时长（与 Rust `_ =>` 一致）。
    expect(generationEstimateSeconds("model")).toBe(45);
    expect(generationEstimateSeconds(undefined)).toBe(45);
  });

  it("下限 1%、封顶 95% 且单调递增", () => {
    expect(estimateGenerationPercent(0, "image")).toBe(1);
    expect(estimateGenerationPercent(-5, "image")).toBe(1);
    expect(estimateGenerationPercent(22.5, "image")).toBeCloseTo(50);
    expect(estimateGenerationPercent(10_000, "image")).toBe(GENERATION_ESTIMATE_CEILING);
    expect(estimateGenerationPercent(45, "video")).toBeLessThan(estimateGenerationPercent(90, "video"));
  });

  it("估算常量与 Rust 保持同一组数值", () => {
    expect(GENERATION_ESTIMATE_SECONDS).toEqual({ text: 15, image: 45, video: 180, audio: 60 });
  });
});

describe("显示百分比 = max(估算, 上报)", () => {
  it("上报更高时以上报为准", () => {
    expect(displayGenerationPercent({ startedAt: START, reported: 0.6, kind: "image", now: at(5) })).toBeCloseTo(60);
  });

  it("上报更低时按经过时间推进", () => {
    const percent = displayGenerationPercent({ startedAt: START, reported: 0.05, kind: "image", now: at(22.5) });
    expect(percent).toBeCloseTo(50);
  });

  it("没有上报时纯按时间估算", () => {
    expect(displayGenerationPercent({ startedAt: START, kind: "image", now: at(22.5) })).toBeCloseTo(50);
  });

  it("缺少起点时只用上报值，不编造时间进度", () => {
    expect(displayGenerationPercent({ reported: 0.42, kind: "image", now: at(1_000) })).toBeCloseTo(42);
    expect(displayGenerationPercent({ kind: "image", now: at(1_000) })).toBe(1);
  });

  it("永不显示 100%：运行中由 95% 封顶", () => {
    expect(displayGenerationPercent({ startedAt: START, reported: 1, kind: "image", now: at(10_000) })).toBe(
      GENERATION_ESTIMATE_CEILING
    );
  });

  it("取整后的整数百分比", () => {
    expect(roundedGenerationPercent({ startedAt: START, reported: 0.426, kind: "image", now: at(1) })).toBe(43);
  });
});
