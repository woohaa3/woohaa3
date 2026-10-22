/**
 * ChatGPT 插件后端公共入口（原 `@woohaa3/chatgpt-service` 迁移而来）
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 5.x）。
 *
 * 导出组合根与可注入端口/适配器契约。Canvas 权威端口由统一后端注入；本服务不直接写 Y.Doc，
 * 也不把 token 交给下游。
 */
export * from "./config.js";
export * from "./credentials.js";
export * from "./identity.js";
export * from "./oauth.js";
export * from "./authorization.js";
export * from "./models.js";
export * from "./codex-adapter.js";
export * from "./conversion.js";
export * from "./generation.js";
export * from "./handler.js";
export * from "./ports.js";
export * from "./service.js";
export * from "./conversation-adapter.js";
