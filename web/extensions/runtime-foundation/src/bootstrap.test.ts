import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { bootstrapProviders } from "@woohaa3/application-service";
import { readMongoStorageConfig, storageBootstrap } from "./bootstrap.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("只有 Storage 也能装配，目录覆盖多页且不创建身份和策略", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-storage-provider-")); dirs.push(dir);
  const env = { WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"), WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite") };
  const runtime = await bootstrapProviders([storageBootstrap("sqlite", env, [])]);
  try {
    expect(runtime.accessControl).toBe(false);
    expect(runtime.providers.identity).toBeUndefined();
    expect(runtime.providers.access).toBeUndefined();
    const storage = runtime.providers.storage;
    for (let i = 0; i < 103; i++) await storage.canvas.repository.createCanvas(createEmptyWoohaa3ServerCanvas(`canvas-${i}`, "2026-10-14T00:00:00Z"));
    expect((await storage.canvas.repository.listCanvases({ limit: 100 })).total).toBe(103);
    expect((await storage.canvas.repository.listCanvases({ offset: 100, limit: 100 })).items).toHaveLength(3);
  } finally { await runtime.close(); }
});

it("mongo 连接信息只从 config.local.json 读：缺文件/坏键就报文件，环境变量设置了直接失败", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-storage-config-file-")); dirs.push(dir);
  const file = path.join(dir, "config.local.json");
  const directory = "web/extensions/mongo-storage";
  const read = (env: Record<string, string | undefined> = {}) => readMongoStorageConfig({ path: file, directory, env });

  // 缺文件：报出期望路径与样例位置。
  let missing: Error | null = null;
  try { read(); } catch (error) { missing = error as Error; }
  expect(missing?.message).toMatch(/config\.local\.json/);
  expect(missing?.message).toMatch(/config\.example\.json/);

  writeFileSync(file, JSON.stringify({ uri: "mongodb://file", database: "woohaa3" }));
  expect(read()).toEqual({ uri: "mongodb://file", database: "woohaa3" });

  // 已废弃的环境变量：设置即失败，且不回显值。
  let legacy: Error | null = null;
  try { read({ MONGODB_URI: "mongodb://env" }); } catch (error) { legacy = error as Error; }
  expect(legacy?.message).toMatch(/MONGODB_URI/);
  expect(legacy?.message).toMatch(/不再生效/);
  expect(legacy?.message).not.toMatch(/mongodb:\/\/env/);

  writeFileSync(file, JSON.stringify({ uri: "mongodb://file", db: "woohaa3" }));
  expect(() => read()).toThrowError(/未知键 db/);
  writeFileSync(file, "{");
  expect(() => read()).toThrowError(/不是合法 JSON/);
  writeFileSync(file, JSON.stringify({ uri: "mongodb://file" }));
  expect(() => read()).toThrowError(/database 必须是非空字符串/);
  writeFileSync(file, JSON.stringify({ uri: "", database: "woohaa3" }));
  expect(() => read()).toThrowError(/uri 必须是非空字符串/);
});
