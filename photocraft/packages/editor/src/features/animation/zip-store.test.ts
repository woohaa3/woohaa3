/**
 * ZIP store 回归（U77）：帧序列一次下载。
 *
 * 只验证我们能自己核对的结构：local header / central directory / EOCD 的签名、计数、偏移、
 * CRC 与原始字节。不依赖外部解压库。
 */
import { describe, expect, it } from "vitest";
import { ZIP_LIMITS, ZipLimitError, crc32, zipStore } from "./zip-store.js";

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe("ZIP store", () => {
  it("CRC-32 与已知值一致", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("写出可定位的 local header、中央目录与 EOCD", () => {
    const entries = [
      { name: "frame-0001.png", bytes: new Uint8Array([1, 2, 3]) },
      { name: "frame-0002.png", bytes: new Uint8Array([4, 5]) }
    ];
    const zip = zipStore(entries);
    const data = view(zip);
    expect(data.getUint32(0, true)).toBe(0x04034b50);
    expect(data.getUint16(6, true)).toBe(0x0800); // UTF-8 标志
    expect(data.getUint16(8, true)).toBe(0); // store
    expect(data.getUint32(14, true)).toBe(crc32(entries[0]!.bytes));
    expect(data.getUint32(18, true)).toBe(3);
    // 第一个条目的名字与内容紧随其后。
    const firstName = new TextDecoder().decode(zip.slice(30, 30 + 14));
    expect(firstName).toBe("frame-0001.png");
    expect([...zip.slice(30 + 14, 30 + 14 + 3)]).toEqual([1, 2, 3]);

    // EOCD 在最后 22 字节。
    const end = zip.length - 22;
    expect(data.getUint32(end, true)).toBe(0x06054b50);
    expect(data.getUint16(end + 8, true)).toBe(2);
    expect(data.getUint16(end + 10, true)).toBe(2);
    const centralOffset = data.getUint32(end + 16, true);
    expect(data.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(data.getUint32(centralOffset + 42, true)).toBe(0); // 第一条目的 local offset
  });

  it("同一输入产出同一字节（时间戳固定）", () => {
    const entries = [{ name: "a.png", bytes: new Uint8Array([9, 9]) }];
    expect([...zipStore(entries)]).toEqual([...zipStore(entries)]);
  });

  it("空列表只写 EOCD", () => {
    const zip = zipStore([]);
    expect(zip.length).toBe(22);
    expect(view(zip).getUint32(0, true)).toBe(0x06054b50);
  });

  it("超出非 ZIP64 表示范围时明确失败，不写出被截断的坏包", () => {
    // 条目数：构造 65536 个空条目只为触发上限，不实际编码。
    const tooMany = Array.from({ length: ZIP_LIMITS.entries + 1 }, () => ({ name: "a", bytes: new Uint8Array(0) }));
    expect(() => zipStore(tooMany)).toThrow(ZipLimitError);
    // 条目名超长。
    expect(() => zipStore([{ name: "x".repeat(ZIP_LIMITS.nameBytes + 1), bytes: new Uint8Array(1) }])).toThrow(ZipLimitError);
    // 错误信息说明实际值与上限，便于界面直接展示。
    try {
      zipStore([{ name: "x".repeat(ZIP_LIMITS.nameBytes + 1), bytes: new Uint8Array(1) }]);
      throw new Error("应该抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(ZipLimitError);
      expect((error as Error).message).toContain(String(ZIP_LIMITS.nameBytes));
    }
  });
});
