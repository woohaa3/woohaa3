/**
 * 扩展服务契约，按**两个 Cordis 根**分开：
 *
 * - [`./host/`](./host/index.ts)：本机宿主进程的 Cordis 根。契约在这里定义，`web/backend`
 *   实现并通过 `ctx` 注入（`ctx.log` / `ctx.generation` / `ctx.storage` / `ctx.webServer` …）。
 * - [`./frontend/`](./frontend/index.ts)：浏览器 Cordis 根。纯数据 / transport 服务契约在
 *   这里定义（画布目录、准备、组运行、Agent 会话、导入、任务通知），
 *   `web/frontend` 实现并经 `ctx` 暴露；UI 契约（slots/dialogs/面板）与直接引用前端实现
 *   类型的契约仍归 `@woohaa3/frontend/extension-api`。
 *
 * 公共子路径 `@woohaa3/contracts/extension/service` 聚合两侧。
 */
export * from "./host/index.js";
export * from "./frontend/index.js";
