/**
 * 宿主的成片独立复核（任务 4.4）。
 *
 * 用真实字节验证：解析本文档自造的 MP4、以及 worker 实际产出的 fixture；同时用截断文件、
 * 伪 MIME、错误尺寸/时长、含音轨与超限字节验证拒绝路径。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareArtifact,
  probeArtifact,
  sha256Hex,
  verifyArtifact
} from "./probe.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 构造一个结构最小但自洽的 Fast Start H.264 MP4，供解析测试使用。 */
function buildMp4(options: {
  width?: number;
  height?: number;
  timescale?: number;
  duration?: number;
  samples?: number;
  audio?: boolean;
  moovAfterMdat?: boolean;
} = {}): Uint8Array {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const timescale = options.timescale ?? 30;
  const duration = options.duration ?? 120;
  const samples = options.samples ?? 120;

  const u32 = (value: number): number[] => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ];
  const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
  const box = (type: string, payload: number[]): number[] => [
    ...u32(8 + payload.length),
    ...[...type].map(character => character.charCodeAt(0)),
    ...payload
  ];
  const fullBox = (type: string, version: number, flags: number, payload: number[]): number[] =>
    box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff, ...payload]);

  const avcC = box("avcC", [1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, ...u16(2), 0x67, 0x42, 1, ...u16(1), 0x68]);
  const avc1 = box("avc1", [
    ...Array(6).fill(0),
    ...u16(1),
    ...Array(16).fill(0),
    ...u16(width),
    ...u16(height),
    ...u32(0x0048_0000),
    ...u32(0x0048_0000),
    ...u32(0),
    ...u16(1),
    ...Array(32).fill(0),
    ...u16(0x18),
    ...u16(0xffff),
    ...avcC
  ]);
  const stsd = fullBox("stsd", 0, 0, [...u32(1), ...avc1]);
  const stts = fullBox("stts", 0, 0, [...u32(1), ...u32(samples), ...u32(1)]);
  const stsz = fullBox("stsz", 0, 0, [...u32(0), ...u32(samples), ...Array(samples).fill(0).flatMap(() => u32(4))]);
  const stsc = fullBox("stsc", 0, 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]);
  const stco = fullBox("stco", 0, 0, [...u32(1), ...u32(0)]);
  const stbl = box("stbl", [...stsd, ...stts, ...stsc, ...stsz, ...stco]);
  const vmhd = fullBox("vmhd", 0, 1, Array(8).fill(0));
  const minf = box("minf", [...vmhd, ...stbl]);
  const mdhd = fullBox("mdhd", 0, 0, [...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...u16(0x55c4), ...u16(0)]);
  const hdlr = fullBox("hdlr", 0, 0, [
    ...u32(0),
    ...[..."vide"].map(character => character.charCodeAt(0)),
    ...Array(12).fill(0),
    ...[..."VideoHandler\u0000"].map(character => character.charCodeAt(0))
  ]);
  const mdia = box("mdia", [...mdhd, ...hdlr, ...minf]);
  const tkhd = fullBox("tkhd", 0, 3, [
    ...u32(0),
    ...u32(0),
    ...u32(1),
    ...u32(0),
    ...u32(duration),
    ...Array(8).fill(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0x0001_0000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x0001_0000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0x4000_0000),
    ...u32(width * 65_536),
    ...u32(height * 65_536)
  ]);
  const trak = box("trak", [...tkhd, ...mdia]);
  const mvhd = fullBox("mvhd", 0, 0, [
    ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration),
    ...u32(0x0001_0000), ...u16(0x0100), ...Array(10).fill(0),
    ...u32(0x0001_0000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x0001_0000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0x4000_0000),
    ...Array(24).fill(0),
    ...u32(2)
  ]);
  const moov = box("moov", [...mvhd, ...trak]);
  const ftyp = box("ftyp", [...[..."isom"].map(c => c.charCodeAt(0)), ...u32(0x200), ...[..."isom"].map(c => c.charCodeAt(0))]);
  const mdatPayload = [...u32(4), 1, 2, 3, 4];
  const mdat = box("mdat", mdatPayload);
  const audio = options.audio
    ? box("trak", fullBox("hdlr", 0, 0, [...u32(0), ...[..."soun"].map(c => c.charCodeAt(0)), ...Array(12).fill(0), 0]))
    : [];
  const order = options.moovAfterMdat ? [...ftyp, ...mdat, ...moov, ...audio] : [...ftyp, ...moov, ...audio, ...mdat];
  return new Uint8Array(order);
}

describe("probeArtifact", () => {
  it("reads real dimensions, duration, frame count and hash", () => {
    const bytes = buildMp4({ width: 1280, height: 720, timescale: 30, duration: 120, samples: 120 });
    const probe = probeArtifact(bytes);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.container).toBe("mp4");
    expect(probe.videoCodec).toBe("h264");
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.frameCount).toBe(120);
    expect(probe.durationSeconds).toBeCloseTo(4, 6);
    expect(probe.hasAudio).toBe(false);
    expect(probe.fastStart).toBe(true);
    expect(probe.contentSha256).toBe(sha256Hex(bytes));
  });

  it("rejects truncated and non-MP4 bytes", () => {
    expect(probeArtifact(new Uint8Array())).toMatchObject({ code: "recording-artifact-incomplete" });
    expect(probeArtifact(new TextEncoder().encode("this is not a container"))).toMatchObject({
      code: "recording-artifact-not-mp4"
    });
    const full = buildMp4();
    const truncated = full.subarray(0, full.length - 8);
    const result = probeArtifact(truncated);
    // 截断后 box 越界，解析必须失败而不是给出虚假事实。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["recording-artifact-incomplete", "recording-artifact-wrong-duration", "recording-artifact-not-fast-start"]).toContain(
        result.code
      );
    }
  });

  it("rejects moov after mdat (no Fast Start)", () => {
    const bytes = buildMp4({ moovAfterMdat: true });
    expect(probeArtifact(bytes)).toMatchObject({ code: "recording-artifact-not-fast-start" });
  });

  it("rejects audio tracks", () => {
    const bytes = buildMp4({ audio: true });
    expect(probeArtifact(bytes)).toMatchObject({ code: "recording-artifact-has-audio" });
  });

  it("has no artifact size quota (task 7.5)", () => {
    // change: 2026-10-22-remove-agent-execution-limits：原 256 MiB 成片门禁已删除。
    // 大字节不再是拒绝理由，结构校验仍按真实内容报告。
    const large = new Uint8Array(300 * 1024 * 1024);
    expect(probeArtifact(large)).not.toMatchObject({ code: "recording-artifact-too-large" });
    expect(probeArtifact(large)).toMatchObject({ code: "recording-artifact-not-mp4" });
  });

  it("rejects a non-H.264 sample description", () => {
    const bytes = buildMp4();
    // 直接在字节层把样本描述类型 avc1 → hvc1（保持长度，避免破坏 box 尺寸）。
    const patched = new Uint8Array(bytes);
    const marker = [0x61, 0x76, 0x63, 0x31]; // "avc1"
    for (let index = 0; index + 4 <= patched.length; index += 1) {
      if (marker.every((value, offset) => patched[index + offset] === value)) {
        patched[index] = 0x68; // h
        patched[index + 1] = 0x76; // v
        patched[index + 2] = 0x63; // c
        patched[index + 3] = 0x31; // 1
        break;
      }
    }
    expect(probeArtifact(patched)).toMatchObject({ code: "recording-artifact-wrong-codec" });
  });
});

describe("compareArtifact", () => {
  const parsed = probeArtifact(buildMp4({ width: 1280, height: 720, timescale: 30, duration: 120 }));
  if (!parsed.ok) throw new Error(`fixture must parse: ${parsed.code} ${parsed.message}`);
  const probe = parsed;

  it("accepts matching size, duration and hash", () => {
    expect(
      compareArtifact(probe, {
        width: 1280,
        height: 720,
        durationSeconds: 4,
        frameRate: 30,
        contentSha256: probe.contentSha256
      })
    ).toEqual({ ok: true });
  });

  it("rejects wrong size, duration and hash", () => {
    expect(compareArtifact(probe, { width: 1920 })).toMatchObject({ code: "recording-artifact-wrong-size" });
    expect(compareArtifact(probe, { height: 1080 })).toMatchObject({ code: "recording-artifact-wrong-size" });
    expect(compareArtifact(probe, { durationSeconds: 10 })).toMatchObject({
      code: "recording-artifact-wrong-duration"
    });
    expect(compareArtifact(probe, { contentSha256: "0".repeat(64) })).toMatchObject({
      code: "recording-artifact-incomplete"
    });
  });

  it("tolerates a fractional final frame within one frame duration", () => {
    expect(compareArtifact(probe, { durationSeconds: 4 - 1 / 60, frameRate: 30 })).toEqual({ ok: true });
  });

  it("has no artifact size cap (task 7.5)", () => {
    // change: 2026-10-22-remove-agent-execution-limits：`maxBytes` 参数与 256 MiB 门禁已删除。
    expect(compareArtifact(probe, {})).toEqual({ ok: true });
    expect("maxBytes" in probe).toBe(false);
  });
});

describe("verifyArtifact", () => {
  it("combines parsing and comparison", () => {
    const bytes = buildMp4();
    const result = verifyArtifact(bytes, { width: 1280, height: 720 });
    expect(result.ok).toBe(true);
  });
});

describe("real worker artifact", () => {
  const artifact = join(here, "..", "..", "..", "..", "artifacts", "recording-probe", "encode-probe.mp4");

  it("parses the MP4 produced by shot-recorder --probe when present", () => {
    if (!existsSync(artifact)) {
      // 需要先运行 `pnpm recorder:probe`；缺失时跳过而不是伪造通过。
      return;
    }
    const bytes = new Uint8Array(readFileSync(artifact));
    const probe = probeArtifact(bytes);
    if (!probe.ok) throw new Error(`真实产物解析失败：${probe.code} ${probe.message}`);
    expect(probe.container).toBe("mp4");
    expect(probe.videoCodec).toBe("h264");
    expect(probe.width).toBe(64);
    expect(probe.height).toBe(48);
    expect(probe.frameCount).toBeGreaterThan(0);
    expect(probe.fastStart).toBe(true);
    expect(probe.hasAudio).toBe(false);
  });
});
