/**
 * 宿主的成片独立复核
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.4 / design D8）。
 *
 * worker 的成片是**不可信字节**：宿主不采信 worker 自报的尺寸/时长/codec，而是从实际
 * 字节重新解析 MP4 box，得出事实后再与声明比对。拒绝：截断、伪 MIME、错误尺寸/时长、
 * 非 H.264、含音轨。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 7.5 / design D7：固定 256 MiB 成片
 * 总量门禁已删除。完整成片按真实资源（磁盘/内存/编码器）处理，真实失败按既有阶段错误报告；
 * 分块编码/保存仍不能发布不完整作品，尺寸/时长/帧数/codec 一致性校验继续生效。
 *
 * 纯字节解析（不依赖 ffprobe/ffmpeg），可直接在无 GPU 环境测试。
 */
import { createHash } from "node:crypto";

export type ArtifactProbe = {
  ok: true;
  container: "mp4";
  videoCodec: "h264";
  width: number;
  height: number;
  /** 帧数（来自 `stsz` 的 sample_count）。 */
  frameCount: number;
  /** 时长（秒，来自 `mdhd` 的 duration/timescale）。 */
  durationSeconds: number;
  hasAudio: boolean;
  /** Fast Start：`moov` 在 `mdat` 之前。 */
  fastStart: boolean;
  sizeBytes: number;
  /** 64 位 hex sha256。 */
  contentSha256: string;
};

export type ArtifactProbeFailure = {
  ok: false;
  code:
    | "recording-artifact-not-mp4"
    | "recording-artifact-incomplete"
    | "recording-artifact-wrong-codec"
    | "recording-artifact-has-audio"
    | "recording-artifact-not-fast-start"
    | "recording-artifact-too-large"
    | "recording-artifact-wrong-size"
    | "recording-artifact-wrong-duration";
  message: string;
};

function fail(code: ArtifactProbeFailure["code"], message: string): ArtifactProbeFailure {
  return { ok: false, code, message };
}

/** 遍历顶层 box：返回 `[type, payloadStart, payloadEnd]`。 */
function topLevelBoxes(bytes: Uint8Array): Array<{ type: string; start: number; end: number }> {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = readU32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      // 64 位 largesize（超过 4 GiB 时才使用）。
      const high = readU32(bytes, offset + 8);
      const low = readU32(bytes, offset + 12);
      size = high * 2 ** 32 + low;
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < header || offset + size > bytes.length) break;
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function findBox(bytes: Uint8Array, from: number, to: number, type: string): { start: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= to) {
    const size = readU32(bytes, offset);
    const boxType = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (size < 8 || offset + size > to) return null;
    if (boxType === type) return { start: offset + 8, end: offset + size };
    offset += size;
  }
  return null;
}

function findDeep(bytes: Uint8Array, from: number, to: number, path: readonly string[]): { start: number; end: number } | null {
  let range: { start: number; end: number } | null = { start: from, end: to };
  for (const type of path) {
    if (!range) return null;
    range = findBox(bytes, range.start, range.end, type);
  }
  return range;
}

/**
 * 成片 sha256（小写 hex）。
 *
 * 直接用 Node 的 `crypto`：宿主本来就跑在 Node 里，手写 SHA-256 只会引入不必要的
 * 正确性风险（第一版手写实现算错过摘要，已改为调用平台实现）。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 从实际字节解析成片事实。
 *
 * 只读结构，不解码视频；尺寸来自 `tkhd`、时长来自 `mdhd`、帧数来自 `stsz`。
 */
export function probeArtifact(bytes: Uint8Array): ArtifactProbe | ArtifactProbeFailure {
  if (bytes.length === 0) return fail("recording-artifact-incomplete", "成片为空");
  const boxes = topLevelBoxes(bytes);
  const types = boxes.map(box => box.type);
  if (!types.includes("ftyp")) return fail("recording-artifact-not-mp4", "缺少 MP4 ftyp box");
  if (boxes[0]?.type !== "ftyp") return fail("recording-artifact-not-mp4", "ftyp 不在文件头部");
  const moovIndex = types.indexOf("moov");
  const mdatIndex = types.indexOf("mdat");
  if (moovIndex < 0 || mdatIndex < 0) {
    return fail("recording-artifact-incomplete", "缺少 moov 或 mdat");
  }
  if (moovIndex > mdatIndex) return fail("recording-artifact-not-fast-start", "moov 在 mdat 之后");

  const moov = boxes[moovIndex]!;
  // 视频样本描述：moov/trak/mdia/minf/stbl/stsd/avc1
  const stsd = findDeep(bytes, moov.start, moov.end, ["trak", "mdia", "minf", "stbl", "stsd"]);
  if (!stsd) return fail("recording-artifact-incomplete", "缺少 stsd");
  // stsd: version/flags(4) entry_count(4)，随后是样本描述 box。
  const entryCount = readU32(bytes, stsd.start + 4);
  if (entryCount === 0) return fail("recording-artifact-incomplete", "stsd 没有样本描述");
  const firstEntry = stsd.start + 8;
  const entrySize = readU32(bytes, firstEntry);
  const entryType = String.fromCharCode(
    bytes[firstEntry + 4]!,
    bytes[firstEntry + 5]!,
    bytes[firstEntry + 6]!,
    bytes[firstEntry + 7]!
  );
  if (entryType !== "avc1") {
    return fail("recording-artifact-wrong-codec", `样本描述不是 H.264（${entryType}）`);
  }
  // `avc1` 是视觉样本描述：box 头 8 字节之后还有 78 字节固定字段（reserved/dri/尺寸/压缩名等），
  // 其后的子 box 才是 `avcC`。
  const AVCC_OFFSET = 8 + 78;
  const avcc = findBox(bytes, firstEntry + AVCC_OFFSET, firstEntry + entrySize, "avcC");
  if (!avcc) return fail("recording-artifact-wrong-codec", "缺少 avcC 配置");

  const tkhd = findDeep(bytes, moov.start, moov.end, ["trak", "tkhd"]);
  const mdhd = findDeep(bytes, moov.start, moov.end, ["trak", "mdia", "mdhd"]);
  const stsz = findDeep(bytes, moov.start, moov.end, ["trak", "mdia", "minf", "stbl", "stsz"]);
  const stts = findDeep(bytes, moov.start, moov.end, ["trak", "mdia", "minf", "stbl", "stts"]);
  if (!tkhd || !mdhd || !stsz || !stts) {
    return fail("recording-artifact-incomplete", "缺少 tkhd/mdhd/stsz/stts");
  }
  // tkhd: version(1)+flags(3)，v0 时 width/height 在末尾 8 字节。
  const tkhdWidth = readU32(bytes, tkhd.end - 8) / 65_536;
  const tkhdHeight = readU32(bytes, tkhd.end - 4) / 65_536;
  // mdhd: version(1)+flags(3) creation(4) modification(4) timescale(4) duration(4)
  const timescale = readU32(bytes, mdhd.start + 12);
  const duration = readU32(bytes, mdhd.start + 16);
  // stsz: version/flags(4) sample_size(4) sample_count(4)
  const sampleSize = readU32(bytes, stsz.start + 4);
  const sampleCount = readU32(bytes, stsz.start + 8);
  if (sampleSize !== 0) {
    return fail("recording-artifact-incomplete", "stsz 使用统一 sample size，无法校验逐帧大小");
  }
  // stts 至少要有时间条目。
  const sttsEntries = readU32(bytes, stts.start + 4);
  if (sttsEntries === 0) return fail("recording-artifact-incomplete", "stts 没有时间条目");
  if (timescale === 0) return fail("recording-artifact-wrong-duration", "mdhd timescale 为 0");
  if (duration === 0) return fail("recording-artifact-wrong-duration", "mdhd duration 为 0");

  // 音轨：任何 `soun` handler 都拒绝（首期只允许视频）。
  const hasAudio = findSymbol(bytes, "soun") !== null;
  if (hasAudio) return fail("recording-artifact-has-audio", "成片包含音轨");

  return {
    ok: true,
    container: "mp4",
    videoCodec: "h264",
    width: Math.round(tkhdWidth),
    height: Math.round(tkhdHeight),
    frameCount: sampleCount,
    durationSeconds: duration / timescale,
    hasAudio: false,
    fastStart: true,
    sizeBytes: bytes.length,
    contentSha256: sha256Hex(bytes)
  };
}

/** 在字节流里找 4 字节 ASCII 标记（用于音轨/soun 检测）。 */
function findSymbol(bytes: Uint8Array, symbol: string): number | null {
  const target = [
    symbol.charCodeAt(0),
    symbol.charCodeAt(1),
    symbol.charCodeAt(2),
    symbol.charCodeAt(3)
  ];
  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    if (
      bytes[index] === target[0] &&
      bytes[index + 1] === target[1] &&
      bytes[index + 2] === target[2] &&
      bytes[index + 3] === target[3]
    ) {
      return index;
    }
  }
  return null;
}

/** 把探针结果与 worker/任务声明比对。 */
export function compareArtifact(probe: Omit<ArtifactProbe, "ok">, expected: {
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  contentSha256?: string;
}): { ok: true } | ArtifactProbeFailure {
  if (expected.width !== undefined && probe.width !== expected.width) {
    return fail("recording-artifact-wrong-size", `宽度 ${probe.width} 与 profile ${expected.width} 不一致`);
  }
  if (expected.height !== undefined && probe.height !== expected.height) {
    return fail("recording-artifact-wrong-size", `高度 ${probe.height} 与 profile ${expected.height} 不一致`);
  }
  if (expected.durationSeconds !== undefined) {
    const tolerance = Math.max(1 / (expected.frameRate ?? 30), 0.01);
    if (Math.abs(probe.durationSeconds - expected.durationSeconds) > tolerance) {
      return fail(
        "recording-artifact-wrong-duration",
        `时长 ${probe.durationSeconds} 与片段 ${expected.durationSeconds} 不一致`
      );
    }
  }
  if (expected.contentSha256 !== undefined && probe.contentSha256 !== expected.contentSha256) {
    return fail("recording-artifact-incomplete", "宿主重算的 sha256 与声明不符");
  }
  return { ok: true };
}

/** 便捷入口：解析 + 比对。 */
export function verifyArtifact(
  bytes: Uint8Array,
  expected: Parameters<typeof compareArtifact>[1] = {}
): ArtifactProbe | ArtifactProbeFailure {
  const probe = probeArtifact(bytes);
  if (!probe.ok) return probe;
  const compared = compareArtifact(probe, expected);
  if (!compared.ok) return compared;
  return probe;
}
