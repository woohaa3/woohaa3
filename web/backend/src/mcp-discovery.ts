/**
 * 内置 MCP 发现结果 → 公开契约视图投影
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.2 / design D4）。
 *
 * 从 `composition.ts` 拆出（业务源码规模门禁）：把 mcp-service 的真实 `initialize`/`tools/list`
 * 结果投影为宿主只读/可写视图，供 `GET /api/agent-conversations/mcp` 使用。handler 未启用时返回
 * not-configured；`ready` 仅来自真实发现，不伪造。写工具分类沿用同一 grant 门禁集合。
 */
import type { ModelMcpDiscoveryResult } from "@woohaa3/mcp-service";
import type { McpBuiltinDiscoveryView } from "@woohaa3/contracts";

export function projectMcpDiscovery(discovery: ModelMcpDiscoveryResult | null): McpBuiltinDiscoveryView {
  if (!discovery) {
    return { ready: false, status: "not-configured", tools: [], reason: "内置 MCP 未启用", checkedAt: new Date().toISOString() };
  }
  if (discovery.ready) {
    return { ready: true, status: "ready", serverName: discovery.serverName, tools: discovery.tools, checkedAt: discovery.checkedAt };
  }
  return { ready: false, status: discovery.code, tools: discovery.tools, reason: discovery.reason, checkedAt: discovery.checkedAt };
}
