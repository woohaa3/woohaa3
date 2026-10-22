import { describe, expect, it } from "vitest";
import { MAX_CANVAS_ID_LENGTH, canvasIdOf, canvasScopeOf } from "./media-scope.js";

describe("画布 id 形状", () => {
  it.each(["canvas-1", "c1", "canvas-550e8400-e29b-41d4-a716-446655440000", "A.b_c:d-1", "x".repeat(MAX_CANVAS_ID_LENGTH)])(
    "接受合法 id：%s",
    (value) => {
      expect(canvasIdOf(value)).toBe(value);
    }
  );

  it.each([
    "",
    " ",
    " canvas-1",
    "canvas-1 ",
    "-canvas",
    ".hidden",
    "../etc/passwd",
    "a/b",
    "a\\b",
    "canvas 1",
    "x".repeat(MAX_CANVAS_ID_LENGTH + 1),
    null,
    undefined,
    1,
    {}
  ])("拒绝非法值：%s", (value) => {
    expect(canvasIdOf(value)).toBeUndefined();
  });
});

describe("canvasScopeOf", () => {
  it("合法 id 转成存储作用域，非法或空返回无作用域", () => {
    expect(canvasScopeOf("canvas-1")).toEqual({ canvasId: "canvas-1" });
    expect(canvasScopeOf("")).toBeUndefined();
    expect(canvasScopeOf(null)).toBeUndefined();
    expect(canvasScopeOf(undefined)).toBeUndefined();
    expect(canvasScopeOf("../x")).toBeUndefined();
  });
});
