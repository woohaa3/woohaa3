/**
 * MongoDB 存储槽位实现
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 1.2、4.3 / design D1、D2、D4）。
 *
 * 与 sqlite-storage 同形：只导出声明工厂，实现体复用 runtime-foundation 的共享工厂。
 * 连接串与库名**只**来自扩展目录内的部署侧配置文件 `config.local.json`
 * （部署侧配置惯例：样例 `config.example.json` 入库、真实文件不进仓库）。
 * `MONGODB_URI` / `MONGODB_DB` 已废弃：设置任意一个即启动失败，不再有第二个来源。
 * 声明阶段只计算路径，不读文件、不建立连接。
 */
import { join } from "node:path";
import { storageBootstrap, type RuntimeStorageProvider } from "@woohaa3/extension-runtime-foundation/bootstrap";

export type { RuntimeStorageProvider };

/** 本实现的目录标签：启动失败信息必须能直接定位到目录。 */
const DIRECTORY = "web/extensions/mongo-storage";

/** 缺省配置文件：扩展目录内的 `config.local.json`（部署侧文件，目录内 .gitignore 忽略；样例见同目录 config.example.json）。 */
export const MONGO_STORAGE_CONFIG_FILE = "config.local.json";

export type MongoStorageBootstrapInput = {
  env: Record<string, string | undefined>;
  extensionIds?: readonly string[];
  /** 宿主启动期扫描得到的扩展目录；缺省时不读配置文件（启动期会报缺少配置）。 */
  directory?: string;
};

/** 配置文件位置（纯计算，无 IO；声明阶段可安全调用）。 */
export function resolveMongoStorageConfigPath(input: MongoStorageBootstrapInput): string | undefined {
  const directory = input.directory;
  if (directory === undefined || directory.length === 0) return undefined;
  return join(directory, MONGO_STORAGE_CONFIG_FILE);
}

export function createMongoStorageBootstrap(input: MongoStorageBootstrapInput) {
  return storageBootstrap("mongo", input.env, input.extensionIds ?? [], {
    directory: DIRECTORY,
    mongoConfigFile: resolveMongoStorageConfigPath(input)
  });
}
