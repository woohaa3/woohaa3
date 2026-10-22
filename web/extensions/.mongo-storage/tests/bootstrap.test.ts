/**
 * mongo-storage 槽位声明与配置校验
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 1.2、4.3）。
 *
 * 连接信息**只**来自扩展目录内的 `config.local.json`（部署侧文件）；
 * `MONGODB_URI` / `MONGODB_DB` 已废弃，设置即启动失败。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BootstrapContext } from "@woohaa3/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMongoStorageBootstrap,
  resolveMongoStorageConfigPath,
  type RuntimeStorageProvider
} from "../src/bootstrap.js";

/**
 * `provider.create` 的类型要求一个 BootstrapContext；storage 实现不读取其它槽位，
 * 测试传最小假上下文（只验证配置校验与错误码）。
 */
const ctx = {} as BootstrapContext<RuntimeStorageProvider>;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 用临时扩展目录（与其中的 config.local.json）构造声明，并取出 provider.create。 */
function declarationIn(dir: string, env: Record<string, string | undefined> = {}) {
  return createMongoStorageBootstrap({ env, directory: dir }).providers[0]!;
}

function writeConfig(dir: string, value: unknown): void {
  writeFileSync(path.join(dir, "config.local.json"), typeof value === "string" ? value : JSON.stringify(value));
}

describe("mongo-storage 槽位声明", () => {
  it("声明工厂只返回声明，不读运行配置、不建立连接", () => {
    const declaration = createMongoStorageBootstrap({ env: {} });
    expect(declaration.extensionId).toBe("mongo-storage");
    expect(declaration.providers.map((provider) => provider.slot)).toEqual(["storage"]);
  });

  it("缺配置文件时 create 失败，错误码与扩展目录、文件路径都在信息里", async () => {
    const dir = tempDir("woohaa-mongo-config-");
    const provider = declarationIn(dir, { WOOHAA3_APPLICATION_STORE_PATH: "/tmp/unused" });
    await expect(provider.create(ctx)).rejects.toMatchObject({
      code: "STORAGE_CONFIG_INVALID",
      message: expect.stringContaining("web/extensions/mongo-storage")
    });
    await expect(provider.create(ctx)).rejects.toThrow(/config\.local\.json/);
  });

  it("宿主未给扩展目录时同样失败：不猜目录、不回退环境变量", async () => {
    const declaration = createMongoStorageBootstrap({ env: { WOOHAA3_APPLICATION_STORE_PATH: "/tmp/unused" } });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toThrow(/config\.local\.json/);
  });
});

describe("mongo-storage 部署侧配置文件", () => {
  it("文件提供 uri/database 后配置校验通过（走到下一步说明文件已被读）", async () => {
    const dir = tempDir("woohaa-mongo-config-");
    writeConfig(dir, { uri: "mongodb://config-file.example:27017", database: "woohaa3" });
    // 走到「缺 WOOHAA3_APPLICATION_STORE_PATH」说明连接信息已从文件读到，且此时未尝试连接。
    await expect(declarationIn(dir).create(ctx)).rejects.toThrow(/WOOHAA3_APPLICATION_STORE_PATH/);
  });

  it("设置 MONGODB_URI/MONGODB_DB 直接失败，且不回显值", async () => {
    const dir = tempDir("woohaa-mongo-config-");
    writeConfig(dir, { uri: "mongodb://config-file.example:27017", database: "woohaa3" });
    let error: Error | null = null;
    try {
      await declarationIn(dir, { MONGODB_URI: "mongodb://env.example:27017", WOOHAA3_APPLICATION_STORE_PATH: "/tmp/unused" }).create(ctx);
    } catch (caught) { error = caught as Error; }
    expect(error?.message).toMatch(/MONGODB_URI/);
    expect(error?.message).toMatch(/不再生效/);
    expect(error?.message).not.toMatch(/env\.example/);
  });

  it("未知键、非法 JSON、非对象、空值都指出文件", async () => {
    const dir = tempDir("woohaa-mongo-config-");
    writeConfig(dir, { uri: "mongodb://config-file.example", db: "woohaa3" });
    await expect(declarationIn(dir).create(ctx)).rejects.toThrow(/未知键 db/);
    writeConfig(dir, "{");
    await expect(declarationIn(dir).create(ctx)).rejects.toThrow(/不是合法 JSON/);
    writeConfig(dir, ["mongodb://config-file.example"]);
    await expect(declarationIn(dir).create(ctx)).rejects.toThrow(/必须是 JSON 对象/);
    writeConfig(dir, { uri: "mongodb://config-file.example", database: "  " });
    await expect(declarationIn(dir).create(ctx)).rejects.toThrow(/database 必须是非空字符串/);
  });

  it("配置文件位置只由宿主给的扩展目录决定", () => {
    expect(resolveMongoStorageConfigPath({ env: {} })).toBeUndefined();
    const dir = tempDir("woohaa-mongo-config-");
    expect(resolveMongoStorageConfigPath({ env: {}, directory: dir })).toBe(path.join(dir, "config.local.json"));
  });
});
