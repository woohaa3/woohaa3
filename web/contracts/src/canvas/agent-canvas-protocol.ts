/**
 * Agent Canvas 公共协议公共入口
 * （change: add-agent-canvas-authoring-mcp，任务 1.3 / 1.4 / design D3–D9；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R21 —— 拆分为
 *  类型、共享 codec、operation decoder 与 query decoder 子模块）。
 *
 * 外部 Agent 经 MCP 读图、验证并原子建图时使用的**类型化、版本化、无副作用**契约：
 * 语义节点种类、placement、局部前置条件、计划 operation、图投影/增量、canonical 回执与
 * 结构化错误。
 *
 * 关键不变式：
 * - 不暴露 `CanvasCommand`、任意 `nodeData`、Yjs update、资产 bytes 或 provider 请求；
 * - 严格 schema：未知字段在副作用前拒绝；
 * - 本模块只含类型、常量与纯 codec，不含 handler、client 或任何服务实现。
 *
 * 本文件为稳定 barrel；内部直接导入叶子模块。
 */

// 类型与常量。
export * from "./agent-canvas-protocol/types.js";

// 共享 codec 原语。
export * from "./agent-canvas-protocol/common-codec.js";

// operation 严格解码。
export * from "./agent-canvas-protocol/operation-codec.js";

// query / requestId 解码。
export * from "./agent-canvas-protocol/query-codec.js";

import { AGENT_CANVAS_PROTOCOL_VERSION, type AgentCanvasProtocolVersion } from "./agent-canvas-protocol/types.js";

/** 把 protocolVersion 与 supported kinds 暴露给能力响应，避免文档漂移。 */
export function agentProtocolVersion(): AgentCanvasProtocolVersion {
  return AGENT_CANVAS_PROTOCOL_VERSION;
}
