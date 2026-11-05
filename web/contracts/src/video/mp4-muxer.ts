/**
 * 最小 MP4（H.264/AVC）封装器，供前端动态镜头录制使用
 * （change: 2026-11-05-camera-shot-as-video；渲染与录制在前端完成）。
 *
 * 输入是 WebCodecs `VideoEncoder`（`avc: { format: "avc" }`）产出的 AVCC sample 与
 * `decoderConfig.description`（avcC）。输出单视频轨、非分片 MP4：ftyp / mdat / moov。
 *
 * 纯字节操作，无 DOM、无 Node 依赖，可在浏览器与单测中复用。
 */

export type Mp4Sample = { readonly bytes: Uint8Array; readonly keyframe: boolean };

export type Mp4VideoInput = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** AVCDecoderConfigurationRecord（WebCodecs decoderConfig.description）。 */
  readonly avcC: Uint8Array;
  readonly samples: readonly Mp4Sample[];
};

const MOVIE_TIMESCALE = 1000;

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}
function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}
function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function boxed(type: string, body: Uint8Array): Uint8Array {
  return concat([u32(body.length + 8), ascii(type), body]);
}
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  return boxed(type, concat([new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), body]));
}
function identityMatrix(): Uint8Array {
  return concat([
    u32(0x0001_0000), u32(0), u32(0),
    u32(0), u32(0x0001_0000), u32(0),
    u32(0), u32(0), u32(0x4000_0000)
  ]);
}

export function buildMp4Video(input: Mp4VideoInput): Uint8Array | null {
  const { width, height, fps, samples } = input;
  if (!(width > 0) || !(height > 0) || !Number.isInteger(fps) || fps <= 0) return null;
  if (samples.length === 0 || input.avcC.length < 4) return null;
  const frames = samples.length;
  const durationMs = Math.max(1, Math.round((frames * MOVIE_TIMESCALE) / fps));

  const ftyp = boxed("ftyp", concat([ascii("isom"), u32(512), ascii("isomiso2avc1mp41")]));
  const mdat = boxed("mdat", concat(samples.map((sample) => sample.bytes)));
  const chunkOffset = ftyp.length + 8;

  const mvhd = fullBox("mvhd", 0, 0, concat([
    u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(durationMs), u32(0x0001_0000),
    u16(0x0100), new Uint8Array(10), identityMatrix(), new Uint8Array(24), u32(2)
  ]));
  const tkhd = fullBox("tkhd", 0, 7, concat([
    u32(0), u32(0), u32(1), u32(0), u32(durationMs), new Uint8Array(8),
    u16(0), u16(0), u16(0), u16(0), identityMatrix(), u32(width << 16), u32(height << 16)
  ]));
  const mdhd = fullBox("mdhd", 0, 0, concat([u32(0), u32(0), u32(fps), u32(frames), u16(0x55c4), u16(0)]));
  const hdlr = fullBox("hdlr", 0, 0, concat([u32(0), ascii("vide"), new Uint8Array(12), ascii("VideoHandler\0")]));
  const vmhd = fullBox("vmhd", 0, 1, concat([u16(0), u16(0), u16(0), u16(0)]));
  const dinf = boxed("dinf", fullBox("dref", 0, 0, concat([u32(1), fullBox("url ", 0, 1, new Uint8Array(0))])));

  const avc1Body = concat([
    new Uint8Array(6), u16(1), new Uint8Array(16), u16(width), u16(height),
    u32(0x0048_0000), u32(0x0048_0000), u32(0), u16(1),
    (() => {
      const name = new Uint8Array(32);
      const label = ascii("Woohaa camera shot");
      name.set(label.subarray(0, 32));
      return name;
    })(),
    u16(0x0018), u16(0xffff), boxed("avcC", input.avcC)
  ]);
  const stsd = fullBox("stsd", 0, 0, concat([u32(1), boxed("avc1", avc1Body)]));
  const stts = fullBox("stts", 0, 0, concat([u32(1), u32(frames), u32(1)]));
  const keyframes = samples.map((sample, index) => (sample.keyframe ? index + 1 : 0)).filter((index) => index > 0);
  const stss = fullBox("stss", 0, 0, concat([u32(keyframes.length), ...keyframes.map(u32)]));
  const stsc = fullBox("stsc", 0, 0, concat([u32(1), u32(1), u32(frames), u32(1)]));
  const stsz = fullBox("stsz", 0, 0, concat([u32(0), u32(frames), ...samples.map((sample) => u32(sample.bytes.length))]));
  const stco = fullBox("stco", 0, 0, concat([u32(1), u32(chunkOffset)]));
  const stbl = boxed("stbl", concat([stsd, stts, stss, stsc, stsz, stco]));
  const minf = boxed("minf", concat([vmhd, dinf, stbl]));
  const mdia = boxed("mdia", concat([mdhd, hdlr, minf]));
  const trak = boxed("trak", concat([tkhd, mdia]));
  const moov = boxed("moov", concat([mvhd, trak]));

  return concat([ftyp, mdat, moov]);
}
