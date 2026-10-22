/**
 * `node:sqlite` 受控加载器（change: 2026-10-20-add-local-client-telemetry，design D4）。
 *
 * 本包自带一份、不与其它服务共享工厂，是既有做法：`application-service`、`task-service`、
 * `canvas-service` 各有一份同构实现，仓库没有共享工厂。重复这十行比为了十行新增一个
 * "sqlite 驱动包"更符合当前分层。
 *
 * 为什么不用静态 `import ... from "node:sqlite"`：esbuild 0.21 / Vite 5 的内建模块清单早于
 * `node:sqlite`，静态 import 会被当成裸依赖 `sqlite` 去解析，在构建与测试期直接报
 * "Could not resolve / Failed to load url sqlite"。`process.getBuiltinModule`（Node 22.3+）
 * 按名字取内建模块，不经过打包器解析，运行时、vitest 与 bundle 中行为一致。
 *
 * 类型仍来自 `node:sqlite` 的声明：`import type` 只参与类型，不产生运行时 import。
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
