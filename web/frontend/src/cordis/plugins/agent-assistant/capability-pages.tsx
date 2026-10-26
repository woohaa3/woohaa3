import type { AgentConnectionView, AgentConnectionStatusEvidence, ServiceConnectionView } from "@woohaa3/contracts";
import { Button, SettingsFeedback } from "../../../shared/ui/index.js";
import { RefreshIcon, WarningIcon } from "../../../shared/ui/icons.js";
import type { McpPanelSnapshot } from "./mcp-connection-panel.js";
import { serviceSourceState } from "./service-directory.js";

export type CapabilityPage = "overview" | "agents" | "mcp" | "sources" | "generation-history" | "diagnostics";

export function CapabilityOverview({ local, sources, loading, sourceLoading, sourceError, mcp, onNavigate, onAdd }: {
  local: AgentConnectionView[]; sources: ServiceConnectionView[]; loading: boolean; sourceLoading: boolean;
  sourceError: string | null; mcp: McpPanelSnapshot | null; onNavigate: (page: CapabilityPage) => void; onAdd: () => void;
}) {
  const localIssues = local.filter(connection => !connection.ready).length;
  const sourceIssues = sources.filter(source => !source.enabled || !source.credentialConfigured || source.removed).length;
  const mcpIssues = mcp ? mcp.issues.length + (mcp.error ? 1 : 0) : 0;
  const issueCount = localIssues + sourceIssues + mcpIssues + (sourceError ? 1 : 0);
  return <>
    <div className="agent-assistant__page-heading"><h2>能力总览</h2><Button tone="primary" onClick={onAdd}>添加连接</Button></div>
    <div className="agent-assistant__overview-list">
      <div className="agent-assistant__overview-row"><strong>本地 Agent</strong><span className="agent-assistant__state" data-tone={localIssues ? "warning" : "neutral"}>{loading ? "读取中…" : `${local.filter(item => item.ready).length} 个可用`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("agents")}>管理</Button></div>
      <div className="agent-assistant__overview-row"><strong>外部 Agent 接入</strong><span className="agent-assistant__state" data-tone={mcpIssues ? "warning" : "neutral"}>{!mcp || mcp.loading ? "检测中…" : mcp.error ? "检测失败" : `${mcp.configured} 个配置已写入`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("mcp")}>配置</Button></div>
      <div className="agent-assistant__overview-row"><strong>模型提供商</strong><span className="agent-assistant__state" data-tone={sourceIssues || sourceError ? "warning" : "neutral"}>{sourceLoading ? "读取中…" : sourceError ? "读取失败" : `${sources.length} 个提供商`}</span><Button size="sm" tone="ghost" onClick={() => onNavigate("sources")}>管理</Button></div>
    </div>
    {issueCount ? <div className="agent-assistant__attention"><WarningIcon size={16} /><strong>{issueCount} 项待处理</strong><span>连接、凭据或客户端配置</span><Button size="sm" tone="ghost" onClick={() => onNavigate("diagnostics")}>查看</Button></div> : null}
  </>;
}

const stateNames = { unknown: "待验证", ready: "检查通过", unavailable: "不可用", failed: "检查失败", pending: "检查中", unsupported: "不支持" };
function Evidence({ value }: { value?: AgentConnectionStatusEvidence }) {
  if (!value) return <span className="agent-assistant__muted">—</span>;
  return <span className="agent-assistant__evidence" data-state={value.state} title={value.reason}>{stateNames[value.state]}</span>;
}

export function CapabilityDiagnostics({ connections, sources, mcp, loading, onRefresh, error }: {
  connections: AgentConnectionView[]; sources: ServiceConnectionView[];
  mcp: McpPanelSnapshot | null; loading: boolean; onRefresh: () => void; error?: string | null;
}) {
  return <>
    <div className="agent-assistant__page-heading"><h2>连接诊断</h2><Button size="sm" icon={<RefreshIcon size={14} />} disabled={loading} onClick={onRefresh}>刷新状态</Button></div>
    {error ? <SettingsFeedback tone="danger">{error} <Button onClick={onRefresh}>重试</Button></SettingsFeedback> : null}
    <div className="agent-assistant__section-heading"><h3>连接状态</h3><span>保存配置不代表上游检查通过</span></div>
    {connections.length ? <div className="agent-assistant__table-wrap"><table><thead><tr><th>助手</th><th>连接</th><th>认证</th><th>模型访问</th><th>工具访问</th><th>运行时</th></tr></thead><tbody>{connections.map(connection => <tr key={connection.connectionId}><td><strong>{connection.name}</strong>{connection.reason ? <small>{connection.reason}</small> : null}</td><td><Evidence value={connection.status.transport} /></td><td><Evidence value={connection.status.credential} /></td><td><Evidence value={connection.status.modelAccess} /></td><td><Evidence value={connection.status.tools} /></td><td><Evidence value={connection.runtime?.dependency} /></td></tr>)}</tbody></table></div> : <p className="agent-assistant__empty-note">{loading ? "正在读取连接…" : "暂无助手连接状态。"}</p>}
    {sources.length ? <><div className="agent-assistant__section-heading"><h3>模型提供商</h3></div><div className="agent-assistant__overview-list">{sources.map(source => <div className="agent-assistant__diagnostic-row" key={source.serviceConnectionId}><strong>{source.name}</strong><span className="agent-assistant__state" data-tone={serviceSourceState(source).tone}>{serviceSourceState(source).label}</span><span>{source.bindings.length} 个绑定</span></div>)}</div></> : null}
    <div className="agent-assistant__section-heading"><h3>MCP 配置状态</h3><span>配置写入与客户端连接分别确认</span></div>
    {mcp?.error ? <SettingsFeedback tone="danger">{mcp.error}</SettingsFeedback> : null}
    {mcp?.issues.map(issue => <SettingsFeedback key={issue.key} tone="danger">{issue.label}：{issue.message}</SettingsFeedback>)}
    {!mcp?.issues.length && !mcp?.error ? <p className="agent-assistant__empty-note">{!mcp || mcp.loading ? "正在检测客户端…" : `${mcp.configured} 个配置已写入；客户端连接状态请在对应客户端确认。`}</p> : null}

  </>;
}
