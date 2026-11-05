import { describe, expect, it } from "vitest";
import { buildMp4Video } from "./mp4-muxer.js";

const avcC = new Uint8Array([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1f, 0x01, 0x00, 0x02, 0x68, 0xce]);

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}
function boxes(bytes: Uint8Array, start: number, end: number): Array<{ type: string; body: number; end: number }> {
  const out: Array<{ type: string; body: number; end: number }> = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = readU32(bytes, offset);
    if (size < 8 || offset + size > end) break;
    out.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), body: offset + 8, end: offset + size });
    offset += size;
  }
  return out;
}

describe("buildMp4Video", () => {
  it("写出可解析的单轨 MP4（帧数/时长/avcC）", () => {
    const samples = Array.from({ length: 24 }, (_, index) => ({
      bytes: new Uint8Array([0, 0, 0, 2, 0x65, index & 0xff]),
      keyframe: index === 0
    }));
    const mp4 = buildMp4Video({ width: 320, height: 180, fps: 24, avcC, samples });
    expect(mp4).not.toBeNull();
    const top = boxes(mp4!, 0, mp4!.length);
    expect(top.map((box) => box.type)).toEqual(["ftyp", "mdat", "moov"]);
    const moov = top[2]!;
    const trak = boxes(mp4!, moov.body, moov.end).find((box) => box.type === "trak")!;
    const mdia = boxes(mp4!, trak.body, trak.end).find((box) => box.type === "mdia")!;
    const children = boxes(mp4!, mdia.body, mdia.end);
    const mdhd = children.find((box) => box.type === "mdhd")!;
    expect(readU32(mp4!, mdhd.body + 12)).toBe(24);
    expect(readU32(mp4!, mdhd.body + 16)).toBe(24);
    const minf = children.find((box) => box.type === "minf")!;
    const stbl = boxes(mp4!, minf.body, minf.end).find((box) => box.type === "stbl")!;
    const stsz = boxes(mp4!, stbl.body, stbl.end).find((box) => box.type === "stsz")!;
    expect(readU32(mp4!, stsz.body + 8)).toBe(24);
  });

  it("没有帧或 avcC 时失败关闭", () => {
    expect(buildMp4Video({ width: 320, height: 180, fps: 24, avcC, samples: [] })).toBeNull();
    expect(buildMp4Video({ width: 320, height: 180, fps: 24, avcC: new Uint8Array(), samples: [{ bytes: new Uint8Array([1]), keyframe: true }] })).toBeNull();
  });
});
