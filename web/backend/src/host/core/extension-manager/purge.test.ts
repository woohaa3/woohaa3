import { describe, expect, it } from "vitest";
import type { ExtensionDocumentOperation } from "@woohaa3/contracts";
import { purgeExtensionDocuments } from "./index.js";

function memoryStore(keys: string[]) {
  const docs = new Map(keys.map((key) => [key, { key, value: {}, revision: 1, updatedAt: "" }]));
  return {
    docs,
    async scan(prefix: string, options: { limit?: number } = {}) {
      const entries = [...docs.values()].filter((d) => d.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key)).slice(0, options.limit ?? 100);
      return { entries, nextCursor: null };
    },
    async batch(operations: readonly ExtensionDocumentOperation[]) {
      for (const op of operations) if (op.op === "delete") docs.delete(op.key);
      return { ok: true as const, revisions: {} };
    }
  };
}

describe("卸载时清除扩展数据", () => {
  it("分页删除 owner 空间里的全部文档，重复执行幂等", async () => {
    const store = memoryStore(Array.from({ length: 1203 }, (_, i) => `k${String(i).padStart(5, "0")}`));
    expect(await purgeExtensionDocuments(store)).toBe(1203);
    expect(store.docs.size).toBe(0);
    expect(await purgeExtensionDocuments(store)).toBe(0);
  });

  it("batch 失败时抛错，不报告清除成功", async () => {
    const store = memoryStore(["a"]);
    store.batch = async () => ({ ok: false, code: "invalid", message: "x" }) as never;
    await expect(purgeExtensionDocuments(store)).rejects.toThrow(/清除扩展数据失败/);
  });
});
