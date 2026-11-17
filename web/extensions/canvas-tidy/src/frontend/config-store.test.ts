import { describe, expect, it } from "vitest";
import { CANVAS_TIDY_CONFIG, tidyPlanOptionsFromConfig } from "../shared.js";
import { projectTidyConfig } from "./config-store.js";
import { FALLBACK_CONFIG } from "./config-store.js";

describe("配置声明（宿主侧唯一来源）", () => {
  it("每个字段都有 default，缺省行为与没有配置项时一致", () => {
    const validated = CANVAS_TIDY_CONFIG["~standard"].validate(undefined);
    expect("value" in validated).toBe(true);
    if (!("value" in validated)) return;
    expect(validated.value).toEqual({
      gap: 40,
      columnGapRatio: 250,
      shrinkOversized: true,
      maxCardScale: 100,
      revealAfterTidy: true
    });
  });

  it("越界值被拒绝（范围由宿主配置面校验，不只是界面限制）", () => {
    const result = CANVAS_TIDY_CONFIG["~standard"].validate({ gap: 1000, columnGapRatio: 10 });
    expect("issues" in result).toBe(true);
    if (!("issues" in result)) return;
    expect(result.issues.map(issue => issue.path?.[0]).sort()).toEqual(["columnGapRatio", "gap"]);
  });

  it("前端兜底值与声明的 default 完全一致", () => {
    const validated = CANVAS_TIDY_CONFIG["~standard"].validate(undefined);
    if (!("value" in validated)) throw Error("unexpected");
    expect(FALLBACK_CONFIG).toEqual(validated.value);
  });
});

describe("projectTidyConfig", () => {
  const entry = (key: string, value: string | number | boolean | null) => ({
    key,
    kind: "integer" as const,
    label: key,
    description: "",
    reload: "hot" as const,
    secret: false,
    source: "file" as const,
    lockedBy: null,
    value,
    configured: true,
    pendingRestart: false
  });

  it("按宿主键名投影出配置值，忽略无关键", () => {
    expect(projectTidyConfig([
      entry("extensions.canvas-tidy.gap", 72),
      entry("extensions.canvas-tidy.shrinkOversized", false),
      entry("storage.primary", "local"),
      entry("extensions.canvas-tidy.gap.nested", 999)
    ])).toMatchObject({ gap: 72, shrinkOversized: false });
  });

  it("缺失或非法值回落到默认值", () => {
    const projected = projectTidyConfig([
      entry("extensions.canvas-tidy.gap", null),
      entry("extensions.canvas-tidy.columnGapRatio", "bad" as unknown as number)
    ]);
    expect(projected.gap).toBe(FALLBACK_CONFIG.gap);
    expect(projected.columnGapRatio).toBe(FALLBACK_CONFIG.columnGapRatio);
  });
});

describe("tidyPlanOptionsFromConfig", () => {
  it("百分比换算成倍数后交给规划层", () => {
    expect(tidyPlanOptionsFromConfig({ gap: 60, columnGapRatio: 300, maxCardScale: 150 })).toEqual({
      gap: 60,
      columnGapRatio: 3,
      shrinkOversized: true,
      maxCardScale: 1.5
    });
  });

  it("缺字段时用声明默认值", () => {
    expect(tidyPlanOptionsFromConfig({})).toEqual({
      gap: 40,
      columnGapRatio: 2.5,
      shrinkOversized: true,
      maxCardScale: 1
    });
  });
});
