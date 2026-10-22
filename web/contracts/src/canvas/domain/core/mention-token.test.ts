/**
 * mention token codec（change: add-reference-inputs-and-mentions，任务 1.1）。
 */
import { describe, expect, it } from "vitest";
import {
  collectWoohaa3CanvasMentions,
  containsWoohaa3CanvasMentionToken,
  extractWoohaa3CanvasMentions,
  findUnresolvedWoohaa3CanvasMentions,
  parseWoohaa3CanvasMention,
  renderWoohaa3CanvasMentionProviderText,
  serializeWoohaa3CanvasMention,
  woohaa3CanvasMentionDisplayToStorage,
  woohaa3CanvasMentionStorageToDisplay,
  type Woohaa3CanvasMention
} from "./mention-token";

const IMAGE: Woohaa3CanvasMention = { type: "input_image", slotId: "slot-a", label: "图片 1" };

describe("mention token serialize/parse", () => {
  it("round-trip 保持身份", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE);
    expect(token).toBe("{{input_image:slot-a:图片 1}}");
    expect(parseWoohaa3CanvasMention(token!)).toEqual(IMAGE);
  });

  it("label 可含空格与中文", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_video", slotId: "s-1", label: "视频 2 号" });
    expect(parseWoohaa3CanvasMention(token!)).toEqual({ type: "input_video", slotId: "s-1", label: "视频 2 号" });
  });

  it("拒绝空字段与保留分隔符", () => {
    expect(serializeWoohaa3CanvasMention({ type: "input_image", slotId: "", label: "x" })).toBeNull();
    expect(serializeWoohaa3CanvasMention({ type: "input_image", slotId: "a:b", label: "x" })).toBeNull();
    expect(serializeWoohaa3CanvasMention({ type: "input_image", slotId: "a", label: "x:y" })).toBeNull();
    expect(serializeWoohaa3CanvasMention({ type: "input_image", slotId: "a", label: "x}y" })).toBeNull();
  });

  it("拒绝未知类型", () => {
    expect(serializeWoohaa3CanvasMention({ type: "input_unknown" as never, slotId: "a", label: "x" })).toBeNull();
    expect(parseWoohaa3CanvasMention("{{input_unknown:slot-a:x}}")).toBeNull();
  });

  it("拒绝畸形 token", () => {
    for (const bad of [
      "{{input_image:slot-a}}",
      "{{input_image::x}}",
      "{{:slot-a:x}}",
      "{{input_image:slot-a:x",
      "input_image:slot-a:x}}",
      "{{input_image:slot-a:x:y}}"
    ]) {
      expect(parseWoohaa3CanvasMention(bad)).toBeNull();
    }
  });
});

describe("extract 与文本往返", () => {
  it("切分普通文本与多个 mention", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    const segments = extractWoohaa3CanvasMentions(`前 ${token} 中 ${token} 后`);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "mention", "text", "mention", "text"]);
    expect(collectWoohaa3CanvasMentions(`a ${token} b`)).toHaveLength(1);
  });

  it("普通 @文字 不成为 mention", () => {
    const segments = extractWoohaa3CanvasMentions("请参考 @图片 1 和 @视频 2");
    expect(segments.every((segment) => segment.kind === "text")).toBe(true);
    expect(containsWoohaa3CanvasMentionToken("请参考 @图片 1")).toBe(false);
  });

  it("非法 {{...}} 并入普通文本且无损", () => {
    const weird = "字面量 {{not a token}} 与 {{input_bad:a:b}}";
    expect(woohaa3CanvasMentionStorageToDisplay(weird)).toBe(weird);
  });

  it("storage ↔ display 往返", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    const display = woohaa3CanvasMentionStorageToDisplay(`看图 ${token} 生成`);
    expect(display).toBe("看图 @图片 1 生成");
    const restored = woohaa3CanvasMentionDisplayToStorage(display, [
      { label: "图片 1", mention: IMAGE }
    ]);
    expect(restored).toBe(`看图 ${token} 生成`);
  });

  it("未确认的 @文字 原样保留", () => {
    expect(woohaa3CanvasMentionDisplayToStorage("参考 @不存在", [])).toBe("参考 @不存在");
  });
});

describe("provider 文本渲染", () => {
  it("文字 token 原位展开且不递归", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_text", slotId: "t1", label: "文本 1" })!;
    const nested = serializeWoohaa3CanvasMention(IMAGE)!;
    const result = renderWoohaa3CanvasMentionProviderText(`开头 ${token} 结尾`, {
      resolveText: () => `权威文字里含 ${nested}`
    });
    // 展开内容里的 token 不再被解析。
    expect(result.text).toBe(`开头 权威文字里含 ${nested} 结尾`);
    expect(result.unresolved).toEqual([]);
  });

  it("媒体 token 渲染为可读文字", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    const result = renderWoohaa3CanvasMentionProviderText(`图：${token}`, {
      resolveMediaLabel: (mention) => `[${mention.label}]`
    });
    expect(result.text).toBe("图：[图片 1]");
  });

  it("未解析的文字 token 记入 unresolved", () => {
    const token = serializeWoohaa3CanvasMention({ type: "input_text", slotId: "t1", label: "文本 1" })!;
    const result = renderWoohaa3CanvasMentionProviderText(token, { resolveText: () => null });
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("候选校验", () => {
  it("findUnresolved 只把 slot 缺失或类型不符判为失效", () => {
    const ok = serializeWoohaa3CanvasMention(IMAGE)!;
    const wrongType = serializeWoohaa3CanvasMention({ type: "input_video", slotId: "slot-a", label: "x" })!;
    const missing = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "gone", label: "x" })!;
    const unresolved = findUnresolvedWoohaa3CanvasMentions(`${ok} ${wrongType} ${missing}`, [
      { slotId: "slot-a", type: "input_image" }
    ]);
    expect(unresolved.map((mention) => mention.slotId)).toEqual(["slot-a", "gone"]);
  });
});
