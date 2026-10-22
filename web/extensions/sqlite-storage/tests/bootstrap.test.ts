/**
 * sqlite-storage 槽位声明与配置校验
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 1.1、4.3）。
 */
import type { BootstrapContext } from "@woohaa3/contracts";
import { describe, expect, it } from "vitest";
import { createSqliteStorageBootstrap, type RuntimeStorageProvider } from "../src/bootstrap.js";

/**
 * `provider.create` 的类型要求一个 BootstrapContext；storage 实现不读取其它槽位，
 * 测试传最小假上下文（只验证配置校验与错误码）。
 */
const ctx = {} as BootstrapContext<RuntimeStorageProvider>;

describe("sqlite-storage 槽位声明", () => {
  it("声明工厂只返回声明，不读运行配置、不建立连接", () => {
    const declaration = createSqliteStorageBootstrap({ env: {} });
    expect(declaration.extensionId).toBe("sqlite-storage");
    expect(declaration.providers.map((provider) => provider.slot)).toEqual(["storage"]);
    expect(declaration.providers[0]!.requires).toEqual([]);
  });

  it("缺 sqlite 路径时 create 失败，错误码与扩展目录都在信息里", async () => {
    const declaration = createSqliteStorageBootstrap({ env: { WOOHAA3_APPLICATION_STORE_PATH: "/tmp/unused" } });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toMatchObject({
      code: "STORAGE_CONFIG_INVALID",
      message: expect.stringContaining("web/extensions/sqlite-storage")
    });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toThrow(/WOOHAA3_CANVAS_STORAGE_SQLITE_PATH/);
  });

  it("缺少应用库路径时 create 失败并指出该变量", async () => {
    const declaration = createSqliteStorageBootstrap({ env: { WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: "/tmp/canvas.sqlite" } });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toMatchObject({
      code: "STORAGE_CONFIG_INVALID",
      message: expect.stringContaining("web/extensions/sqlite-storage")
    });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toThrow(/WOOHAA3_APPLICATION_STORE_PATH/);
  });

  it("显式设置 WOOHAA3_CANVAS_STORAGE_BACKEND=mongo 时拒绝启动", async () => {
    const declaration = createSqliteStorageBootstrap({
      env: { WOOHAA3_CANVAS_STORAGE_BACKEND: "mongo", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: "/tmp/canvas.sqlite", WOOHAA3_APPLICATION_STORE_PATH: "/tmp/app" }
    });
    await expect(declaration.providers[0]!.create(ctx)).rejects.toThrow(/不一致/);
  });
});
