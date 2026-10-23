/**
 * 图像模式与调色板的内容身份：跨语言 fixture 核对
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
 *
 * 与 Rust `rust/crates/editor-core/src/features/modes/tests_content.rs` 共读
 * `content-fixtures.json`：任一侧的规范文本漂移都会失败。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalizeMode, isDefaultMode, type ImageProjectModeData } from "./content.js";

type Fixture = {
  cases: Array<{ name: string; mode: ImageProjectModeData | null; canonical: string }>;
  rejections: Array<{ name: string; mode: unknown }>;
};

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("./content-fixtures.json", import.meta.url), "utf8")
) as Fixture;

describe("模式数据的内容身份文本", () => {
  it("fixture 用例与 Rust 侧规范化结果逐字节一致", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const item of fixture.cases) {
      expect(canonicalizeMode(item.mode), item.name).toBe(item.canonical);
    }
  });

  it("非法结构判为不可判定（绝不当作无变化）", () => {
    expect(fixture.rejections.length).toBeGreaterThan(0);
    for (const item of fixture.rejections) {
      expect(canonicalizeMode(item.mode as ImageProjectModeData), item.name).toBeNull();
    }
  });

  it("缺省 RGB/8 位不产生身份行，旧工程指纹不变", () => {
    expect(canonicalizeMode(undefined)).toBe("");
    expect(canonicalizeMode(null)).toBe("");
    expect(canonicalizeMode({ mode: "rgb" })).toBe("");
    expect(canonicalizeMode({ mode: "rgb", depthBits: 8, colorTable: null, duotone: null })).toBe("");
    expect(isDefaultMode({ mode: "rgb" })).toBe(true);
    expect(isDefaultMode({ mode: "grayscale" })).toBe(false);
  });

  it("颜色表与油墨编辑会改变身份行", () => {
    const before = canonicalizeMode({ mode: "indexed", colorTable: { colors: ["#000000", "#ffffff"] } });
    const after = canonicalizeMode({ mode: "indexed", colorTable: { colors: ["#00ff00", "#ffffff"] } });
    expect(before).not.toBe(after);

    const inkBefore = canonicalizeMode({
      mode: "duotone",
      duotone: { inks: [{ name: "Black", color: "#000000", curve: [] }] }
    });
    const inkAfter = canonicalizeMode({
      mode: "duotone",
      duotone: { inks: [{ name: "Black", color: "#101010", curve: [] }] }
    });
    expect(inkBefore).not.toBe(inkAfter);
  });

  it("颜色与曲线取整规则跨语言一致（0..255 / 0..10000 整数）", () => {
    expect(
      canonicalizeMode({
        mode: "duotone",
        duotone: { inks: [{ name: "Warm", color: "#AA5522", curve: [[0, 0], [0.5, 0.3333], [1, 1]] }] }
      })
    ).toBe("mode:duotone|inks:1:4:Warm#aa5522#3:0,0;5000,3333;10000,10000");
  });
});
