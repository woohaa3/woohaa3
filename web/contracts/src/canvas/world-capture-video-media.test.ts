import { describe, expect, it } from "vitest";
import { readWorldCaptureVideoInfo } from "./world-capture-video-media.js";

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function box(type: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array([...u32(body.length + 8), ...new TextEncoder().encode(type)]);
  return new Uint8Array([...header, ...body]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal but structurally valid moov/trak/mdia with mdhd + tkhd. */
function fixtureMp4(input: { timescale: number; duration: number; width: number; height: number }): Uint8Array {
  const ftyp = box("ftyp", concat(new TextEncoder().encode("isom"), u32(0), new TextEncoder().encode("isom")));
  const mdhdBody = concat(
    new Uint8Array([0, 0, 0, 0]),
    u32(0),
    u32(0),
    u32(input.timescale),
    u32(input.duration),
    u16(0),
    u16(0)
  );
  const tkhdBody = concat(
    new Uint8Array(76).fill(0),
    u32(Math.round(input.width * 65536)),
    u32(Math.round(input.height * 65536))
  );
  const moov = box("moov", box("trak", concat(box("tkhd", tkhdBody), box("mdia", box("mdhd", mdhdBody)))));
  const mdat = box("mdat", new Uint8Array([1, 2, 3, 4]));
  return concat(ftyp, moov, mdat);
}

describe("readWorldCaptureVideoInfo", () => {
  it("读取容器时长与真实像素尺寸", () => {
    const info = readWorldCaptureVideoInfo(fixtureMp4({ timescale: 24, duration: 96, width: 1024, height: 576 }));
    expect(info).toEqual({ container: "video/mp4", durationSeconds: 4, width: 1024, height: 576 });
  });

  it("拒绝缺少 moov 或尺寸为零的字节", () => {
    expect(readWorldCaptureVideoInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    const broken = fixtureMp4({ timescale: 24, duration: 96, width: 1024, height: 576 });
    broken[broken.length - 1] = 0;
    // Truncating the mdat makes the top-level walk incomplete.
    expect(readWorldCaptureVideoInfo(broken.slice(0, 20))).toBeNull();
    expect(readWorldCaptureVideoInfo(fixtureMp4({ timescale: 0, duration: 96, width: 1024, height: 576 }))).toBeNull();
  });
});
