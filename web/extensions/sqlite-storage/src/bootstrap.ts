/**
 * SQLite 存储槽位实现
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 1.1、4.3 / design D1、D2、D4）。
 *
 * 本模块只导出**声明工厂**：宿主在启动期扫描到 `extension.json` 的 `bootstrap` 声明后调用它，
 * 取得 `{ extensionId, providers }` 声明；`import` 与「取声明」都不建立连接、也不读运行配置。
 * 必需配置（sqlite 库路径）在 `provider.create` 里校验，错误信息带上本扩展目录。
 */
import { storageBootstrap, type RuntimeStorageProvider } from "@woohaa3/extension-runtime-foundation/bootstrap";

export type { RuntimeStorageProvider };

/** 本实现的目录标签：启动失败信息必须能直接定位到目录。 */
const DIRECTORY = "web/extensions/sqlite-storage";

export function createSqliteStorageBootstrap(input: { env: Record<string, string | undefined>; extensionIds?: readonly string[]; options?: { managedMigrations?: readonly import("@woohaa3/contracts").ManagedNodeMigrationAdapter[] } }) {
  return storageBootstrap("sqlite", input.env, input.extensionIds ?? [], { directory: DIRECTORY, managedMigrations: input.options?.managedMigrations });
}
