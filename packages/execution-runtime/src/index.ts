/**
 * `woohaa3-executor` 公共入口。
 *
 * 根入口只导出 host/CLI 安全面（协议、客户端、内置执行器）；daemon 是单独的 Node 子路径，
 * 避免消费方 import 根入口时把监听/进程代码带进不该有的运行单元。
 */
export * from "./protocol.js";
export * from "./client.js";
export * from "./endpoints.js";
export * from "./executors.js";
export * from "./roles.js";
