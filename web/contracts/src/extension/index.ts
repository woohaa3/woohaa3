/**
 * 应用插件共享契约入口（change: 2026-10-04-add-backend-plugin-extensions，任务 1.1）。
 *
 * 只包含纯 DTO、runtime schema、稳定错误码与无副作用 codec：不含宿主实现、Provider SDK、
 * React 或秘密配置。前端与后端各自在运行边界内使用同一稳定 identity。
 */
export * from "./codes.js";
export * from "./manifest.js";
export * from "./config.js";
export * from "./state.js";
export * from "./dto.js";
export * from "./trusted-manifest.js";
export * from "./principal.js";
export * from "./app-page.js";
export * from "./access.js";
export * from "./bootstrap.js";
export * from "./store.js";
export * from "./http.js";
export * from "./secrets.js";
export * from "./authoring.js";
export * from "./conversation.js";
export * from "./conversation-mcp.js";
export * from "./conversation-codec.js";
export * from "./canvas-creation.js";
export * from "./agent-connection.js";
export * from "./agent-connection-codec.js";
export * from "./services.js";
export * from "./runtime.js";
export * from "./owned-canvases.js";
export * from "./frontend-runtime.js";
export * from "./frontend-browser.js";
export * from "./archive.js";
export * from "./data-scope.js";
export * from "./session.js";
export * from "./assistant-execution.js";
export * from "./service-connection.js";
