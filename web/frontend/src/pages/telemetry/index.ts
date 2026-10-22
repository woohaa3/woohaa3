/**
 * 本机遥测复盘页的公开入口
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2）。
 *
 * 适配插件（`cordis/plugins/telemetry/plugin.tsx`）用 lazy import 从这里取页面组件，
 * 页面模块不反向依赖 Cordis。
 */
export { TelemetryPage, type TelemetryPageProps } from "./telemetry-page.js";
export type { TelemetryQuery } from "./query.js";
export { DEFAULT_TELEMETRY_WINDOW, decodeTelemetrySearch, encodeTelemetrySearch, patchTelemetryQuery } from "./query.js";
export { createTelemetryRemote, telemetryErrorText, type TelemetryRemote } from "./remote.js";
