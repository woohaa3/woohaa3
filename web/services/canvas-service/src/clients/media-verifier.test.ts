/**
 * Canvas media verifier 的画布作用域透传。
 *
 * Canvas 不持有存储凭据：资产存在性最终由 Media Service 核验。远端画布的字节只在托管
 * 存储里，所以调用方给了 scope 时必须原样带给 verify，否则会误判为不存在。
 */
import { describe, expect, it } from "vitest";
import type { MediaMetadata } from "@woohaa3/contracts";
import type { CanvasMediaClient } from "./media-client.js";
import { createMediaVerifierStorage } from "./media-verifier.js";

const KEY = `generation-outputs/${"a".repeat(64)}.png`;

function metadata(): MediaMetadata {
  return { storageKey: KEY, contentType: "image/png", size: 4, checksum: "a".repeat(64), mediaKind: "image" };
}

function recordingClient() {
  const calls: Array<{ storageKey: string; scope?: { canvasId: string } }> = [];
  const client: CanvasMediaClient = {
    async verify(storageKey, _expected, scope) {
      calls.push({ storageKey, ...(scope ? { scope } : {}) });
      return { exists: true, matches: true, metadata: metadata() };
    }
  };
  return { calls, client };
}

describe("createMediaVerifierStorage 画布作用域", () => {
  it("exists/stat 把 scope 原样透传给 verify", async () => {
    const { calls, client } = recordingClient();
    const storage = createMediaVerifierStorage({ client });
    await expect(storage.exists(KEY, { canvasId: "canvas-a" })).resolves.toBe(true);
    await expect(storage.stat!(KEY, { canvasId: "canvas-a" })).resolves.toEqual({ size: 4, contentType: "image/png" });
    expect(calls).toEqual([
      { storageKey: KEY, scope: { canvasId: "canvas-a" } },
      { storageKey: KEY, scope: { canvasId: "canvas-a" } }
    ]);
  });

  it("调用方没有 scope 时不添加作用域（保持旧行为）", async () => {
    const { calls, client } = recordingClient();
    const storage = createMediaVerifierStorage({ client });
    await expect(storage.exists(KEY)).resolves.toBe(true);
    expect(calls).toEqual([{ storageKey: KEY }]);
  });

  it("verify 报不存在时 stat 抛 MediaObjectNotFoundError", async () => {
    const client: CanvasMediaClient = {
      async verify(_storageKey) {
        return { exists: false, matches: false };
      }
    };
    const storage = createMediaVerifierStorage({ client });
    await expect(storage.stat!(KEY, { canvasId: "canvas-a" })).rejects.toThrow(/not found|不存在/i);
  });
});
