/**
 * 组合根默认日志出口：不注入 `logger` 时用内置 sink 落到 `WOOHAA3_LOG_DIR`；注入时完全交给调用方。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendService } from "../src/composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-host-log-"));
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
function bootEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
    WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
    WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
    WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"),
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
    ...extra
  };
}
function todayFile(dir: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return path.join(dir, `backend-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`);
}

describe("组合根默认日志出口", () => {
  it("不注入 logger 时用内置 sink 落到 WOOHAA3_LOG_DIR", async () => {
    const dir = tempDir();
    const logDir = path.join(dir, "logs");
    const service = await createBackendService({
      env: bootEnv(dir, { WOOHAA3_LOG_DIR: logDir, WOOHAA3_LOG_LEVEL: "error" }),
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: false
    });
    try {
      expect(service.logDir).toBe(logDir);
      service.log({ event: "log-probe", level: "error" });
      expect(fs.readFileSync(todayFile(logDir), "utf8")).toContain("log-probe");
    } finally {
      await service.close();
    }
  }, 30_000);

  it("注入 logger 时默认 sink 不介入", async () => {
    const dir = tempDir();
    const events: Array<Record<string, unknown>> = [];
    const service = await createBackendService({
      env: bootEnv(dir),
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: false,
      logger: (event) => { events.push(event); }
    });
    try {
      expect(service.logDir).toBeNull();
      service.log({ event: "injected" });
      expect(events.some((event) => event.event === "injected")).toBe(true);
    } finally {
      await service.close();
    }
  }, 30_000);
});
