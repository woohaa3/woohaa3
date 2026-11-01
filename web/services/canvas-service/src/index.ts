/**
 * `@woohaa3/canvas-service` 公共入口（change: split-web-runtime-services）。
 *
 * 画布权威：domain/commands（经 `@woohaa3/contracts`）、存储组合、Yjs 服务端运行时、
 * run/cancel 与 projector、Media/Task client。
 */
export * from "./api/canvas-api.js";
export * from "./api/task-activity-api.js";
export * from "./sync/index.js";
export * from "./storage/composition.js";
export * from "./storage/core/index.js";
export * from "./storage/sqlite/index.js";
export { migrateSqliteCanvasBeforeStartup } from "./storage/migrations/startup.js";
export * from "./storage/mongo/index.js";
export * from "./task/input-resolution.js";
export * from "./task/run-service.js";
export * from "./task/result-consumer.js";
export * from "./clients/task-client.js";
export * from "./clients/media-client.js";
export * from "./clients/media-verifier.js";
export * from "./model-mcp/index.js";
export * from "./agent-authoring/index.js";
export * from "./composition.js";
export * from "./import/contracts.js";

export * from "./storage/provider.js";
export { SqliteNodeHistoryRepository } from "./storage/sqlite/node-history.js";
export { SqliteEditCompletionRepository } from "./storage/sqlite/edit-completion.js";
export { SqliteSnippetRepository } from "./storage/sqlite/snippets.js";
export * from "./task/assistant-text.js";
export { SqliteScenePackageStore } from "./storage/sqlite/scene-package.js";
