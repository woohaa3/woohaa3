/**
 * `@woohaa3/backend` 公共入口
 * （change: 2026-10-06-unify-backend-runtime-with-cordis）。
 *
 * 本机宿主：组合根只启动 Cordis Context，基础 / 核心 / 扩展三层插件组成整个后端。
 */
export * from "./composition.js";
export * from "./host/log-sink.js";
export type * from "./host/context.js";
export { createGenerationRegistry } from "./host/core/generation.js";
export * from "./settings/settings-service.js";
export * from "./runtime/backend-runtime.js";
export * from "./extensions/contract.js";
export * from "./extensions/manifest.js";
export * from "./ports/adapters.js";
export * from "./ports/mcp-adapters.js";

export { createSqliteSiteExtensionConfigStore, createSqliteGenerationModelStore } from "@woohaa3/application-service";
