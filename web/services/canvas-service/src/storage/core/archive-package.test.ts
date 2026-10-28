/**
 * 归档包（zip）编解码测试。
 *
 * 覆盖：往返一致、CRC 校验、截断/损坏检测、zip-slip 拒绝、缺件检测、deflate 兼容。
 * 这里不测归档语义（SHA-256 清单、no-overwrite 等），那些在 archive.test.ts。
 */
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  ARCHIVE_ENTRY_NAME,
  MAX_ENTRY_BYTES,
  crc32,
  findMissingMedia,
  isSafeEntryName,
  mediaEntryName,
  readArchivePackage,
  writeArchivePackage
} from "./archive-package.js";

const ARCHIVE = {
  format: "woohaa3-canvas-archive-v1",
  createdAt: "2026-10-28T00:00:00.000Z",
  canvases: [
    {
      canvasId: "canvas-a",
      revision: 3,
      updatedAt: "2026-10-28T00:00:00.000Z",
      canvas: { id: "canvas-a" },
      assets: [{ assetId: "a1", storageKey: "sha256-aaa", checksum: "aaa", contentType: "image/png", size: 4 }]
    }
  ],
  operations: [],
  files: []
};

const PNG = new Uint8Array([1, 2, 3, 4, 5]);

function roundTrip() {
  return writeArchivePackage(ARCHIVE, [{ storageKey: "sha256-aaa", bytes: PNG }]);
}

describe("crc32", () => {
  it("匹配已知值", () => {
    // 标准测试向量："123456789" → 0xCBF43926
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("空输入是 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("条目名安全", () => {
  it("接受正常路径", () => {
    expect(isSafeEntryName("archive.json")).toBe(true);
    expect(isSafeEntryName("media/sha256-abc.png")).toBe(true);
  });

  it("拒绝越界与非法形态", () => {
    expect(isSafeEntryName("../etc/passwd")).toBe(false);
    expect(isSafeEntryName("media/../../x")).toBe(false);
    expect(isSafeEntryName("/abs/path")).toBe(false);
    expect(isSafeEntryName("C:\\Windows\\x")).toBe(false);
    expect(isSafeEntryName("media\\x")).toBe(false);
    expect(isSafeEntryName("a//b")).toBe(false);
    expect(isSafeEntryName("")).toBe(false);
    expect(isSafeEntryName("bad\u0000name")).toBe(false);
  });
});

describe("打包 / 解包", () => {
  it("往返后归档对象与媒体字节都一致", () => {
    const bytes = roundTrip();
    const result = readArchivePackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive).toEqual(ARCHIVE);
    expect([...result.media.keys()]).toEqual(["sha256-aaa"]);
    expect([...(result.media.get("sha256-aaa") ?? [])]).toEqual([...PNG]);
  });

  it("产物是标准 zip：本地头与 EOCD 签名都在", () => {
    const bytes = roundTrip();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2); // archive.json + 1 个媒体
  });

  it("没有媒体也能往返", () => {
    const bytes = writeArchivePackage(ARCHIVE, []);
    const result = readArchivePackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media.size).toBe(0);
  });

  it("重复的媒体键被拒绝，不会静默覆盖", () => {
    expect(() =>
      writeArchivePackage(ARCHIVE, [
        { storageKey: "sha256-aaa", bytes: PNG },
        { storageKey: "sha256-aaa", bytes: PNG }
      ])
    ).toThrow(/重复/);
  });

  it("非法的 storageKey 被拒绝", () => {
    expect(() => writeArchivePackage(ARCHIVE, [{ storageKey: "../evil", bytes: PNG }])).toThrow(/不合法/);
  });
});

describe("损坏检测", () => {
  it("太小的文件报 not-a-zip", () => {
    const result = readArchivePackage(new Uint8Array([1, 2, 3]));
    expect(result).toMatchObject({ ok: false, code: "not-a-zip" });
  });

  it("随机字节报 not-a-zip", () => {
    const junk = new Uint8Array(2000).fill(0x41);
    expect(readArchivePackage(junk)).toMatchObject({ ok: false, code: "not-a-zip" });
  });

  it("截断的文件报 truncated", () => {
    const bytes = roundTrip();
    const truncated = bytes.subarray(0, bytes.length - 10);
    const result = readArchivePackage(truncated);
    expect(result.ok).toBe(false);
  });

  it("改一个字节会被 CRC 抓到", () => {
    const bytes = roundTrip();
    // archive.json 的数据区在本地头之后，翻一个字节
    const copy = new Uint8Array(bytes);
    // 找到 archive.json 内容的第一个 '{'
    const index = copy.indexOf(0x7b);
    copy[index] = 0x7d;
    const result = readArchivePackage(copy);
    expect(result).toMatchObject({ ok: false, code: "corrupt" });
  });

  it("没有 archive.json 报 missing-archive", () => {
    // 手工构造一个只有媒体的包：借用 writer 会强制加 archive.json，
    // 所以从真包里删掉那一条再重算不现实 —— 直接验证 findMissingMedia 之外的分支足够。
    const bytes = writeArchivePackage({ format: "x", canvases: [] }, [{ storageKey: "sha256-aaa", bytes: PNG }]);
    // 把 archive.json 改名成 notes.json：中央目录与本地头都改
    const copy = new Uint8Array(bytes);
    const encoder = new TextEncoder().encode(ARCHIVE_ENTRY_NAME);
    for (let index = 0; index + encoder.length <= copy.length; index += 1) {
      let match = true;
      for (let offset = 0; offset < encoder.length; offset += 1) {
        if (copy[index + offset] !== encoder[offset]) {
          match = false;
          break;
        }
      }
      if (match) copy[index] = 0x7a; // 'a' → 'z'，名字变了但长度不变
    }
    const result = readArchivePackage(copy);
    expect(result).toMatchObject({ ok: false, code: "missing-archive" });
  });

  it("支持 deflate 压缩的条目（用户手工重打包过）", () => {
    // 手工构造一个只含 archive.json、用 deflate 存的 zip。
    const name = new TextEncoder().encode(ARCHIVE_ENTRY_NAME);
    const raw = new TextEncoder().encode(JSON.stringify(ARCHIVE));
    const compressed = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const centralOffset = local.length + compressed.length;
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true);
    central.set(name, 46);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, centralOffset, true);

    const pkg = new Uint8Array(local.length + compressed.length + central.length + eocd.length);
    let cursor = 0;
    for (const part of [local, compressed, central, eocd]) {
      pkg.set(part, cursor);
      cursor += part.length;
    }

    const result = readArchivePackage(pkg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive).toEqual(ARCHIVE);
    expect(result.media.size).toBe(0);
  });

  it("解压后超过上限时报 too-large", () => {
    // 构造一个声明体积超限的条目：writer 不压缩，所以直接把 uncompressedSize 改大。
    const bytes = roundTrip();
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    // 中央目录第一项的 uncompressedSize 偏移：centralStart + 24
    const eocd = copy.length - 22;
    const centralStart = view.getUint32(eocd + 16, true);
    view.setUint32(centralStart + 24, MAX_ENTRY_BYTES + 1, true);
    const result = readArchivePackage(copy);
    expect(result).toMatchObject({ ok: false, code: "too-large" });
  });
});

describe("缺件检测", () => {
  it("引用齐全时返回空数组", () => {
    const bytes = roundTrip();
    const result = readArchivePackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findMissingMedia(result.archive, result.media)).toEqual([]);
  });

  it("少了一个媒体就报出来", () => {
    const bytes = writeArchivePackage(ARCHIVE, []);
    const result = readArchivePackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findMissingMedia(result.archive, result.media)).toEqual(["sha256-aaa"]);
  });

  it("也检查扩展媒体引用", () => {
    const archive = {
      canvases: [{ canvasId: "c", canvas: {}, assets: [], mediaReferences: [{ storageKey: "sha256-bbb" }] }]
    };
    const bytes = writeArchivePackage(archive, []);
    const result = readArchivePackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findMissingMedia(result.archive, result.media)).toEqual(["sha256-bbb"]);
  });

  it("形状不对时返回空数组而不是抛错", () => {
    expect(findMissingMedia(null, new Map())).toEqual([]);
    expect(findMissingMedia({}, new Map())).toEqual([]);
    expect(findMissingMedia({ canvases: "nope" }, new Map())).toEqual([]);
  });
});

describe("条目命名", () => {
  it("媒体键映射到 media/ 前缀", () => {
    expect(mediaEntryName("sha256-abc")).toBe("media/sha256-abc");
  });
});
