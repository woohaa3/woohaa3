/**
 * 当前浏览器构建的自述（遥测 / diagnostics 上报的 `frontendVersion` 来源）。
 *
 * 背景：这条字段此前一直是空的——管理端有 `WOOHAA_ADMIN_BUILD_*`（`admin/scripts/deploy.sh`
 * 把服务端与前端同源的三项一起传下去），而浏览器前端这份产物没有配套部署脚本，仓库里也就
 * 没有"生产可用的前端构建版本"。构建期由
 * vite 的 `define` 注入（见 `vite.config.ts` 的 `resolveFrontendBuild`），运行时只读，
 * 不现场编造。
 *
 * 为什么上报值优先提交号：
 * - 管理端遥测页把上报值和服务端 `GetServerInfo.commit` 直接做字符串比较；
 *   `git describe` 串（例如 `v1.2.3-4-gabc1234`）与提交号永不相等，会制造假的"版本不一致"；
 * - 短提交号与服务端 `make build` 的 `COMMIT` 同格式，干净构建能真正对上。
 *
 * 未注入（vitest、别的工具直接加载源码）时返回空串：宁可不报，也不编一个像真的版本。
 */
declare const __WOOHAA_FRONTEND_BUILD_VERSION__: string;
declare const __WOOHAA_FRONTEND_BUILD_COMMIT__: string;

/** 与服务端 `cleanVersion` / 契约的版本形状一致：≤64 的 `[0-9A-Za-z.+_-]`，首字符字母数字。 */
const BUILD_IDENTITY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** 只保留合法形状：注入值异常（含空串）一律当作"没有"，避免把噪声送进上报链路。 */
function normalizeBuildIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return BUILD_IDENTITY_PATTERN.test(trimmed) ? trimmed : "";
}

/**
 * 上报/展示用的构建标识：优先短提交号（可与服务端 `commit` 对照），否则退回版本串。
 *
 * `typeof` 守卫是必需的：`define` 只在 vite 打包/调试时做文本替换，单测里这两个名字并不存在，
 * 裸引用会让模块求值直接抛 `ReferenceError`。
 */
export function appBuildVersion(): string {
  const commit = normalizeBuildIdentity(
    typeof __WOOHAA_FRONTEND_BUILD_COMMIT__ === "undefined" ? "" : __WOOHAA_FRONTEND_BUILD_COMMIT__
  );
  if (commit !== "") return commit;
  return normalizeBuildIdentity(
    typeof __WOOHAA_FRONTEND_BUILD_VERSION__ === "undefined" ? "" : __WOOHAA_FRONTEND_BUILD_VERSION__
  );
}
