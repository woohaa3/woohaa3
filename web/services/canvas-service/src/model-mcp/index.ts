/**
 * Canvas Service 模型 MCP 模块入口（change: integrate-origin-master-after-web-split；
 *  change: split-model-mcp-into-mcp-service）。
 *
 * 权威脚本提交（service）、浏览器/旧客户端 HTTP 面（handler）与**受认证内部协议面**
 * （internal-api）。MCP 传输与工具定义迁到独立 `mcp-service` 运行单元。
 */
export * from "./service.js";
export * from "./handler.js";
export * from "./internal-api.js";
