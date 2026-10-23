import { describe, expect, it } from "vitest";
import { animationContentKey, canonicalizeAnimationContent, hasAnimationContent, type AnimationContent, type AnimationContentLayer } from "./content.js";

const frame = (hash: string) => ({ contentHash: hash, width: 8, height: 8, format: "RGBA8" });
const layer = (name: string, video: AnimationContentLayer["video"], children?: AnimationContentLayer[]): AnimationContentLayer =>
  children === undefined ? { name, video } : { name, video, children };

describe("动画内容身份（TS 规范化）", () => {
  it("无时间轴且无视频层时不产生贡献（旧工程身份不变）", () => {
    expect(hasAnimationContent(null)).toBe(false);
    expect(hasAnimationContent({ timeline: null, layers: [] })).toBe(false);
    expect(hasAnimationContent({ timeline: { fps: 24, duration: 3 }, layers: [] })).toBe(true);
  });

  it("帧顺序是内容：换序改变 key", () => {
    const base: AnimationContent = {
      timeline: { fps: 24, duration: 2 },
      layers: [layer("video", { fps: 24, showAltered: true, frames: [frame("a"), frame("b")] })]
    };
    const reversed: AnimationContent = {
      ...base,
      layers: [layer("video", { fps: 24, showAltered: true, frames: [frame("b"), frame("a")] })]
    };
    expect(animationContentKey(base)).not.toBe(animationContentKey(reversed));
  });

  it("播放头与工作区范围不在字段集里，所以不改变 key", () => {
    const base: AnimationContent = { timeline: { fps: 12, duration: 5 }, layers: [] };
    const withView = JSON.parse(JSON.stringify({ ...base, current: 4, workStart: 1, workEnd: 4 })) as AnimationContent;
    expect(animationContentKey(withView)).toBe(animationContentKey(base));
  });

  it("original 与嵌套子层只在存在时出现，且参与 key", () => {
    const plain: AnimationContent = {
      timeline: null,
      layers: [layer("video", { fps: 30, showAltered: true, frames: [frame("x")] })]
    };
    const withOriginal: AnimationContent = {
      timeline: null,
      layers: [layer("video", { fps: 30, showAltered: true, frames: [frame("x")], original: [frame("y")] })]
    };
    expect(animationContentKey(plain)).not.toBe(animationContentKey(withOriginal));

    const nested: AnimationContent = {
      timeline: null,
      layers: [layer("group", null, [layer("nested", { fps: 30, showAltered: true, frames: [frame("z")] })])]
    };
    expect(animationContentKey(nested)).toContain("\"z\"");
    expect(animationContentKey(plain)).not.toContain("children");
    // 组自己没有帧栈：video 是 null，不是空对象。
    expect(animationContentKey(nested)).toContain("[null,");
  });

  it("图层名是条目标识；图层 id 不进 key（加载时会重新分配）", () => {
    const base: AnimationContent = {
      timeline: { fps: 24, duration: 1 },
      layers: [layer("video", { fps: 24, showAltered: true, frames: [frame("a")] })]
    };
    // 同一内容、不同 id：key 必须相同，否则每次重开都会被判成已修改。
    const otherId = JSON.parse(JSON.stringify({ ...base, layers: [{ ...base.layers[0], id: 99 }] })) as AnimationContent;
    expect(animationContentKey(otherId)).toBe(animationContentKey(base));
    // 改图层名是内容变化（名字进入工程并且是条目标识）。
    const renamed: AnimationContent = { ...base, layers: [layer("video 2", base.layers[0]!.video)] };
    expect(animationContentKey(renamed)).not.toBe(animationContentKey(base));
  });

  it("key 是稳定字符串（同输入同输出）", () => {
    const value: AnimationContent = { timeline: { fps: 10, duration: 3 }, layers: [] };
    expect(animationContentKey(value)).toBe(animationContentKey(structuredClone(value)));
  });
});

describe("动画内容身份（跨语言规范文本）", () => {
  it("规范文本是固定格式：时间轴 + 长度前缀的条目", () => {
    const value: AnimationContent = {
      timeline: { fps: 24, duration: 3 },
      layers: [layer("视频", { fps: 30, showAltered: true, frames: [frame("0123456789abcdef")] })]
    };
    // 与 Rust `identity::canonicalize_animation` 的期望文本逐字节相同（同一 fixture 两侧断言）。
    expect(canonicalizeAnimationContent(value)).toBe(
      "animation:24,3:47:[42:2:视频@30,1,29:[0123456789abcdef,8,8,RGBA8;]]"
    );
  });

  it("没有帧栈的组用 `-` 表示，不与「空帧栈」混淆", () => {
    const group: AnimationContent = {
      timeline: null,
      layers: [layer("group", null, [layer("child", { fps: 24, showAltered: false, frames: [] })])]
    };
    expect(canonicalizeAnimationContent(group)).toContain("@-#");
    const emptyStack: AnimationContent = {
      timeline: null,
      layers: [layer("group", { fps: 24, showAltered: false, frames: [] })]
    };
    expect(canonicalizeAnimationContent(emptyStack)).toContain("@24,0,");
    expect(canonicalizeAnimationContent(group)).not.toBe(canonicalizeAnimationContent(emptyStack));
  });

  it("原帧只在存在时追加，且改变文本", () => {
    const plain: AnimationContent = {
      timeline: null,
      layers: [layer("v", { fps: 24, showAltered: true, frames: [frame("0123456789abcdef")] })]
    };
    const withOriginal: AnimationContent = {
      timeline: null,
      layers: [layer("v", { fps: 24, showAltered: true, frames: [frame("0123456789abcdef")], original: [frame("fedcba9876543210")] })]
    };
    const plainText = canonicalizeAnimationContent(plain);
    const originalText = canonicalizeAnimationContent(withOriginal);
    expect(plainText).not.toBeNull();
    expect(originalText).not.toBeNull();
    // 原帧列表接在改动后帧列表之后，只有带原帧时才出现那组帧。
    expect(plainText!.includes("fedcba9876543210")).toBe(false);
    expect(originalText!.includes("fedcba9876543210")).toBe(true);
    expect(originalText!.length).toBeGreaterThan(plainText!.length);
    expect(plainText).not.toBe(originalText);
  });

  it("非法结构返回 null（调用方必须按「无法判定」处理）", () => {
    const bad = (mutate: (value: AnimationContent) => void) => {
      const value: AnimationContent = {
        timeline: { fps: 24, duration: 1 },
        layers: [layer("v", { fps: 24, showAltered: true, frames: [frame("0123456789abcdef")] })]
      };
      mutate(value);
      return canonicalizeAnimationContent(value);
    };
    expect(bad(value => { value.timeline = { fps: Number.NaN, duration: 1 }; })).toBeNull();
    expect(bad(value => { value.timeline = { fps: 24, duration: 0 }; })).toBeNull();
    expect(bad(value => { value.layers[0]!.video!.frames[0]!.contentHash = "短"; })).toBeNull();
    expect(bad(value => { value.layers[0]!.video!.frames[0]!.format = "a,b"; })).toBeNull();
  });
});
