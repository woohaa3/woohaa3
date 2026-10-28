/** 统一后端进程的进程内类型化契约入口（change: 2026-10-06-unify-backend-runtime-with-cordis）。 */
export * from "./ports.js";
export * from "./marketplace.js";
export * from "./generation-models-dto.js";
export * from "./providers-dto.js";
export * from "./chatgpt-dto.js";
// 插件形状与宿主服务面在 `extension/plugin.js` / `extension/service.js`（由 extension 入口汇总导出）；
// 生成 / 存储 / 遥测 / 市场这些**服务**的契约与贡献形状也在 `extension/services/`，这里只留后端安装面 DTO。
export type { CanvasAuthority, CanvasAuthorityResult } from "./canvas-authority.js";
