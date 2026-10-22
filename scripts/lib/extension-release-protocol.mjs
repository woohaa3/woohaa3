/**
 * Extension 发布协议常量与 contracts 加载
 * （change: 2026-10-15-add-scannable-extension-directories，任务 5.2/5.6）。
 *
 * 运行期发布目录（`extension-release-catalog.mjs`）与 release 装配校验
 * （`extension-release.mjs`）共用同一份协议常量，抽到这里避免两个模块互相 import 成环。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** HTML 上发布目录 link 的固定 rel（服务端注入与识别共用）。 */
export const RELEASE_LINK_REL = "woohaa-extension-release";
/** 发布目录前缀（同源绝对路径）。 */
export const RELEASE_PREFIX = "/extension-releases";
/** 不可变 browser artifact 资源前缀。 */
export const ARTIFACTS_PREFIX = "/extensions";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_DIR = path.join(REPO_ROOT, "web");

/**
 * 加载 workspace `@woohaa3/contracts` 的纯 ESM 产物（发布 helper 的唯一来源）。
 * 不能用 `createRequire.resolve`：exports 只声明 import。
 */
export async function loadExtensionContracts() {
  const candidates = [
    path.join(REPO_ROOT, "backend-runtime", "node_modules", "@woohaa3", "contracts", "dist", "index.js"),
    path.join(WEB_DIR, "contracts", "dist", "index.js"),
    path.join(WEB_DIR, "node_modules", "@woohaa3", "contracts", "dist", "index.js")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  const error = new Error("未找到 @woohaa3/contracts 构建产物；先运行 build:contracts");
  error.code = "CONTRACTS_BUILD_MISSING";
  throw error;
}
