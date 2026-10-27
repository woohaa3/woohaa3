/**
 * `@woohaa3/contracts/extension/service` 公共子路径。
 *
 * 服务契约按**两个 Cordis 根**分类，逐项定义在 `./services/`：
 *
 * - `./services/host/`：本机宿主进程根（`ctx.log` / `ctx.generation` / `ctx.storage` …），
 *   契约在这里定义，`web/backend` 实现并注入；
 * - `./services/frontend/`：浏览器根（`ctx.canvasCatalog` / `ctx.agentConversationService` …），
 *   纯数据/transport 契约在这里定义，`web/frontend` 实现并经 `ctx` 暴露。UI 契约与直接引用
 *   前端实现类型的契约仍归 `@woohaa3/frontend/extension-api`（见 `./services/frontend/index.js`）。
 *
 * 这里只做子路径聚合与汇总导出，名字与导出面保持不变。
 *
 * 方向约定：**契约定义 → 实现**。服务模块不 import 各自的实现包，也不互相 import 装配面。
 */
export * from "./services/index.js";
