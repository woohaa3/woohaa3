/**
 * 统一应用主题 token 公共入口（change: unify-application-theme-tokens）。
 *
 * 这是 Web 与 Bevy 共享的**唯一**色彩 schema source。前端 Theme Service、render scene
 * theme snapshot 和生成/校验工具都从这里取类型与默认值。
 */
export * from "./schema.js";
export * from "./parser.js";
export * from "./contrast.js";
export * from "./generated-default.js";
export * from "./generated-dark.js";
export * from "./builtins.js";
export * from "./fixtures.js";
