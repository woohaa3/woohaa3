/**
 * Canvas Service 脚本执行边界与 renderer client 测试
 * （change: enhance-model-scene-authoring-api，任务 7.1–7.4）。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeModelScriptVersioned, sceneIrVersionFor } from "@woohaa3/contracts";
import { executeSceneIr, normalizeCaptureOptions } from "./script-executor.js";
import { createRendererClient, renderCacheKey } from "../model-renderer/client.js";
import { createRenderCache } from "../model-renderer/cache.js";

const V2_SCRIPT = `const m = scene.material({ id: "m", baseColor: "#26343a", metallic: 0.5 });
scene.segment({ id: "arm", from: [0,0,0], to: [0,1,0], width: 0.3, material: m });`;

/** 测试用同步执行器（复用共享版本 dispatch）。 */
function syncExecutor(source: string, version: never) {
  const r = executeModelScriptVersioned(source, version);
  if (!r.ok) return r;
  return { ok: true as const, version, sceneVersion: sceneIrVersionFor(version), ops: r.scene.ops, json: r.json, sourceHash: "h" };
}

describe("executeSceneIr", () => {
  it("executes a V2 script to normalized Scene IR (sync injection)", async () => {
    const result = await executeSceneIr(V2_SCRIPT, "woohaa-model-js-v2", { executeSync: syncExecutor as never });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sceneVersion).toBe("woohaa-model-scene-ir-v2");
    expect(result.ops.length).toBe(2);
  });

  it("rejects an unknown version without falling back", async () => {
    const result = await executeSceneIr(V2_SCRIPT, "woohaa-model-js-v9");
    expect(result).toMatchObject({ ok: false, code: "version-mismatch" });
  });

  it("rejects oversized source before executing", async () => {
    const result = await executeSceneIr("x".repeat(10), "woohaa-model-js-v2", { maxSourceChars: 5 });
    expect(result).toMatchObject({ ok: false, code: "source-too-long" });
  });

  it("rejects output over budget", async () => {
    const result = await executeSceneIr(V2_SCRIPT, "woohaa-model-js-v2", {
      maxOutputBytes: 10,
      executeSync: syncExecutor as never
    });
    expect(result).toMatchObject({ ok: false, code: "output-too-large" });
  });

  it("executes a V2 script in the real worker", async () => {
    const result = await executeSceneIr(V2_SCRIPT, "woohaa-model-js-v2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sceneVersion).toBe("woohaa-model-scene-ir-v2");
    expect(result.ops.length).toBe(2);
  });

  it("executes a V2 script when the process cwd is outside the package", async () => {
    const previous = process.cwd();
    process.chdir(path.resolve(previous, "../../.."));
    try {
      const result = await executeSceneIr(V2_SCRIPT, "woohaa-model-js-v2");
      expect(result.ok).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it("returns a stable timeout code for a runaway script", async () => {
    // 真实 worker：死循环必须被终止，不阻塞调用方。
    const result = await executeSceneIr("while (true) {}", "woohaa-model-js-v2", { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, code: "model-script-timeout" });
  }, 10_000);
});

describe("normalizeCaptureOptions", () => {
  it("applies defaults and validates bounds", () => {
    const ok = normalizeCaptureOptions({});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.options.width).toBe(512);
    expect(normalizeCaptureOptions({ width: 10000 }).ok).toBe(false);
    expect(normalizeCaptureOptions({ background: "http://x" }).ok).toBe(false);
    expect(normalizeCaptureOptions({ cameraPreset: "nope" }).ok).toBe(false);
  });
});

describe("renderer cache", () => {
  it("keys on sourceHash + sceneVersion + renderVersion + capture", () => {
    const base = { sourceHash: "a", sceneVersion: "v2", renderVersion: "r1", capture: { width: 64, height: 64, background: "transparent", cameraPreset: "dimetric" } };
    const key = renderCacheKey(base);
    expect(renderCacheKey({ ...base })).toBe(key);
    expect(renderCacheKey({ ...base, sourceHash: "b" })).not.toBe(key);
    expect(renderCacheKey({ ...base, capture: { ...base.capture, width: 128 } })).not.toBe(key);
    expect(renderCacheKey({ ...base, renderVersion: "r2" })).not.toBe(key);
  });

  it("evicts by byte budget and invalidates by renderVersion", () => {
    const cache = createRenderCache({ maxBytes: 20 });
    cache.set("a", { png: Buffer.alloc(10), width: 1, height: 1, sceneSignature: "s", renderVersion: "r1" });
    cache.set("b", { png: Buffer.alloc(10), width: 1, height: 1, sceneSignature: "s", renderVersion: "r1" });
    cache.set("c", { png: Buffer.alloc(10), width: 1, height: 1, sceneSignature: "s", renderVersion: "r1" });
    expect(cache.size().bytes).toBeLessThanOrEqual(20);
    cache.invalidateVersion("r2");
    expect(cache.size().entries).toBe(0);
  });
});

describe("renderer client", () => {
  it("is renderer-unavailable when no command is configured", async () => {
    const client = createRendererClient({});
    expect(client.available()).toBe(false);
    const result = await client.render({
      requestId: "r",
      sceneVersion: "woohaa-model-scene-ir-v2",
      signature: "s",
      extent: 1,
      ops: [],
      capture: { width: 64, height: 64, background: "transparent", cameraPreset: "dimetric" }
    });
    expect(result).toMatchObject({ ok: false, code: "renderer-unavailable" });
    await client.close();
  });

  it("returns render-failed when the process exits immediately", async () => {
    const client = createRendererClient({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      restartOnExit: false,
      timeoutMs: 500
    });
    const result = await client.render({
      requestId: "r",
      sceneVersion: "woohaa-model-scene-ir-v2",
      signature: "s",
      extent: 1,
      ops: [],
      capture: { width: 64, height: 64, background: "transparent", cameraPreset: "dimetric" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["render-failed", "render-timeout", "renderer-unavailable"]).toContain(result.code);
    await client.close();
  });

  it("bounds concurrency and returns render-busy past the queue limit", async () => {
    // 一个永不响应的 renderer：请求会排队，超出上限的立即返回 render-busy。
    const client = createRendererClient({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setTimeout(()=>{}, 60000)"],
      timeoutMs: 5000,
      concurrency: 1,
      maxQueue: 1
    });
    const request = (id: string) => ({
      requestId: id,
      sceneVersion: "woohaa-model-scene-ir-v2",
      signature: "s",
      extent: 1,
      ops: [],
      capture: { width: 64, height: 64, background: "transparent", cameraPreset: "dimetric" }
    });
    const first = client.render(request("a"));
    const second = client.render(request("b"));
    const third = await client.render(request("c"));
    expect(third).toMatchObject({ ok: false, code: "render-busy" });
    await client.close();
    // 已排队的请求在 close 时被稳定拒绝，不会悬挂。
    const settled = await Promise.all([first, second]);
    for (const result of settled) expect(result.ok).toBe(false);
  }, 15_000);

  it("recovers after a crash when restartOnExit is enabled", async () => {
    // 用一个按行响应后立即退出的脚本模拟崩溃重启：首次请求失败，重启后进程再次可用。
    const script = `
      process.stdin.once("data", () => { process.exit(7); });
      setTimeout(() => process.exit(0), 2000);
    `;
    const client = createRendererClient({
      command: process.execPath,
      args: ["-e", script],
      restartOnExit: true,
      timeoutMs: 1000
    });
    const first = await client.render({
      requestId: "crash",
      sceneVersion: "woohaa-model-scene-ir-v2",
      signature: "s",
      extent: 1,
      ops: [],
      capture: { width: 64, height: 64, background: "transparent", cameraPreset: "dimetric" }
    });
    expect(first.ok).toBe(false);
    // 等待重启后 available 恢复（进程最多活 2s）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.available()).toBe(true);
    await client.close();
  }, 15_000);
});
