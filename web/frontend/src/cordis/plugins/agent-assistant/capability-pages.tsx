import { useState } from "react";
import type { AgentConnectionView, ServiceConnectionView } from "@woohaa3/contracts";
import { Button, SettingsFeedback, Tooltip } from "@woohaa3/ui";
import { AgentIcon, BackIcon, BoxIcon, ChevronRightIcon, CloudIcon, ImageIcon, LinkIcon, MusicIcon, VideoIcon } from "@woohaa3/ui/icons";
import type { McpPanelSnapshot } from "./mcp-connection-panel.js";
import { capabilitySuppliers, type ActiveCapability, type CapabilityKind, type CapabilitySupplier } from "./capability-directory.js";

export type CapabilityPage = "overview" | "agents" | "mcp" | "sources" | "generation-history";
const capabilities = [
  { id: "agent", label: "Agent", description: "对话、理解与创作协作", icon: AgentIcon },
  { id: "image", label: "图片", description: "图像生成与编辑", icon: ImageIcon },
  { id: "video", label: "视频", description: "视频生成", icon: VideoIcon },
  { id: "audio", label: "音频", description: "语音与音频生成", icon: MusicIcon },
  { id: "model3d", label: "3D", description: "3D 内容生成", icon: BoxIcon },
  { id: "hosting", label: "图床", description: "图片托管与外链", icon: CloudIcon },
] as const;

export function CapabilityOverview({ local, remote, sources, loading, connectionError, sourceLoading, sourceError, mcp, contextual, onNavigate, onAdd, onOpenSource, onUse, onRetry }: {
  local: AgentConnectionView[]; remote: AgentConnectionView[]; sources: ServiceConnectionView[]; loading: boolean; connectionError: string | null; sourceLoading: boolean;
  sourceError: string | null; mcp: McpPanelSnapshot | null; contextual: boolean; onNavigate: (page: CapabilityPage) => void;
  onAdd: (capability?: ActiveCapability) => void; onOpenSource: (id: string) => void; onUse: (connectionId: string) => void; onRetry: () => void;
}) {
  const [selected, select] = useState<CapabilityKind | null>(null);
  const capability = capabilities.find(item => item.id === selected);
  const placeholder = selected === "model3d" || selected === "hosting";
  const suppliers = (kind: ActiveCapability) => capabilitySuppliers(kind, local, sources, remote);
  const pending = (kind: CapabilityKind) => sourceLoading || kind === "agent" && loading;
  const failed = (kind: CapabilityKind) => sourceError || kind === "agent" && connectionError;
  const open = (supplier: CapabilitySupplier) => supplier.local ? onNavigate("agents") : onOpenSource(supplier.sourceId ?? supplier.connectionId!);
  const counts = (kind: ActiveCapability, rows: CapabilitySupplier[]) => kind === "agent"
    ? { local: rows.filter(row => row.local && row.configured).length, suppliers: rows.filter(row => !row.local && row.configured).length }
    : { local: 0, suppliers: rows.filter(row => row.configured).length };
  const status = (kind: ActiveCapability, rows: CapabilitySupplier[]) => {
    if (pending(kind)) return "读取中…";
    if (failed(kind)) return "读取失败";
    const value = counts(kind, rows);
    return kind === "agent" ? `已配置 ${value.local} 个本地 Agent · 已配置 ${value.suppliers} 个供应商` : `已配置 ${value.suppliers} 个供应商`;
  };

  if (capability) {
    const rows = placeholder ? [] : suppliers(capability.id as ActiveCapability);
    return <div data-capability-detail={capability.id}>
      <nav className="agent-assistant__capability-breadcrumb"><Button size="sm" tone="ghost" icon={<BackIcon size={14} />} onClick={() => select(null)}>能力总览</Button><span>/</span><span>{capability.label}</span></nav>
      <div className="agent-assistant__page-heading"><h2>{capability.label}</h2>{!placeholder ? <Button tone="primary" onClick={() => onAdd(capability.id as ActiveCapability)}>添加供应商</Button> : null}</div>
      {placeholder ? <div className="agent-assistant__capability-placeholder"><capability.icon size={36} /><h3>暂未接入</h3><p>{capability.label === "3D" ? "这里将集中展示提供 3D 生成能力的供应商。" : "这里将集中展示提供图片托管与外链能力的供应商。"}</p></div> : <>
        <p className="agent-assistant__capability-summary">{capability.description} · {status(capability.id as ActiveCapability, rows)}</p>
        {failed(capability.id) ? <SettingsFeedback tone="danger">{failed(capability.id)} <Button size="sm" onClick={onRetry}>重试</Button></SettingsFeedback> : null}
        {!pending(capability.id) && !failed(capability.id) && !rows.length ? <div className="agent-assistant__empty-note">尚未配置{capability.label}能力的供应商。{capability.id === "agent" ? <Button size="sm" tone="ghost" onClick={() => onNavigate("agents")}>配置本地 Agent</Button> : null}</div> : null}
        {(capability.id === "agent" ? [true, false] : [false]).map(isLocal => {
          const group = rows.filter(row => row.local === isLocal);
          if (!group.length) return null;
          return <section key={String(isLocal)} className="agent-assistant__capability-suppliers">
            {capability.id === "agent" ? <div className="agent-assistant__section-heading"><h3>{isLocal ? "本地 Agent" : "模型提供商"}</h3>{isLocal ? <Button size="sm" tone="ghost" onClick={() => onNavigate("agents")}>管理本地 Agent</Button> : null}</div> : null}
            <ul className="agent-assistant__list">{group.map(supplier => <li key={supplier.id}>
              <div className="agent-assistant__identity"><strong>{supplier.name}</strong><p>{supplier.status}</p>{supplier.models.length ? <div className="agent-assistant__capability-models">{supplier.models.map(model => <span key={model}>{model}</span>)}</div> : null}</div>
              <div className="agent-assistant__actions">
                <Button size="sm" tone="ghost" onClick={() => open(supplier)}>配置</Button>
                {capability.id === "agent" && !supplier.local && contextual ? <Button size="sm" disabled={!supplier.usable || !supplier.connectionId} onClick={() => supplier.connectionId && onUse(supplier.connectionId)}>使用</Button> : null}
              </div>
            </li>)}</ul>
          </section>;
        })}
      </>}
    </div>;
  }

  return <>
    <div className="agent-assistant__page-heading"><h2>能力总览</h2><Button tone="primary" onClick={() => onAdd()}>添加连接</Button></div>
    {sourceError ? <SettingsFeedback tone="danger">{sourceError} <Button size="sm" onClick={onRetry}>重试</Button></SettingsFeedback> : null}
    <div className="agent-assistant__capability-grid">{capabilities.map(item => {
      const reserved = item.id === "model3d" || item.id === "hosting";
      const rows = reserved ? [] : suppliers(item.id);
      const label = reserved ? "暂未接入" : status(item.id, rows);
      const split = !reserved && item.id === "agent" && !pending(item.id) && !failed(item.id);
      const counted = item.id === "agent" ? rows.filter(row => row.configured) : rows;
      const value = counts(item.id as ActiveCapability, rows);
      return <button key={item.id} type="button" className="agent-assistant__capability-card" data-capability={item.id} data-placeholder={reserved} onClick={() => select(item.id)}>
        <span className="agent-assistant__capability-card-top"><item.icon size={26} /><ChevronRightIcon size={16} /></span>
        <strong>{item.label}</strong><span className="agent-assistant__capability-description">{item.description}</span>
        <Tooltip disabled={reserved || pending(item.id) || Boolean(failed(item.id))} side="bottom" align="start" content={<div className="agent-assistant__supplier-tooltip">{counted.length ? counted.map(row => <span key={row.id}><strong>{row.name}</strong><span>{row.status}</span></span>) : "尚未配置供应商，点击查看详情。"}</div>}>
          <span className="agent-assistant__capability-count" data-split={split} data-error={!reserved && Boolean(failed(item.id))}>
            {split ? <><span data-count="local">已配置 {value.local} 个本地 Agent</span><span data-count="suppliers">已配置 {value.suppliers} 个供应商</span></> : label}
          </span>
        </Tooltip>
      </button>;
    })}</div>
    <div className="agent-assistant__mcp-overview">
      <LinkIcon size={23} /><div><h3>MCP</h3><p>让外部 Agent 调用 WooHaa3</p>
        <Tooltip disabled={!mcp || mcp.loading || Boolean(mcp.error)} content={mcp?.configuredTargets?.length ? mcp.configuredTargets.join("、") : "尚未写入客户端配置"}>
          <span className="agent-assistant__state" data-tone={mcp?.error || mcp?.issues.length ? "warning" : "neutral"}>{!mcp || mcp.loading ? "检测中…" : mcp.error ? "检测失败" : `已写入 ${mcp.configured} 个客户端配置`}</span>
        </Tooltip>
      </div><Button size="sm" tone="ghost" onClick={() => onNavigate("mcp")}>管理 <ChevronRightIcon size={14} /></Button>
    </div>
  </>;
}
