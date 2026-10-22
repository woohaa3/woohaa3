/**
 * 导入候选的媒体核验带画布作用域。
 *
 * 候选画布的 id 就是导入目标的画布 id；远端画布的字节只在托管存储里，核验必须带 scope，
 * 否则合法候选会被误判为 MEDIA_MISSING。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type MediaObject, type MediaStorage, type StoredAsset } from "@woohaa3/contracts";
import { validateImportCandidate } from "./candidate-validation.js";

const NOW = "2026-10-20T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

function imageAsset(): StoredAsset {
  return {
    id: "asset-image",
    nodeId: "node-image",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
  };
}

function recordingStorage(): { storage: MediaStorage; scopes: Array<{ canvasId: string } | undefined> } {
  const scopes: Array<{ canvasId: string } | undefined> = [];
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const storage: MediaStorage = {
    async put() {},
    async get(): Promise<MediaObject> {
      return { bytes, contentType: "image/png" };
    },
    async exists(_key, scope) {
      scopes.push(scope);
      return true;
    },
    async stat(_key, scope) {
      scopes.push(scope);
      return { size: bytes.byteLength, contentType: "image/png" };
    }
  };
  return { storage, scopes };
}

describe("validateImportCandidate 媒体核验作用域", () => {
  it("用候选画布 id 作为 scope 核验资产", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-import", NOW);
    const candidate = { ...canvas, assets: [imageAsset()] };
    const { storage, scopes } = recordingStorage();
    const result = await validateImportCandidate({ candidate, mediaStorage: storage, now: NOW });
    expect(result.ok).toBe(true);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope?.canvasId === "canvas-import")).toBe(true);
  });
});
