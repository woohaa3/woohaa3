/**
 * 日志值序列化测试（change: unify-host-client-logging，任务 1.2）。
 *
 * 锁定两件事：
 * - **不丢整条**：循环引用、`Error`、`undefined`、函数都有稳定输出，不抛错；
 * - **有界且单行**：控制字符折叠、按码点截断，中文与 emoji 不被切坏。
 */
import { describe, expect, it } from "vitest";
import { foldSingleLine, logText, logValueToString, truncateByCodePoints } from "./value.js";

describe("logValueToString", () => {
  it("字符串原样返回", () => {
    expect(logValueToString("hello")).toBe("hello");
  });

  it("Error 只取 message，不带堆栈", () => {
    expect(logValueToString(new Error("boom"))).toBe("boom");
  });

  it("undefined 与 null 保留字面量", () => {
    expect(logValueToString(undefined)).toBe("undefined");
    expect(logValueToString(null)).toBe("null");
  });

  it("数值与布尔转字符串", () => {
    expect(logValueToString(42)).toBe("42");
    expect(logValueToString(false)).toBe("false");
  });

  it("普通对象走 JSON", () => {
    expect(logValueToString({ a: 1 })).toBe('{"a":1}');
  });

  it("循环引用给稳定占位而不是抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(logValueToString(cyclic)).toBe("[unserializable]");
  });

  it("函数给稳定占位", () => {
    expect(logValueToString(() => undefined)).toBe("[function]");
  });
});

describe("foldSingleLine", () => {
  it("换行与控制字符折叠成空格", () => {
    expect(foldSingleLine("a\nb\tc")).toBe("a b c");
  });

  it("折叠后去首尾空白", () => {
    expect(foldSingleLine("  x  ")).toBe("x");
  });
});

describe("truncateByCodePoints", () => {
  it("短于上限时原样返回", () => {
    expect(truncateByCodePoints("abc", 10)).toBe("abc");
  });

  it("超长时截断并留省略号", () => {
    expect(truncateByCodePoints("abcdef", 4)).toBe("abc…");
  });

  it("按码点截断，不切坏 emoji", () => {
    // 4 个 emoji = 8 个 UTF-16 码元；按码点截 3 个应得 2 个 emoji + 省略号。
    expect(truncateByCodePoints("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("上限为 0 时返回空串", () => {
    expect(truncateByCodePoints("abc", 0)).toBe("");
  });
});

describe("logText", () => {
  it("先折叠再截断", () => {
    expect(logText("a\nb", 10)).toBe("a b");
  });

  it("遵守上限", () => {
    expect(Array.from(logText("abcdef", 4)).length).toBe(4);
  });
});
