/**
 * 归档包（`.woohaa-archive`）的打包与解包。
 *
 * `CanvasArchive`（见 archive-format.ts）是 **metadata-only** 的：它只记资产的
 * `storageKey / checksum / contentType / size`，不含二进制。所以「把画布搬到别的盘」必须
 * 把归档 JSON 与被引用的媒体字节放在一起 —— 这就是本模块的职责。
 *
 * 包格式（普通 zip，任何解压工具都能打开）：
 * ```
 * archive.json          归档对象本体（就是 CanvasArchive 那一个 JSON）
 * media/<storageKey>    归档中引用到的全部媒体字节，路径与 storageKey 一一对应
 * ```
 *
 * 为什么是 zip 而不是自己发明一个容器：用户要「存到别的盘、以后找回来」，出问题时能直接用
 * 系统解压工具打开看一眼，比任何自定义格式都可靠。
 *
 * **只用 store（不压缩）**：媒体本身已是压缩格式（PNG/JPEG/MP4），再压一遍绝大多数情况
 * 反而更大、还慢了；`archive.json` 只有几十到几百 KB，不值得为它引入压缩路径。
 * 解包端仍然认 deflate，方便用户手工重打包过的包也能读。
 *
 * **与 `web/backend/src/scene-package/archive.ts` 的关系（刻意不合并）**：
 * 那边是离线场景包，包内固定 `manifest.json` / `scene.json` / `media/<sha256>.<ext>`，
 * 条目名用白名单正则校验 —— 它只面对自己生成或自己校验过的包，可以严到只认这三种名字。
 * 本模块面对的是**用户自己的归档**，媒体条目名来自 `storageKey`，必须放行任意合法路径。
 * 所以两份手写 zip 编解码**不能抽成一份共用工具**：要么归档装不了自定义命名的媒体，
 * 要么场景包被迫放松对导入包的条目名校验（那是安全倒退）。
 * 改其中一份时，别去"顺手统一"另一份。
 */
import { inflateRawSync } from "node:zlib";

/** 归档包内的归档对象文件名。 */
export const ARCHIVE_ENTRY_NAME = "archive.json";
/** 媒体文件在包内的目录前缀。 */
export const ARCHIVE_MEDIA_PREFIX = "media/";
/** 单个条目的解压上限，防 zip bomb。 */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** 整包解压上限。 */
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;
/** 条目数上限。 */
export const MAX_ENTRIES = 100_000;

export type ArchiveMediaEntry = {
  storageKey: string;
  bytes: Uint8Array;
};

export type ArchiveReadResult =
  | {
      ok: true;
      /** 原样交还，形状由 `validateArchiveShape` / `verifyArchive` 判定。 */
      archive: unknown;
      media: Map<string, Uint8Array>;
    }
  | { ok: false; code: ArchivePackageErrorCode; detail: string };

export type ArchivePackageErrorCode =
  | "not-a-zip"
  | "truncated"
  | "unsupported-method"
  | "too-large"
  | "bad-entry-name"
  | "duplicate-entry"
  | "missing-archive"
  | "corrupt";

// ---------------------------------------------------------------------------
// CRC32（PKZIP 规范用的反射多项式 0xEDB88320）
// ---------------------------------------------------------------------------

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
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

/** 包内路径 → 媒体键。反向的唯一合法来源，解包时按它还原 storageKey。 */
export function mediaEntryName(storageKey: string): string {
  return `${ARCHIVE_MEDIA_PREFIX}${storageKey}`;
}

/**
 * 校验一个待写入的包内路径。
 *
 * 解包端会用它挡住 zip-slip：绝对路径、盘符、`..` 段、反斜杠与控制字符一律拒绝。
 * 写包时同样走一遍 —— 损坏的 storageKey 不该被静默写进归档。
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.includes("\\")) return false;
  // NUL 与其它控制字符
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !name.split("/").some((segment) => segment === ".." || segment === "");
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
/** 通用标志位 bit 11：文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

type PreparedEntry = { name: Uint8Array; data: Uint8Array; crc: number; offset: number };

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * 把归档对象与媒体字节打成一个 zip。
 *
 * `archive` 原样序列化，不做任何裁剪：归档包是**自证**的（内含 SHA-256 清单），
 * 打包阶段改动内容就破坏了它的校验语义。
 */
export function writeArchivePackage(
  archive: unknown,
  media: readonly ArchiveMediaEntry[],
  options: { now?: Date } = {}
): Uint8Array {
  const stamp = dosDateTime(options.now ?? new Date());
  const entries: Array<{ name: string; bytes: Uint8Array }> = [
    { name: ARCHIVE_ENTRY_NAME, bytes: new TextEncoder().encode(JSON.stringify(archive)) }
  ];

  const seen = new Set<string>([ARCHIVE_ENTRY_NAME]);
  for (const entry of media) {
    const name = mediaEntryName(entry.storageKey);
    if (!isSafeEntryName(name)) throw new Error(`归档条目名不合法：${entry.storageKey}`);
    if (seen.has(name)) throw new Error(`归档条目重复：${name}`);
    seen.add(name);
    entries.push({ name, bytes: entry.bytes });
  }
  if (entries.length > MAX_ENTRIES) throw new Error(`归档条目过多：${entries.length}`);

  const prepared: PreparedEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, ZIP_LOCAL_SIG, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    header.set(name, 30);

    prepared.push({ name, data: entry.bytes, crc, offset });
    chunks.push(header);
    chunks.push(entry.bytes);
    offset += header.length + entry.bytes.length;
  }

  const centralStart = offset;
  for (const entry of prepared) {
    const header = new Uint8Array(46 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, ZIP_CENTRAL_SIG, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, METHOD_STORE, true);
    view.setUint16(12, stamp.time, true);
    view.setUint16(14, stamp.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true); // extra
    view.setUint16(32, 0, true); // comment
    view.setUint16(34, 0, true); // disk
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, entry.offset, true);
    header.set(entry.name, 46);
    chunks.push(header);
    offset += header.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_EOCD_SIG, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, prepared.length, true);
  eocdView.setUint16(10, prepared.length, true);
  eocdView.setUint32(12, offset - centralStart, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  chunks.push(eocd);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 解包
// ---------------------------------------------------------------------------

function findEocd(bytes: Uint8Array): number {
  // EOCD 尾部可能带最多 65535 字节注释；从后往前找签名。
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let index = bytes.length - 22; index >= min; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      return index;
    }
  }
  return -1;
}

/**
 * 解开一个归档包。
 *
 * 只做**结构性**校验（能不能读、路径是否安全、有没有 archive.json）；归档内容本身的
 * 合法性由 `verifyArchive` 负责 —— 两件事分开，错误信息才不会互相混淆。
 */
export function readArchivePackage(bytes: Uint8Array): ArchiveReadResult {
  if (bytes.length < 22) return { ok: false, code: "not-a-zip", detail: "文件太小，不是归档包" };
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, code: "not-a-zip", detail: "找不到 zip 目录（文件可能不是 .woohaa-archive）" };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) return { ok: false, code: "too-large", detail: `条目过多：${count}` };
  if (centralOffset + centralSize > bytes.length) {
    return { ok: false, code: "truncated", detail: "中央目录越界，文件不完整" };
  }

  const decoder = new TextDecoder();
  const media = new Map<string, Uint8Array>();
  let archive: unknown;
  let foundArchive = false;
  let totalBytes = 0;
  const seen = new Set<string>();

  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length) return { ok: false, code: "truncated", detail: "中央目录项越界" };
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIG) {
      return { ok: false, code: "corrupt", detail: "中央目录签名不匹配" };
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) return { ok: false, code: "truncated", detail: "条目名越界" };
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (flags & 0x0001) {
      return { ok: false, code: "unsupported-method", detail: "不支持加密的归档条目" };
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      return { ok: false, code: "unsupported-method", detail: `不支持的压缩方式：${method}` };
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      return { ok: false, code: "too-large", detail: `条目过大：${name}` };
    }
    if (!isSafeEntryName(name)) {
      return { ok: false, code: "bad-entry-name", detail: `条目名不安全：${name}` };
    }
    if (seen.has(name)) return { ok: false, code: "duplicate-entry", detail: `条目重复：${name}` };
    seen.add(name);

    // 本地头长度可能与本目录项不同（额外字段），按本地头自己的长度定位数据。
    if (localOffset + 30 > bytes.length) return { ok: false, code: "truncated", detail: `${name} 的本地头越界` };
    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIG) {
      return { ok: false, code: "corrupt", detail: `${name} 的本地头签名不匹配` };
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      return { ok: false, code: "truncated", detail: `${name} 的数据越界` };
    }

    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === METHOD_STORE) {
      data = raw;
    } else {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
      } catch (error) {
        return { ok: false, code: "corrupt", detail: `${name} 解压失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    totalBytes += data.length;
    if (totalBytes > MAX_PACKAGE_BYTES) return { ok: false, code: "too-large", detail: "归档包解压后过大" };
    if (crc32(data) !== crc) return { ok: false, code: "corrupt", detail: `${name} 校验和不匹配（文件已损坏）` };

    if (name === ARCHIVE_ENTRY_NAME) {
      foundArchive = true;
      try {
        archive = JSON.parse(decoder.decode(data));
      } catch (error) {
        return { ok: false, code: "corrupt", detail: `archive.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
      }
    } else if (name.startsWith(ARCHIVE_MEDIA_PREFIX)) {
      media.set(name.slice(ARCHIVE_MEDIA_PREFIX.length), data);
    }
    // 其它条目（例如用户解压后放进去的 README）忽略，不算错误。
  }

  if (!foundArchive) return { ok: false, code: "missing-archive", detail: "归档包里没有 archive.json" };
  return { ok: true, archive, media };
}

/**
 * 找出归档里引用了、但包里没带上的媒体键。
 *
 * 「能搬走、能找回来」的前提是字节齐全。缺一个也不允许静默通过 —— 恢复时才会发现
 * 图片是一片灰，那时候已经来不及了。
 */
export function findMissingMedia(archive: unknown, media: ReadonlyMap<string, Uint8Array>): string[] {
  if (typeof archive !== "object" || archive === null) return [];
  const canvases = (archive as { canvases?: unknown }).canvases;
  if (!Array.isArray(canvases)) return [];
  const missing = new Set<string>();
  for (const record of canvases) {
    if (typeof record !== "object" || record === null) continue;
    const assets = (record as { assets?: unknown }).assets;
    if (Array.isArray(assets)) {
      for (const asset of assets) {
        if (typeof asset !== "object" || asset === null) continue;
        const key = (asset as { storageKey?: unknown }).storageKey;
        if (typeof key === "string" && key.length > 0 && !media.has(key)) missing.add(key);
      }
    }
    const mediaReferences = (record as { mediaReferences?: unknown }).mediaReferences;
    if (Array.isArray(mediaReferences)) {
      for (const reference of mediaReferences) {
        if (typeof reference !== "object" || reference === null) continue;
        const key = (reference as { storageKey?: unknown }).storageKey;
        if (typeof key === "string" && key.length > 0 && !media.has(key)) missing.add(key);
      }
    }
  }
  return [...missing].sort();
}
