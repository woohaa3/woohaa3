/**
 * 挂载路径的 Node 入口（change: 2026-10-15-support-configurable-app-base-path）。
 *
 * 行为来源是 `web/contracts/src/base-path/app-base-path.mjs`（浏览器/TS 与脚本共用同一实现，
 * 不维护第二份规则）。本模块只补充 Node 侧便利函数：从环境解析、日志文案与 HTTP/WS 适配。
 */
import {
  APP_BASE_PATH_ENV,
  addAppBasePath,
  appBasePathPrefix,
  decideAppPathMount,
  isRootAppBasePath,
  isSafeAppRequestPath,
  matchAppBasePath,
  normalizeAppBasePath,
  stripAppBasePath
} from "../../web/contracts/src/base-path/app-base-path.mjs";

export {
  APP_BASE_PATH_ENV,
  addAppBasePath,
  appBasePathPrefix,
  decideAppPathMount,
  isRootAppBasePath,
  isSafeAppRequestPath,
  matchAppBasePath,
  normalizeAppBasePath,
  stripAppBasePath
};

/**
 * 从环境（进程环境优先，已由 `loadServiceEnv` 合并）解析并规范化挂载路径。
 * 非法配置抛出可操作的错误，调用方应在监听端口**之前**调用。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string} 规范后的挂载路径（根为 `/`）
 */
export function resolveAppBasePath(env) {
  const raw = env?.[APP_BASE_PATH_ENV];
  const result = normalizeAppBasePath(raw);
  if (!result.ok) {
    throw new Error(
      `${APP_BASE_PATH_ENV} 配置非法（${result.error}）：${JSON.stringify(raw)}。` +
        "应为以 / 开始的 [A-Za-z0-9_-] 路径段（可多级），或留空表示根路径。"
    );
  }
  return result.basePath;
}

/** 人类可读的完整挂载入口（日志用），例如 `/tools/woohaa/`。 */
export function describeAppBasePath(basePath) {
  return basePath === "/" ? "/（根路径）" : basePath;
}
