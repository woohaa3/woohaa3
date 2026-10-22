/**
 * 共享 schema migration runner 测试（任务 7.1）。
 *
 * 覆盖：顺序执行、重复运行（已应用不重跑）、并发启动（排他锁）、迁移失败停止、
 * 数据库版本过新拒绝、迁移列表非连续报错。
 */
import { describe, expect, it } from "vitest";
import { runCanvasMigrations,
  runCanvasMigrationsSync,
  type CanvasMigration,
  type CanvasMigrationLock } from "./index.js";

function migrations(): CanvasMigration[] {
  return [
    { version: 1, apply: () => undefined },
    { version: 2, apply: () => undefined },
    { version: 3, apply: () => undefined }
  ];
}

/** 一个可观察的内存 schema：version 只是数字，迁移是副作用函数。 */
function memorySchema(onApply?: (version: number) => void) {
  let version = 0;
  const applied: number[] = [];
  let locked = false;
  return {
    get version() {
      return version;
    },
    applied,
    get locked() {
      return locked;
    },
    options: (list: CanvasMigration[]) => ({
      targetVersion: 3,
      migrations: list,
      readVersion: () => version,
      acquireLock: (): CanvasMigrationLock => {
        if (locked) throw new Error("lock busy");
        locked = true;
        return { release: () => { locked = false; } };
      },
      recordMigration: (migration: CanvasMigration) => {
        applied.push(migration.version);
        version = migration.version;
        onApply?.(migration.version);
      },
      onError: (message: string) => new Error(message)
    })
  };
}

describe("runCanvasMigrations（任务 7.1）", () => {
  it("按顺序执行全部待迁移项", async () => {
    const schema = memorySchema();
    const result = await runCanvasMigrations(schema.options(migrations()));
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(3);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(schema.applied).toEqual([1, 2, 3]);
  });

  it("重复运行不重跑已应用的迁移", async () => {
    const schema = memorySchema();
    await runCanvasMigrations(schema.options(migrations()));
    const second = await runCanvasMigrations(schema.options(migrations()));
    expect(second.applied).toEqual([]);
    expect(schema.applied).toEqual([1, 2, 3]);
  });

  it("并发启动时排他锁冲突会失败，不重复迁移", async () => {
    const schema = memorySchema();
    // 第一个实例持锁（模拟仍在迁移中）。
    const lock = schema.options([]).acquireLock();
    expect(schema.locked).toBe(true);
    await expect(runCanvasMigrations(schema.options(migrations()))).rejects.toThrow("lock busy");
    lock.release();
    expect(schema.locked).toBe(false);
    expect(schema.applied).toEqual([]);
  });

  it("迁移失败即停止，保留安全边界", async () => {
    const schema = memorySchema();
    const list = migrations();
    list[1] = { version: 2, apply: () => { throw new Error("boom"); } };
    await expect(runCanvasMigrations(schema.options(list))).rejects.toThrow(/v2 失败/);
    // v1 已记录，v2/v3 未记录。
    expect(schema.applied).toEqual([1]);
    expect(schema.version).toBe(1);
  });

  it("数据库版本过新拒绝启动", async () => {
    const schema = memorySchema();
    await runCanvasMigrations(schema.options(migrations()));
    // 手动把支持版本降到 2。
    const tooNew = { ...schema.options(migrations()), targetVersion: 2 };
    await expect(runCanvasMigrations(tooNew)).rejects.toThrow(/高于应用支持/);
  });

  it("非连续迁移列表直接报错", async () => {
    const schema = memorySchema();
    const list: CanvasMigration[] = [{ version: 1, apply: () => undefined }, { version: 3, apply: () => undefined }];
    await expect(runCanvasMigrations(schema.options(list))).rejects.toThrow(/连续/);
  });
});

describe("runCanvasMigrationsSync（任务 7.1）", () => {
  it("与异步版语义一致（供 node:sqlite 同步 API 使用）", () => {
    const schema = memorySchema();
    const result = runCanvasMigrationsSync(schema.options(migrations()));
    expect(result.applied).toEqual([1, 2, 3]);
    expect(runCanvasMigrationsSync(schema.options(migrations())).applied).toEqual([]);
  });

  it("版本过新拒绝启动", () => {
    const schema = memorySchema();
    runCanvasMigrationsSync(schema.options(migrations()));
    expect(() => runCanvasMigrationsSync({ ...schema.options(migrations()), targetVersion: 1 }))
      .toThrow(/高于应用支持/);
  });
});
