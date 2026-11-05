/**
 * 视频容器核验（change: 2026-11-05-camera-shot-as-video，任务 3.3）。
 *
 * 生产端自报的时长/尺寸不可信：这里直接读取 MP4 box 结构里的 `mdhd`（timescale +
 * duration）与 `tkhd`（16.16 定点宽高），用于保存前的真实容器校验。
 *
 * 只做只读解析，不解码帧；未知/损坏结构一律返回 null，调用方必须失败关闭。
 */

export type WorldCaptureVideoInfo = {
  readonly container: "video/mp4";
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
};

const BOX_HEADER_BYTES = 8;
const MAX_BOX_DEPTH = 8;

type Box = { type: string; start: number; end: number; bodyStart: number };

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readU64(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) * 0x1_0000_0000 + readU32(bytes, offset + 4);
}

function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + BOX_HEADER_BYTES <= end) {
    let size = readU32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!
    );
    let header = BOX_HEADER_BYTES;
    if (size === 1) {
      if (offset + 16 > end) return boxes;
      size = readU64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return boxes;
    boxes.push({ type, start: offset, end: offset + size, bodyStart: offset + header });
    offset += size;
  }
  return boxes;
}

function findBox(boxes: readonly Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

type MediaDuration = { timescale: number; duration: number };

/** `mdhd`：version 0 为 32 位时间字段，version 1 为 64 位。 */
function readMdhd(bytes: Uint8Array, box: Box): MediaDuration | null {
  const body = box.bodyStart;
  if (body + 4 > box.end) return null;
  const version = bytes[body]!;
  if (version === 0) {
    if (body + 20 > box.end) return null;
    const timescale = readU32(bytes, body + 12);
    const duration = readU32(bytes, body + 16);
    return timescale > 0 && duration > 0 ? { timescale, duration } : null;
  }
  if (version === 1) {
    if (body + 32 > box.end) return null;
    const timescale = readU32(bytes, body + 20);
    const duration = readU64(bytes, body + 24);
    return timescale > 0 && duration > 0 ? { timescale, duration } : null;
  }
  return null;
}

/** `tkhd` 末尾是 16.16 定点宽高。 */
function readTkhd(bytes: Uint8Array, box: Box): { width: number; height: number } | null {
  const body = box.bodyStart;
  if (body + 4 > box.end) return null;
  const version = bytes[body]!;
  // tkhd v0: 4(ver/flags)+4+4+4+4+4+8+2+2+2+2 = 40，matrix 36 → 宽高在 body+76；
  // v1 的 creation/modification 各多 4 字节 → body+84。
  const matrixEnd = version === 1 ? body + 84 : body + 76;
  if (matrixEnd + 8 > box.end) return null;
  const width = readU32(bytes, matrixEnd) / 65536;
  const height = readU32(bytes, matrixEnd + 4) / 65536;
  return width > 0 && height > 0 ? { width, height } : null;
}

export function readWorldCaptureVideoInfo(bytes: Uint8Array): WorldCaptureVideoInfo | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return null;
  const top = readBoxes(bytes, 0, bytes.byteLength);
  if (!findBox(top, "ftyp") || !findBox(top, "moov") || !findBox(top, "mdat")) return null;

  const found: {
    duration: MediaDuration | null;
    dimensions: { width: number; height: number } | null;
  } = { duration: null, dimensions: null };

  const visit = (boxes: readonly Box[], depth: number): void => {
    if (depth > MAX_BOX_DEPTH) return;
    for (const box of boxes) {
      if (box.type === "mdhd") {
        if (found.duration === null) found.duration = readMdhd(bytes, box);
      } else if (box.type === "tkhd") {
        if (found.dimensions === null) found.dimensions = readTkhd(bytes, box);
      } else if (box.type === "moov" || box.type === "trak" || box.type === "mdia") {
        visit(readBoxes(bytes, box.bodyStart, box.end), depth + 1);
      }
    }
  };
  visit(top, 0);

  if (!found.duration || !found.dimensions) return null;
  return {
    container: "video/mp4",
    durationSeconds: found.duration.duration / found.duration.timescale,
    width: Math.round(found.dimensions.width),
    height: Math.round(found.dimensions.height)
  };
}
