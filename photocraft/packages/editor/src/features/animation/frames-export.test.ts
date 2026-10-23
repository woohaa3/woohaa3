/**
 * 帧序列交付回归（U77）。
 *
 * 用注入的编码器覆盖：逐帧渲染、每帧独立 PNG、失败带帧号、取消在帧边界停止、尺寸不符拒绝。
 * 不下载、不加载真实 WASM。
 */
import { describe, expect, it, vi } from "vitest";
import { encodeFrameSequence } from "./frames-export.js";

const pixels = (value: number) => new Uint8Array(2 * 2 * 4).fill(value);
const encode = async (rgba: Uint8Array) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, rgba[0] ?? 0]);

describe("帧序列交付", () => {
  it("逐帧渲染并给出独立文件名与字节", async () => {
    const render = vi.fn((frame: number) => ({ ok: true as const, value: pixels(frame + 1) }));
    const result = await encodeFrameSequence({ frames: 3, width: 2, height: 2, render, encode });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(render.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2]);
    expect(result.frames.map(frame => frame.name)).toEqual([
      "frame-0001.png", "frame-0002.png", "frame-0003.png"
    ]);
    // 每帧字节来自各自的渲染结果（不是首帧重复）。
    expect(result.frames.map(frame => frame.bytes[4])).toEqual([1, 2, 3]);
  });

  it("渲染失败带帧号并报告已交付数，不返回半份序列", async () => {
    const result = await encodeFrameSequence({
      frames: 3, width: 2, height: 2, encode,
      render: (frame) => frame === 1 ? { ok: false, message: "帧栈缺失" } : { ok: true, value: pixels(frame) }
    });
    expect(result).toEqual({ ok: false, message: "第 2 帧渲染失败：帧栈缺失", delivered: 1 });
  });

  it("字节长度不符与编码器空输出都被拒绝", async () => {
    const wrong = await encodeFrameSequence({ frames: 1, width: 2, height: 2, encode, render: () => ({ ok: true, value: new Uint8Array(3) }) });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.message).toContain("字节长度与交付尺寸不符");

    const empty = await encodeFrameSequence({ frames: 1, width: 2, height: 2, encode: async () => null, render: () => ({ ok: true, value: pixels(1) }) });
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.message).toContain("编码器没有输出");

    const thrown = await encodeFrameSequence({ frames: 1, width: 2, height: 2, encode: async () => { throw new Error("内存不足"); }, render: () => ({ ok: true, value: pixels(1) }) });
    expect(thrown.ok).toBe(false);
    expect(thrown.ok === false && thrown.message).toContain("内存不足");
  });

  it("取消在帧边界停止，已产出的前缀如实报告", async () => {
    let produced = 0;
    const result = await encodeFrameSequence({
      frames: 3, width: 2, height: 2, encode,
      cancelled: () => produced >= 1,
      render: () => { produced += 1; return { ok: true, value: pixels(produced) }; }
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.delivered).toBe(1);
    expect(result.ok === false && result.message).toContain("已取消");
  });

  it("非法帧数/尺寸不进入渲染", async () => {
    const render = vi.fn();
    for (const frames of [0, -1, 1.5]) {
      const result = await encodeFrameSequence({ frames, width: 2, height: 2, render, encode });
      expect(result.ok).toBe(false);
    }
    expect(render).not.toHaveBeenCalled();
    const badSize = await encodeFrameSequence({ frames: 1, width: 0, height: 2, render, encode });
    expect(badSize.ok).toBe(false);
  });

  it("文件名前缀去掉路径分隔符，避免越界写入", async () => {
    const result = await encodeFrameSequence({
      frames: 1, width: 2, height: 2, encode, name: "../a/b:c",
      render: () => ({ ok: true, value: pixels(1) })
    });
    expect(result.ok && result.frames[0]!.name).toBe("..-a-b-c-0001.png");
  });
});
