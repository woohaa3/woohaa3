/**
 * Agent Canvas authoring MCP 工具面公共入口
 * （change: add-agent-canvas-authoring-mcp，任务 5.1–5.5 / design D2–D10；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R05 —— 拆分为
 *  policy/schemas/execution/graph/plan/run 子模块，本文件保留 register 入口）。
 *
 * 对外暴露**语义**工具（不暴露 CanvasCommand/nodeData）。简单写工具
 * （create/connect/set_prompt/delete）内部构造单 operation plan，与 `apply_canvas_plan`
 * 共用同一个 validate/normalize/compile pipeline 与同一幂等回执语义（design D2）。
 *
 * 所有工具声明严格 input schema、output schema 与 MCP annotations，成功/失败都返回
 * `structuredContent`；文本 content 只作为人类可读摘要（design D6）。
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAgentGraphTools } from "./graph-tools.js";
import { registerAgentPlanTools } from "./plan-tools.js";
import { registerAgentRunTools } from "./run-tools.js";
import { registerAgentScriptTools } from "./script-tools.js";
import { registerAgentSkillTools } from "./skill-tools.js";
import { registerAssistantWorldTools } from "./world-tools.js";
import type { AgentAuthoringToolDeps } from "./tool-policy.js";

export type { AgentAuthoringToolDeps } from "./tool-policy.js";
export type { AgentAuditEvent } from "./tool-policy.js";
export { runToolPlan } from "./execution.js";
export { AGENT_CANVAS_GUIDE } from "./graph-tools.js";

export function registerAgentAuthoringTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  registerAgentScriptTools(server, deps);
  registerAgentGraphTools(server, deps);
  // Canvas Script 可用时不注册 JSON plan 入口（画布结构写入统一走脚本）；
  // 脚本能力面未接入时保留既有的 validate/apply plan 回退。
  if (!deps.scriptAvailability?.available) registerAgentPlanTools(server, deps);
  registerAgentRunTools(server, deps);
  registerAgentSkillTools(server, deps);
  if (deps.world) registerAssistantWorldTools(server, deps);
}
