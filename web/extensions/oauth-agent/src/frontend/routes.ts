/**
 * ChatGPT extension 前端业务协议入口
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5）。
 *
 * 浏览器访问 `/api/oauth-agent/*` 的唯一出口是扩展自身 remote adapter；它复用宿主注入的
 * Application Remote 通用传输，绝不自建 fetch/EventSource。公开前缀与路由后缀由本 extension
 * 拥有/复用浏览器安全的公共契约常量（不再放宿主 `services/paths.ts`），与后端保持一致。
 */
export { CHATGPT_ROUTES } from "@woohaa3/contracts";
export type {
  ChatGptAuthSnapshot,
  ChatGptGenerationMode,
  ChatGptGenerationReceipt,
  ChatGptModelsSnapshot
} from "@woohaa3/contracts";

/** 浏览器侧同源业务前缀（与后端 `DEFAULT_CHATGPT_BASE_PATH` 一致）。 */
export const CHATGPT_BASE_PATH = "/api/oauth-agent";
