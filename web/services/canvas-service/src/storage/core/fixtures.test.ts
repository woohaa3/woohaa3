/**
 * Contract fixtures（任务 1.2）。
 *
 * 这些 fixture 覆盖空画布、完整 nodes/edges/nodeData、assets/jobs、多 revision 和
 * COS 图片引用，是 SQLite/Mongo adapter contract suite 与归档测试的共同输入。
 *
 * 关键断言：fixture 经 domain 规范化后必须是纯 JSON —— 不含 Blob、base64、`blob:` URL
 * 或临时签名 URL。任何 adapter 写进数据库的数据都不可能比这里更"脏"。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCanvasAggregate } from "@woohaa3/contracts";

const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const NOW = "2026-09-23T00:00:00.000Z";

const FIXTURES = [
  "empty-canvas.json",
  "canvas-with-cos-asset.json"
] as const;

function load(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, "utf8"));
}

describe("contract fixtures", () => {
  for (const name of FIXTURES) {
    it(`${name} 通过 domain 规范化且不含二进制/临时 URL`, () => {
      const parsed = parseCanvasAggregate(load(name), { now: NOW });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const json = JSON.stringify(parsed.canvas);
      expect(json).not.toContain("base64");
      expect(json).not.toContain("data:image");
      expect(json).not.toContain("blob:");
      expect(json).not.toContain("X-Amz-Signature");
      expect(json).not.toContain("q-sign-algorithm");
      expect(() => JSON.parse(json)).not.toThrow();
      // 稳定 COS 引用只以 storageKey/checksum 形式出现。
      for (const asset of parsed.canvas.assets) {
        const metadata = asset.metadata as Record<string, unknown> | undefined;
        if (metadata?.storageKey) {
          expect(typeof metadata.storageKey).toBe("string");
          expect(String(metadata.storageKey)).not.toMatch(/^https?:/);
        }
      }
    });
  }

  it("COS fixture 保留稳定资产 metadata 与多 revision", () => {
    const parsed = parseCanvasAggregate(load("canvas-with-cos-asset.json"), { now: NOW });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.canvas.revision).toBe(3);
    const asset = parsed.canvas.assets[0];
    expect(asset.mediaKind).toBe("image");
    expect(asset.metadata).toMatchObject({
      contentType: "image/png",
      size: 2048
    });
    expect(String((asset.metadata as Record<string, unknown>).storageKey))
      .toMatch(/^generation-outputs\//);
  });

  it("空画布 fixture 规范化后仍为空且 revision 0", () => {
    const parsed = parseCanvasAggregate(load("empty-canvas.json"), { now: NOW });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.canvas.revision).toBe(0);
    expect(parsed.canvas.document.nodes).toEqual([]);
    expect(parsed.canvas.assets).toEqual([]);
    expect(parsed.canvas.jobs).toEqual([]);
  });
});
