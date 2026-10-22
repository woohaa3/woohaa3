/**
 * 单一生产插件宿主集成测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 2.1/2.2）。
 *
 * 验证：统一后端只创建一个宿主；Backend runtime 复用 Application 拥有的宿主实例，
 * 生成 Provider 注册进同一 host（不再出现两套装配链）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendService } from "../src/composition.js";
import type { ApplicationBackendExtensionDefinition, GenerationProvider } from "@woohaa3/contracts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-single-host-"));
  dirs.push(dir);
  return dir;
}
function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) { objects.set(key, { bytes: Uint8Array.from(bytes), contentType }); },
    async get(key: string) { return objects.get(key)!; },
    async exists(key: string) { return objects.has(key); },
    async stat(key: string) { const r = objects.get(key); if (!r) throw new Error("missing"); return { size: r.bytes.byteLength, contentType: r.contentType }; },
    async getHttpsUrl(key: string) { return `https://cos.invalid/${key}?sign=test`; }
  };
}

describe("单一生产插件宿主", () => {
  it("Backend runtime 复用 Application 的宿主实例", async () => {
    const dir = tempDir();
    const service = await createBackendService({
      env: {
        WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
        WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
      },
      logger: () => {},
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: true,
      applicationExtensionMetadata: []
    });
    try {
      const modules = service.modules();
      // runtime 与 application 必须是同一个宿主实例（唯一装配链）。
      expect(modules.runtime.host).toBe(modules.application.host());
    } finally {
      await service.close();
    }
  }, 30_000);

  it("生成 Provider 经唯一宿主注册并进入 Task catalog", async () => {
    const dir = tempDir();
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "single-host-gen",
      activate: (host) => {
        const provider: GenerationProvider = {
          extensionId: "single-host-gen",
          providerId: "singlehost",
          available: true,
          provider: { kind: "fake" },
          models: [{ providerId: "singlehost", providerModelId: "m1", modelType: "language" }]
        };
        host.registerGeneration?.(provider);
      }
    };
    const service = await createBackendService({
      env: {
        WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
        WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
      },
      logger: () => {},
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: false,
      applicationBackendExtensions: [definition],
      applicationExtensionMetadata: [{ extensionId: "single-host-gen", name: "g", description: "d", version: "1.0.0", managementScope: "site", host: "backend", configSchema: { schemaId: "s", schemaVersion: 1 }, dependencies: [], capabilities: [] }]
    });
    try {
      const modules = service.modules();
      // 生成扩展点已登记该 provider（经唯一宿主）。
      expect(modules.runtime.generation.resolve("singlehost")?.extensionId).toBe("single-host-gen");
    } finally {
      await service.close();
    }
  }, 30_000);
});
