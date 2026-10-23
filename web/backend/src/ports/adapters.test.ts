/**
 * 进程内 Media 契约适配器的画布作用域透传。
 *
 * Canvas 的资产核验与 Task 的结果材料化都经这两个适配器走同一份 `BackendMediaPort`；
 * 作用域/canvasId 必须原样到达端口，否则远端画布会退化成只查主存储。
 */
import { describe, expect, it } from "vitest";
import type { BackendMediaPort, MediaMetadata } from "@woohaa3/contracts";
import { mediaPortToCanvasMediaClient, mediaPortToTaskMediaClient } from "./adapters.js";

function metadata(storageKey = `generation-outputs/${"a".repeat(64)}.png`): MediaMetadata {
  return { storageKey, contentType: "image/png", size: 4, checksum: "a".repeat(64), mediaKind: "image" };
}

function recordingPort() {
  const verifyCalls: Array<{ storageKey: string; scope?: { canvasId: string } }> = [];
  const importCalls: Array<Record<string, unknown>> = [];
  const signCalls: unknown[] = [];
  const port: BackendMediaPort = {
    async verify(storageKey, _expected, scope) {
      verifyCalls.push({ storageKey, ...(scope ? { scope } : {}) });
      return { exists: true, matches: true, metadata: metadata(storageKey) };
    },
    async sign(storageKey, expiresSeconds, scope) {
      signCalls.push({ storageKey, expiresSeconds, scope });
      return "https://cos.example/signed";
    },
    async importFromLocator(input) {
      importCalls.push({ locator: input.locator });
      return metadata("media/locator.png");
    },
    async importFromUrl(input) {
      importCalls.push({ kind: "url", ...input });
      return metadata();
    },
    async importBytes(input) {
      importCalls.push({ kind: "bytes", ...input });
      return metadata();
    }
  };
  return { port, verifyCalls, importCalls, signCalls };
}

describe("mediaPortToCanvasMediaClient", () => {
  it("verify 把 scope 原样透传给端口", async () => {
    const { port, verifyCalls } = recordingPort();
    await mediaPortToCanvasMediaClient(port).verify(`sha256-${"b".repeat(64)}`, undefined, { canvasId: "canvas-a" });
    expect(verifyCalls).toEqual([{ storageKey: `sha256-${"b".repeat(64)}`, scope: { canvasId: "canvas-a" } }]);
  });
});

describe("mediaPortToTaskMediaClient", () => {
  it("verify 保留画布作用域（远端生成结果的 verify-and-adopt 依赖它）", async () => {
    // 这条曾经缺失，于是 verify 把 scope 吞掉：远端结果对象在 <canvasId>/media/<key> 下，
    // 无作用域读取会把它报成不存在，表现为「provider image 结果核验失败」——而对象其实在。
    const { port, verifyCalls } = recordingPort();
    const client = mediaPortToTaskMediaClient(port);
    const key = metadata().storageKey;
    const expected = { contentType: "image/png", size: 4 };
    await client.verify(key, expected, { canvasId: "canvas-remote" });
    await client.verify(key, expected);
    // 记录器只记 storageKey 与 scope（scope 才是这条测试要盯的东西）。
    expect(verifyCalls).toEqual([
      { storageKey: key, scope: { canvasId: "canvas-remote" } },
      { storageKey: key, scope: undefined }
    ]);
  });

  it("参考图签名保留画布作用域，无作用域任务保持默认存储", async () => {
    const { port, signCalls } = recordingPort();
    const client = mediaPortToTaskMediaClient(port);
    const key = metadata().storageKey;
    await client.sign(key, 900, { canvasId: "canvas-remote" });
    await client.sign(key, 900);
    expect(signCalls).toEqual([
      { storageKey: key, expiresSeconds: 900, scope: { canvasId: "canvas-remote" } },
      { storageKey: key, expiresSeconds: 900, scope: undefined }
    ]);
  });

  it("importFromUrl/importBytes 把 canvasId 原样透传给端口", async () => {
    const { port, importCalls } = recordingPort();
    const client = mediaPortToTaskMediaClient(port);
    await client.importFromUrl({ url: "https://provider.example/a.png", maxBytes: 1024, canvasId: "canvas-b" });
    await client.importBytes({ bytesBase64: "AQID", contentType: "image/png", maxBytes: 1024, canvasId: "canvas-b" });
    expect(importCalls).toEqual([
      { kind: "url", url: "https://provider.example/a.png", maxBytes: 1024, canvasId: "canvas-b" },
      { kind: "bytes", bytesBase64: "AQID", contentType: "image/png", maxBytes: 1024, canvasId: "canvas-b" }
    ]);
  });
});
