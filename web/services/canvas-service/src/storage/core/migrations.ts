/**
 * 版本化 schema migration runner（任务 7.1 / design D5、D6）。
 *
 * SQLite 与 Mongo 共用同一套顺序迁移语义：
 * - 独立记录 schema version；
 * - 按顺序执行**可重复检测**的迁移，已应用的不重跑；
 * - 迁移前获取适配器级**排他锁**，避免并发启动重复迁移；
 * - 迁移失败即停止，保留可恢复数据；
 * - 数据库版本**高于**应用支持版本时拒绝启动（避免降级写坏数据）。
 *
 * runner 本身不 depend 任何数据库：adapter 提供 `readVersion` / `applyMigration` /
 * `acquireLock` / `releaseLock`。
 */
export type CanvasMigration = {
  /** 迁移完成后的目标版本，必须从 1 连续递增。 */
  version: number;
  description?: string;
  apply: () => Promise<void> | void;
};

export type CanvasMigrationLock = {
  release: () => Promise<void> | void;
};

export type RunCanvasMigrationsOptions = {
  /** 应用支持的 schema 版本（通常为迁移列表最大 version）。 */
  targetVersion: number;
  migrations: readonly CanvasMigration[];
  /** 读取当前已应用的最大版本；空库返回 0。 */
  readVersion: () => Promise<number> | number;
  /** 获取排他锁；无法获取（已被另一实例持有）时应抛错。 */
  acquireLock: () => Promise<CanvasMigrationLock> | CanvasMigrationLock;
  /** 记录一次成功迁移。 */
  recordMigration: (migration: CanvasMigration) => Promise<void> | void;
  /** 稳定错误类型工厂，便于 adapter 复用各自的错误码。 */
  onError: (message: string) => Error;
};

export type CanvasMigrationResult = {
  fromVersion: number;
  toVersion: number;
  applied: number[];
};

/**
 * 执行迁移。
 *
 * 迁移列表必须是 1..targetVersion 的连续集合；非连续会直接报错（配置错误，不是运行时问题）。
 */
export async function runCanvasMigrations(
  options: RunCanvasMigrationsOptions
): Promise<CanvasMigrationResult> {
  assertContiguous(options.migrations, options.targetVersion);

  const current = await options.readVersion();
  if (current > options.targetVersion) {
    throw options.onError(
      `数据库 schema 版本 ${current} 高于应用支持的 ${options.targetVersion}`
    );
  }

  const pending = options.migrations
    .filter((migration) => migration.version > current && migration.version <= options.targetVersion)
    .sort((left, right) => left.version - right.version);

  // 即使没有待迁移项也获取一次锁：并发启动时，锁是「谁在初始化 schema」的唯一仲裁。
  const lock = await options.acquireLock();
  const applied: number[] = [];
  try {
    // 持锁后重新读取：另一实例可能已经迁移完毕。
    const afterLock = await options.readVersion();
    if (afterLock > options.targetVersion) {
      throw options.onError(
        `数据库 schema 版本 ${afterLock} 高于应用支持的 ${options.targetVersion}`
      );
    }
    for (const migration of pending) {
      if (migration.version <= afterLock) continue;
      try {
        await migration.apply();
        await options.recordMigration(migration);
        applied.push(migration.version);
      } catch (error) {
        // 失败即停止：已记录的版本保持为安全边界，重启可从该边界重试。
        throw options.onError(
          `schema 迁移 v${migration.version} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } finally {
    await lock.release();
  }

  const finalVersion = await options.readVersion();
  return { fromVersion: current, toVersion: finalVersion, applied };
}

function assertContiguous(migrations: readonly CanvasMigration[], targetVersion: number): void {
  const versions = [...migrations.map((migration) => migration.version)].sort((a, b) => a - b);
  for (let index = 0; index < targetVersion; index += 1) {
    if (versions[index] !== index + 1) {
      throw new Error(`迁移列表必须从 1 到 ${targetVersion} 连续；缺失 v${index + 1}`);
    }
  }
}

/**
 * 同步版迁移 runner，供 `node:sqlite`（同步 API）在构造函数里使用。
 *
 * 语义与 `runCanvasMigrations` 完全一致（连续校验、排他锁、持锁后重读、失败停止、
 * 版本过新拒绝），只是所有回调都是同步的，因此不引入「构造函数里 await」的问题。
 */
export type RunCanvasMigrationsSyncOptions = {
  targetVersion: number;
  migrations: readonly CanvasMigration[];
  readVersion: () => number;
  acquireLock: () => CanvasMigrationLock;
  recordMigration: (migration: CanvasMigration) => void;
  onError: (message: string) => Error;
};

export function runCanvasMigrationsSync(
  options: RunCanvasMigrationsSyncOptions
): CanvasMigrationResult {
  assertContiguous(options.migrations, options.targetVersion);

  const current = options.readVersion();
  if (current > options.targetVersion) {
    throw options.onError(
      `数据库 schema 版本 ${current} 高于应用支持的 ${options.targetVersion}`
    );
  }

  const lock = options.acquireLock();
  const applied: number[] = [];
  try {
    const afterLock = options.readVersion();
    if (afterLock > options.targetVersion) {
      throw options.onError(
        `数据库 schema 版本 ${afterLock} 高于应用支持的 ${options.targetVersion}`
      );
    }
    const pending = options.migrations
      .filter((migration) => migration.version > afterLock && migration.version <= options.targetVersion)
      .sort((left, right) => left.version - right.version);
    for (const migration of pending) {
      try {
        migration.apply();
        options.recordMigration(migration);
        applied.push(migration.version);
      } catch (error) {
        throw options.onError(
          `schema 迁移 v${migration.version} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } finally {
    lock.release();
  }

  return { fromVersion: current, toVersion: options.readVersion(), applied };
}
