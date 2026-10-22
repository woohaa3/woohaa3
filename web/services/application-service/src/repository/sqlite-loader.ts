/**
 * `node:sqlite` 受控加载器（change: 2026-10-05-extract-application-plugin-host）。
 *
 * 与 Task/Canvas 同因：静态 `import "node:sqlite"` 会被 esbuild 当成裸依赖解析而失败，
 * 用 `process.getBuiltinModule` 按名取内建模块。
 */
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type SqliteModule = {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSyncType;
};

let cached: SqliteModule | null = null;

export function loadNodeSqlite(): SqliteModule {
  if (cached) return cached;
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const loaded = typeof getBuiltin === "function" ? getBuiltin.call(process, "node:sqlite") : undefined;
  if (!loaded) throw new Error("当前 Node 运行时不支持 node:sqlite（需要 Node 22.3+ 或 24+）");
  cached = loaded as SqliteModule;
  return cached;
}
