/**
 * `node:sqlite` 的受控加载器。
 *
 * 为什么不用静态 `import ... from "node:sqlite"`：
 * - esbuild 0.21 与 Vite 5 的内建模块清单早于 `node:sqlite`，静态 import 会被当成裸依赖
 *   `sqlite` 去解析并在构建/测试时报 "Could not resolve / Failed to load url sqlite"。
 * - `process.getBuiltinModule`（Node 22.3+）按名字取内建模块，不经过打包器解析，
 *   在 Node 运行时、vitest 与 bundle 中行为一致。
 *
 * 类型仍来自 `node:sqlite` 的声明（`typeof import(...)` 只参与类型，不产生运行时 import）。
 */
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type SqliteModule = {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSyncType;
};

let cached: SqliteModule | null = null;

export function loadNodeSqlite(): SqliteModule {
  if (cached) return cached;
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const loaded = typeof getBuiltin === "function"
    ? getBuiltin.call(process, "node:sqlite")
    : undefined;
  if (!loaded) {
    throw new Error("当前 Node 运行时不支持 node:sqlite（需要 Node 22.3+ 或 24+）");
  }
  cached = loaded as SqliteModule;
  return cached;
}
