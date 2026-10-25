/**
 * 业务源码规模门禁（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility）。
 *
 * 与既有 800 行 Frontend/Rust 全源码守卫并存：本门禁只约束**维护业务源码**
 * （口径见 `source-size.ts`，与审计报告的 869 个业务文件一致），目标 ≤500 物理行。
 *
 * 目标不是复杂度指标，而是职责聚集的导航护栏。禁止用压行、part1/part2、
 * 无语义 utils 或目录泛豁免规避；确有依据的例外必须通过显式清单登记 owner、
 * 原因与后续计划，且经代码审查（清单见 `source-size-allowlist.ts`）。
 *
 * 两类清单：
 * - `PENDING_SPLIT`：inventory.md R01–R28 的既有超限文件，是**待还清的分拆债**；
 *   每完成一个文件的拆分即从此移除，最终必须清空。
 * - `EXCEPTIONS`：确因高耦合/不变式暂时无法安全拆分的例外（需审查与原因）。
 *
 * 任何**不在**上述清单里的超限业务文件都会使门禁失败（防止拆分把新职责转移成
 * 新的长文件，也防止新增业务模块超限）。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_BUSINESS_SOURCE_LINES,
  collectBusinessSourceSizes,
  isBusinessSourceFile,
  physicalLines
} from "./source-size.js";
import { EXCEPTIONS, isKnownLongFile, PENDING_SPLIT } from "./source-size-allowlist.js";

/** 仓库根（`web/` 的上一级）。 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("业务源码规模门禁（≤500 物理行）", () => {
  it("扫描集非空，且不误扫测试/夹具/生成文件", () => {
    const sizes = collectBusinessSourceSizes(REPO_ROOT);
    expect(sizes.length, "业务源码扫描集不应为空").toBeGreaterThan(0);
    for (const excluded of [
      "web/contracts/src/canvas/render-scene.test.ts",
      "web/e2e/helpers.ts",
      "web/frontend/src/bevy-wasm/woohaa_bevy_canvas.d.ts",
      "web/frontend/src/bevy-wasm/woohaa_bevy_canvas.js",
      "web/contracts/src/theme/generated-default.ts",
      "web/showcase/src/fixtures/catalog.ts"
    ]) {
      expect(sizes.some((entry) => entry.path === excluded), `${excluded} 不应计入业务源码`).toBe(false);
    }
  });

  it("没有未登记的 500 行以上业务文件（拆分债与显式例外除外）", () => {
    const violations = collectBusinessSourceSizes(REPO_ROOT).filter(
      (entry) => entry.lines > MAX_BUSINESS_SOURCE_LINES && !isKnownLongFile(entry.path)
    );
    const detail = violations
      .sort((a, b) => b.lines - a.lines)
      .map((entry) => `  ${entry.path}: ${entry.lines} 行（超 ${entry.lines - MAX_BUSINESS_SOURCE_LINES}）`)
      .join("\n");
    expect(
      violations,
      `以下业务源码超过 ${MAX_BUSINESS_SOURCE_LINES} 物理行上限且未登记（共 ${violations.length} 个）：\n${detail}`
    ).toEqual([]);
  });

  it("拆分债/例外清单只减不增：登记项必须在扫描集中", () => {
    const paths = new Set(collectBusinessSourceSizes(REPO_ROOT).map((entry) => entry.path));
    for (const path of [...PENDING_SPLIT, ...Object.keys(EXCEPTIONS)]) {
      expect(paths.has(path), `${path} 已不在业务源码中，请从清单移除`).toBe(true);
    }
  });

  it("计数规则与 wc -l 一致；生成/测试/夹具被排除", () => {
    expect(physicalLines("")).toBe(0);
    expect(physicalLines("\n")).toBe(1);
    expect(physicalLines("a\n")).toBe(1);
    expect(physicalLines("a\nb")).toBe(2);
    expect(physicalLines("a\r\nb\r\n")).toBe(2);
    expect(isBusinessSourceFile("web/contracts/src/canvas/render-scene.ts")).toBe(true);
    expect(isBusinessSourceFile("web/contracts/src/canvas/render-scene.test.ts")).toBe(false);
    expect(isBusinessSourceFile("web/e2e/helpers.ts")).toBe(false);
    expect(isBusinessSourceFile("web/frontend/src/bevy-wasm/x.d.ts")).toBe(false);
    expect(isBusinessSourceFile("web/frontend/src/bevy-wasm/woohaa_bevy_canvas.js")).toBe(false);
    expect(isBusinessSourceFile("web/contracts/src/theme/generated-default.ts")).toBe(false);
    expect(isBusinessSourceFile("web/showcase/src/fixtures/canvas.ts")).toBe(false);
  });
});
