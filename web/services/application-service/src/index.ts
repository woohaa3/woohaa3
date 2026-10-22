/**
 * `@woohaa3/application-service` 公共入口
 * （change: 2026-10-05-extract-application-plugin-host）。
 *
 * 导出 Application 组合根、站点插件控制面/宿主契约、API handler 与认证适配器。
 * 领域服务只通过 `contracts` 协议调用，不 import 本目录实现（design D1/D7）。
 */
export * from "./config/env.js";
export * from "./auth/adapter.js";
export * from "./extensions/manifest.js";
export * from "./extensions/host.js";
export * from "./extensions/access-enforcement.js";
export * from "./extensions/provider-registry.js";
export * from "./extensions/bootstrap.js";
export * from "./extensions/work.js";
export * from "./extensions/config-store.js";
export * from "./extensions/generation-model-store.js";
export * from "./extensions/generation-model-index.js";
export * from "./extensions/control-plane.js";
export * from "./extensions/canvas-source-registry.js";
export * from "./extensions/task-recovery.js";
export * from "./repository/sqlite-loader.js";
export * from "./repository/extension-work-repository.js";
export * from "./repository/extension-task-intent-repository.js";
export * from "./repository/agent-conversation-repository.js";
export * from "./extensions/agent-adapter-registry.js";
export * from "./extensions/agent-connection-registry.js";
export * from "./extensions/agent-conversation-projection.js";
export * from "./extensions/agent-conversation-service.js";
export * from "./repository/extension-document-store.js";
export * from "./repository/mongo-extension-document-store.js";
export * from "./clients/domain-clients.js";
export * from "./secrets/index.js";
export * from "./api/extension-api.js";
export * from "./api/agent-conversation-api.js";
export * from "./composition.js";
export * from "./repository/instance-data-scope.js";
