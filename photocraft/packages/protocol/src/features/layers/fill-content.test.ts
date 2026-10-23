import { describe, expect, it } from "vitest";
import {
  IMAGE_PROJECT_GRADIENT_STYLES,
  canonicalizeFillContent,
  fillPatternReference,
  isContentHash16,
  type ImageProjectFillContent,
} from "./fill-content.js";

function solid(color = "#112233", alpha = 1): ImageProjectFillContent {
  return { kind: "solid", parameters: { kind: "solid", color, alpha } };
}

function gradient(patch: Partial<Extract<ImageProjectFillContent, { kind: "gradient" }>["parameters"]> = {}): ImageProjectFillContent {
  return {
    kind: "gradient",
    parameters: {
      kind: "gradient",
      stops: [
        { at: 0, color: "#ffffff", alpha: 1 },
        { at: 1, color: "#000000", alpha: 1 },
      ],
      angle: 45,
      scale: 1,
      style: "linear",
      reverse: false,
      opacityStops: [],
      midpoints: [],
      offset: [0, 0],
      dither: false,
      align: true,
      ...patch,
    },
  };
}

function pattern(patch: Partial<Extract<ImageProjectFillContent, { kind: "pattern" }>["parameters"]> = {}): ImageProjectFillContent {
  return {
    kind: "pattern",
    parameters: { kind: "pattern", pattern: "grid", name: "格子", scale: 1, angle: 0, link: true, phase: [0, 0], ...patch },
  };
}

describe("填充内容规范化（U57）", () => {
  it("三种填充都给出与 Rust 同形的规范文本", () => {
    // Rust `identity.rs::canonicalize_fill` 的格式逐字节相同；任一侧改动都会让指纹分叉。
    expect(canonicalizeFillContent(solid())).toBe("fill:solid:#112233:1");
    expect(canonicalizeFillContent(solid("#336699", 0.5))).toBe("fill:solid:#336699:0.5");
    expect(canonicalizeFillContent(gradient())).toBe(
      "fill:gradient:linear:45:1:0:0:1:0,0:[0:#ffffff:1;1:#000000:1]:[]:[]"
    );
    expect(canonicalizeFillContent(pattern())).toBe("fill:pattern:2:格子:4:grid:1:0:1:0,0");
  });

  it("不同参数必须给出不同文本（否则接进内容身份后看不出改动）", () => {
    expect(canonicalizeFillContent(solid("#112233"))).not.toBe(canonicalizeFillContent(solid("#ff8800")));
    expect(canonicalizeFillContent(solid("#112233", 1))).not.toBe(canonicalizeFillContent(solid("#112233", 0.5)));
    expect(canonicalizeFillContent(gradient({ angle: 0 }))).not.toBe(canonicalizeFillContent(gradient({ angle: 90 })));
    expect(canonicalizeFillContent(gradient({ style: "radial" }))).not.toBe(canonicalizeFillContent(gradient()));
    expect(canonicalizeFillContent(gradient({ reverse: true }))).not.toBe(canonicalizeFillContent(gradient()));
    expect(canonicalizeFillContent(pattern({ pattern: "dots" }))).not.toBe(canonicalizeFillContent(pattern()));
    expect(canonicalizeFillContent(pattern({ scale: 2 }))).not.toBe(canonicalizeFillContent(pattern()));
    expect(canonicalizeFillContent(pattern({ link: false }))).not.toBe(canonicalizeFillContent(pattern()));
  });

  it("渐变样式只认规范小写名", () => {
    for (const style of IMAGE_PROJECT_GRADIENT_STYLES) {
      expect(canonicalizeFillContent(gradient({ style }))).toContain(`fill:gradient:${style}:`);
    }
    // Rust 调试名（`Linear`）不是契约：大小写不同即无法判定。
    expect(canonicalizeFillContent(gradient({ style: "Linear" as never }))).toBeNull();
    expect(canonicalizeFillContent(gradient({ style: "conic" as never }))).toBeNull();
  });

  it("非法结构返回 null，绝不当作无变化", () => {
    expect(canonicalizeFillContent(null)).toBeNull();
    expect(canonicalizeFillContent(undefined)).toBeNull();
    expect(canonicalizeFillContent(solid("#12345"))).toBeNull();
    expect(canonicalizeFillContent(solid("#112233", 2))).toBeNull();
    expect(canonicalizeFillContent({ kind: "solid", parameters: { kind: "pattern" } } as never)).toBeNull();
    // 端点少于两个、次序颠倒、越界、颜色非法。
    expect(canonicalizeFillContent(gradient({ stops: [{ at: 0, color: "#ffffff", alpha: 1 }] }))).toBeNull();
    expect(
      canonicalizeFillContent(
        gradient({
          stops: [
            { at: 0.9, color: "#ffffff", alpha: 1 },
            { at: 0.1, color: "#000000", alpha: 1 },
          ],
        })
      )
    ).toBeNull();
    expect(canonicalizeFillContent(gradient({ stops: [{ at: -1, color: "#ffffff", alpha: 1 }, { at: 1, color: "#000000", alpha: 1 }] }))).toBeNull();
    expect(canonicalizeFillContent(gradient({ stops: [{ at: 0, color: "#fff", alpha: 1 }, { at: 1, color: "#000000", alpha: 1 }] }))).toBeNull();
    // 缩放区间与原生核验器一致（0.1–1.5 比例）。
    expect(canonicalizeFillContent(gradient({ scale: 50 }))).toBeNull();
    expect(canonicalizeFillContent(gradient({ scale: 0.05 }))).toBeNull();
    // 中点数量必须小于端点数。
    expect(canonicalizeFillContent(gradient({ midpoints: [0.5, 0.5] }))).toBeNull();
    // 图案：名称为空、缩放非正、角度越界都拒绝。
    expect(canonicalizeFillContent(pattern({ name: "" }))).toBeNull();
    expect(canonicalizeFillContent(pattern({ scale: 0 }))).toBeNull();
    expect(canonicalizeFillContent(pattern({ scale: 20 }))).toBeNull();
    expect(canonicalizeFillContent(pattern({ angle: 400 }))).toBeNull();
    expect(canonicalizeFillContent({ kind: "swirl", parameters: { kind: "swirl" } } as never)).toBeNull();
  });

  it("图案引用只在图案填充上出现", () => {
    expect(fillPatternReference(pattern())).toBe("grid");
    expect(fillPatternReference(solid())).toBeNull();
    expect(fillPatternReference(gradient())).toBeNull();
    expect(fillPatternReference(null)).toBeNull();
    expect(fillPatternReference(pattern({ pattern: "" }))).toBeNull();
  });

  it("内容摘要串具备 HASH16 形状", () => {
    expect(isContentHash16("0123456789abcdef")).toBe(true);
    expect(isContentHash16("0123456789ABCDEF")).toBe(false);
    expect(isContentHash16("too-short")).toBe(false);
  });
});
