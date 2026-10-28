/**
 * 宿主侧契约。扩展怎么被认识、谁能用、装载后能注册什么。
 *
 * 助手会话不在这里。模型服务来源（`service-connection`）是共享身份，和某一次助手回合分开。
 * `semver.ts` 只给扩展依赖版本比较用，由契约根入口以 `isStrictSemver` 导出。
 */

export * from "./codes.js";
export * from "./manifest.js";
export * from "./trusted-manifest.js";
export * from "./config.js";
export * from "./state.js";
export * from "./dto.js";

export * from "./principal.js";
export * from "./access.js";
export * from "./session.js";
export * from "./data-scope.js";
export * from "./secrets.js";
export * from "./store.js";
export * from "./bootstrap.js";

export * from "./runtime.js";
export * from "./http.js";
export * from "./service-connection.js";

export * from "./frontend-runtime.js";
export * from "./frontend-browser.js";
export * from "./app-page.js";

export * from "./canvas-source.js";
export * from "./canvas-upstream.js";
export * from "./archive.js";
