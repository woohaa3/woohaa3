/**
 * 帧序列打包（U77）：把逐帧 PNG 打成一个 ZIP 字节流，一次下载。
 *
 * 为什么需要：浏览器对「一次用户手势触发多个下载」普遍拦截或要求逐次确认，几十帧的序列会
 * 变成几十次确认。这里用 **store（不压缩）** 的 ZIP：PNG 本身已压缩，再 deflate 收益很小，
 * 而我们不需要为此引入压缩库或宿主端口。
 *
 * 约束：只在内存里按帧追加，写完为止；单文件上限与总大小由调用方（帧预算）先保证。
 */

/** CRC-32（IEEE 802.3），ZIP 每个条目都要。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; bytes: Uint8Array };

/** 单个条目/条目名的字段上限（非 ZIP64 格式）。 */
export const ZIP_LIMITS = {
  entries: 0xffff,
  entryBytes: 0xffffffff,
  nameBytes: 0xffff,
  offset: 0xffffffff
} as const;

/** 超出非 ZIP64 格式的表示范围：明确失败，不写出被截断字段的坏包。 */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

/** UTF-8 文件名（ZIP 的通用标志位 bit 11）。 */
function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/**
 * 生成 store-only ZIP。
 *
 * 固定时间戳（1980-01-01 00:00）让同一输入产出同一字节，便于测试与内容比较；ZIP 不写注释。
 */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > ZIP_LIMITS.entries) {
    throw new ZipLimitError(`条目数超过 ZIP 上限：${entries.length} > ${ZIP_LIMITS.entries}`);
  }
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const entry of entries) {
    const name = encodeName(entry.name);
    if (name.length > ZIP_LIMITS.nameBytes) {
      throw new ZipLimitError(`条目名超过 ZIP 上限：${name.length} > ${ZIP_LIMITS.nameBytes} 字节`);
    }
    if (entry.bytes.length > ZIP_LIMITS.entryBytes) {
      throw new ZipLimitError(`条目超过 ZIP 上限：${entry.bytes.length} > ${ZIP_LIMITS.entryBytes} 字节`);
    }
    if (offset > ZIP_LIMITS.offset) {
      throw new ZipLimitError(`累计偏移超过 ZIP 上限：${offset} > ${ZIP_LIMITS.offset} 字节`);
    }
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 name
    view.setUint16(8, 0, true); // store
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    chunks.push(local);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true); // central directory header
    headerView.setUint16(4, 20, true); // version made by
    headerView.setUint16(6, 20, true); // version needed
    headerView.setUint16(8, 0x0800, true);
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, DOS_TIME, true);
    headerView.setUint16(14, DOS_DATE, true);
    headerView.setUint32(16, checksum, true);
    headerView.setUint32(20, entry.bytes.length, true);
    headerView.setUint32(24, entry.bytes.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true); // extra
    headerView.setUint16(32, 0, true); // comment
    headerView.setUint16(34, 0, true); // disk
    headerView.setUint16(36, 0, true); // internal attrs
    headerView.setUint32(38, 0, true); // external attrs
    headerView.setUint32(42, offset, true); // local header offset
    header.set(name, 46);
    central.push(header);

    offset += local.length;
  }
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  if (offset > ZIP_LIMITS.offset || centralSize > ZIP_LIMITS.offset) {
    throw new ZipLimitError(`ZIP 目录偏移超过上限：${offset}/${centralSize} > ${ZIP_LIMITS.offset} 字节`);
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
