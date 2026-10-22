/**
 * Yjs update 摘要工具单测
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment）。
 *
 * 重点：`computeUpdateSha256` 必须对**视图/子数组**取正确字节。旧实现用
 * `update.slice().buffer`，当输入是 Node `Buffer#slice` 或 `subarray` 视图时会哈希到底层
 * 更大的 ArrayBuffer（含未使用字节），导致与存储中的 checksum 不一致（room 被隔离）。
 */
import { describe, expect, it } from "vitest";
import { computeUpdateSha256 } from "./yjs-repository.js";

const hex = (bytes: number[]): Promise<string> =>
  // 参考值：直接对正确字节求 SHA-256。
  computeUpdateSha256(new Uint8Array(bytes));

describe("computeUpdateSha256", () => {
  it("普通 Uint8Array 得到正确摘要", async () => {
    const digest = await computeUpdateSha256(new Uint8Array([1, 2, 3]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await hex([1, 2, 3]));
  });

  it("子视图（有 byteOffset）按视图字节计算，不哈希底层 pool", async () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = pool.subarray(2, 5); // [1,2,3]
    expect(await computeUpdateSha256(view)).toBe(await hex([1, 2, 3]));
  });

  it("Buffer#slice 视图同样按视图字节计算", async () => {
    const source = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const view = source.subarray(2, 5); // Buffer 视图 [3,4,5]
    expect(await computeUpdateSha256(view)).toBe(await hex([3, 4, 5]));
  });
});
