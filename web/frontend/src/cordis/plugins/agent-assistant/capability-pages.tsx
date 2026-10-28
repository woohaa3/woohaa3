import type { AgentConnectionView, ServiceConnectionView } from "@woohaa3/contracts";
import { Button } from "../../../shared/ui/index.js";
import type { McpPanelSnapshot } from "./mcp-connection-panel.js";

export type CapabilityPage = "overview" | "agents" | "mcp" | "sources" | "generation-history";

export function CapabilityOverview({ local, sources, loading, sourceLoading, sourceError, mcp, onNavigate, onAdd }: {
  local: AgentConnectionView[]; sources: ServiceConnectionView[]; loading: boolean; sourceLoading: boolean;
  sourceError: string | null; mcp: McpPanelSnapshot | null; onNavigate: (page: CapabilityPage) => void; onAdd: () => void;
}) {
  const localIssues = local.filter(connection => !connection.ready).length;
  const sourceIssues = sources.filter(source => !source.enabled || !source.credentialConfigured || source.removed).length;
  const mcpIssues = mcp ? mcp.issues.length + (mcp.error ? 1 : 0) : 0;
  return <>
    <div className="agent-assistant__page-heading"><h2>能力总览</h2><Button tone="primary" onClick={onAdd}>添加连接</Button></div>
    <div className="agent-assistant__overview-list">
      <div className="agent-assistant__overview-row"><strong>本地 Agent</strong><span className="agent-assistant__state" data-tone={localIssues ? "warning" : "neutral"}>{loading ? "读取中…" : `${local.filter(item => item.ready).length} 个可用`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("agents")}>管理</Button></div>
      <div className="agent-assistant__overview-row"><strong>外部 Agent 接入</strong><span className="agent-assistant__state" data-tone={mcpIssues ? "warning" : "neutral"}>{!mcp || mcp.loading ? "检测中…" : mcp.error ? "检测失败" : `${mcp.configured} 个配置已写入`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("mcp")}>配置</Button></div>
      <div className="agent-assistant__overview-row"><strong>模型提供商</strong><span className="agent-assistant__state" data-tone={sourceIssues || sourceError ? "warning" : "neutral"}>{sourceLoading ? "读取中…" : sourceError ? "读取失败" : `${sources.length} 个提供商`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("sources")}>管理</Button></div>
    </div>
  </>;
}
