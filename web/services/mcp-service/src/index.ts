/**
 * `@woohaa3/mcp-service` 公共入口（change: split-model-mcp-into-mcp-service）。
 *
 * MCP 协议与编排运行单元：MCP Streamable HTTP 传输、工具定义与编排逻辑。画布权威仍归
 * Canvas Service；本包只经受认证内部协议访问。
 */
export * from "./composition.js";
export * from "./model-mcp/mcp-http.js";
export * from "./agent-authoring/index.js";
export * from "./downstream/canvas-client.js";
export * from "./downstream/agent-canvas-client.js";
export * from "./downstream/skill-step-client.js";
