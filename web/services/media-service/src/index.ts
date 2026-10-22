/**
 * Media Service 公共入口（change: split-web-runtime-services）。
 *
 * 导出组合根、public/internal handler、媒体策略与安全原语。服务实现**不**导出给
 * Canvas/Task 直接 import —— 它们只通过 `contracts` 的协议 client 调用（design D7）。
 */
export * from "./application/ingest.js";
export * from "./application/internal-service.js";
export * from "./api/public-handler.js";
export * from "./api/internal-handler.js";
export * from "./security/guarded-fetch.js";
export * from "./security/address.js";
export * from "./security/identity.js";
export * from "./composition.js";
