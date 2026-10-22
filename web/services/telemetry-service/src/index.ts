/**
 * `@woohaa3/telemetry-service` 的公开入口（change: 2026-10-20-add-local-client-telemetry）。
 *
 * 本包拥有遥测的**事实**：事件归一、SQLite 落库与保留清理、查询/聚合/异常规则、`/api/telemetry/*`
 * 读面；出口（`TelemetryExport`）只负责搬运，由站点扩展注册，缺省关闭。分层理由见 design.md D2。
 *
 * 宿主按这两个入口装配即可：
 * ```ts
 * const telemetry = createTelemetryService({ path, settings, logger, now });
 * ctx.provide("telemetry", telemetry);
 * // 路由：handleTelemetryRequest 未命中返回 false，交给宿主自己的链继续
 * const handled = await handleTelemetryRequest(telemetry, req, res);
 * ```
 * 文件路径、设置读取、鉴权都在宿主侧：本包不知道 `.woohaa3` 在哪，也不判断调用者是谁。
 */
export type { TelemetrySettings } from "./settings.js";
export { createTelemetryService } from "./service.js";
export { handleTelemetryRequest } from "./api/telemetry-api.js";
