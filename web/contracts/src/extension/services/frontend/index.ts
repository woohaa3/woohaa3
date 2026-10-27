/**
 * **前端 Cordis 根**（浏览器 realm）上扩展可见的服务契约。
 *
 * 这些服务由 `web/frontend` 的 Cordis root 提供（`ctx.provide()` + `cordis/context.ts` 的
 * `Context` 增强），扩展经 `@woohaa3/frontend/extension-api` 使用；实现仍在前端包。
 *
 * 这里只收**纯数据/transport 契约**（不 import React、DOM、Node，也不 import 前端实现模块）：
 * 画布目录 / 准备 / 恢复、组运行投影、Agent 会话、导入与任务通知。前端的
 * `cordis/contract/*` 对应文件退化为 re-export，路径对外不变。
 *
 * 仍留在 `web/frontend` 的契约不属于这一层——它们要么是 UI 契约（`platform` 的 slots/dialogs、
 * `model-interaction`、`authoring` 直接带 React 组件类型），要么直接引用前端实现类型
 * （`canvas-runtime` 的 BevyRuntime/InteractionController、`session` 的命令生命周期类、
 * `remote` 的 ApplicationRemote/TaskHistoryReader）。把 React 或前端实现拖进 contracts 会污染
 * 宿主的编译面；这部分按客户端架构归 `@woohaa3/frontend/extension-api`（见 client/AGENTS.md）。
 */
export * from "./agent-conversation.js";
export * from "./canvas-catalog.js";
export * from "./canvas-group-runs.js";
export * from "./canvas-preparation.js";
export * from "./import.js";
export * from "./notification.js";
