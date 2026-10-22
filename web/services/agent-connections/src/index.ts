/**
 * Agent 连接共享内核入口
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections）。
 *
 * 供 `local-agent` 与 `sdk-agent` 两个扩展共用：owner-scoped 连接元数据、凭据生命周期、
 * 公开视图投影、endpoint 策略、有界 HTTP 客户端与诊断脱敏。**不含任何厂商 SDK 或具体适配器**，
 * 也**不含秘密**：凭据明文只经宿主 `ApplicationExtensionSecretStore` 读写。
 */
export * from "./metadata.js";
export * from "./service.js";
export * from "./connection-view.js";
export * from "./connection-provider.js";
export * from "./endpoint-policy.js";
export * from "./http-client.js";
export * from "./redact.js";
export * from "./adapter-support.js";
export * from "./native-context.js";
export * from "./model-transport.js";
export * from "./target-tools.js";
export * from "./target-prompt.js";
export * from "./candidate-generation.js";
