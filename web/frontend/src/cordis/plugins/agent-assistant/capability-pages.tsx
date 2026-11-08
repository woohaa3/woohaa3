import { useState } from "react";
import type { AgentConnectionView, ServiceConnectionView, TemporaryHostingRouteView } from "@woohaa3/contracts";
import { Button, SettingsFeedback, Tooltip } from "@woohaa3/ui";
import { AgentIcon, BackIcon, BoxIcon, ChevronRightIcon, CloudIcon, ImageIcon, LinkIcon, MusicIcon, PlusIcon, VideoIcon } from "@woohaa3/ui/icons";
import type { McpPanelSnapshot } from "./mcp-connection-panel.js";
import { capabilitySuppliers, type ActiveCapability, type CapabilityKind, type CapabilitySupplier } from "./capability-directory.js";

export type CapabilityPage = "overview" | "agents" | "mcp" | "sources" | "generation-history";
const capabilities = [
  { id: "agent", label: "Agent", description: "对话、理解与创作协作", icon: AgentIcon },
  { id: "image", label: "图片", description: "图像生成与编辑", icon: ImageIcon },
  { id: "video", label: "视频", description: "视频生成", icon: VideoIcon },
  { id: "audio", label: "音频", description: "语音与音频生成", icon: MusicIcon },
  { id: "model3d", label: "3D", description: "3D 内容生成", icon: BoxIcon },
  { id: "hosting", label: "临时图床", description: "临时外链与上传", icon: CloudIcon },
] as const;

function hostingCount(route: TemporaryHostingRouteView | null): string {
  if (!route) return "不可用";
  const providers = new Set(route.candidates.filter(candidate => candidate.configured).map(candidate => candidate.ownerExtensionId ?? candidate.exposerId));
  return `已配置 ${providers.size} 个提供商`;
}

export function CapabilityOverview({ local, remote, sources, loading, connectionError, sourceLoading, sourceError, mcp, contextual, onNavigate, onAdd, onOpenSource, onUse, onRetry, temporaryHosting, settingsLoading, settingsError, onRetrySettings, onOpenHostingOwner, onConfigureHosting }: {
  local: AgentConnectionView[]; remote: AgentConnectionView[]; sources: ServiceConnectionView[]; loading: boolean; connectionError: string | null; sourceLoading: boolean;
  sourceError: string | null; mcp: McpPanelSnapshot | null; contextual: boolean; onNavigate: (page: CapabilityPage) => void;
  onAdd: (capability?: ActiveCapability) => void; onOpenSource: (id: string) => void; onUse: (connectionId: string) => void; onRetry: () => void;
  temporaryHosting: TemporaryHostingRouteView | null; settingsLoading: boolean; settingsError: string | null;
  onRetrySettings: () => void; onOpenHostingOwner: (ownerExtensionId: string) => void;
  onConfigureHosting: () => void;
}) {
  const [selected, select] = useState<CapabilityKind | null>(null);
  const capability = capabilities.find(item => item.id === selected);
  const placeholder = selected === "model3d";
  const suppliers = (kind: ActiveCapability) => capabilitySuppliers(kind, local, sources, remote);
  const pending = (kind: CapabilityKind) => kind === "hosting" ? settingsLoading : sourceLoading || kind === "agent" && loading;
  const failed = (kind: CapabilityKind) => kind === "hosting" ? settingsError : sourceError || kind === "agent" && connectionError;
  const open = (supplier: CapabilitySupplier) => supplier.local ? onNavigate("agents") : onOpenSource(supplier.sourceId ?? supplier.connectionId!);
  const counts = (kind: ActiveCapability, rows: CapabilitySupplier[]) => kind === "agent"
    ? { local: rows.filter(row => row.local && row.configured).length, suppliers: rows.filter(row => !row.local && row.configured).length }
    : { local: 0, suppliers: rows.filter(row => row.configured).length };
  const status = (kind: CapabilityKind, rows: CapabilitySupplier[]) => {
    if (pending(kind)) return "读取中…";
    if (failed(kind)) return "读取失败";
    if (kind === "hosting") return hostingCount(temporaryHosting);
    if (kind === "model3d") return "暂未接入";
    const value = counts(kind, rows);
    return kind === "agent" ? `已配置 ${value.local} 个本地 Agent · 已配置 ${value.suppliers} 个提供商` : `已配置 ${value.suppliers} 个提供商`;
  };
  const hostingUnavailable = settingsError ? null : temporaryHosting?.error ?? null;

  if (capability) {
    const rows = placeholder || capability.id === "hosting" ? [] : suppliers(capability.id as ActiveCapability);
    return <div data-capability-detail={capability.id}>
      <nav className="agent-assistant__capability-breadcrumb"><Button size="sm" tone="ghost" icon={<BackIcon size={14} />} onClick={() => select(null)}>能力总览</Button><span>/</span><span>{capability.label}</span></nav>
      <div className="agent-assistant__page-heading"><h2>{capability.label}</h2>{!placeholder ? capability.id === "hosting" ? <div className="agent-assistant__actions"><Button size="sm" tone="ghost" onClick={onRetrySettings}>刷新状态</Button><Button tone="primary" onClick={onConfigureHosting}>配置</Button></div> : <Button tone="primary" onClick={() => onAdd(capability.id as ActiveCapability)}>添加提供商</Button> : null}</div>
      {placeholder ? <div className="agent-assistant__capability-placeholder"><capability.icon size={36} /><h3>暂未接入</h3><p>这里将集中展示提供 3D 生成能力的提供商。</p></div> : capability.id === "hosting" ? <>
        <p className="agent-assistant__capability-summary">{capability.description} · {status("hosting", [])}</p>
        {settingsError ? <SettingsFeedback tone="danger">{settingsError} <Button size="sm" onClick={onRetrySettings}>重试</Button></SettingsFeedback>
          : hostingUnavailable ? <SettingsFeedback tone="warning">{hostingUnavailable} <Button size="sm" tone="ghost" onClick={onRetrySettings}>重新读取</Button></SettingsFeedback>
          : null}
        {settingsLoading ? <p>正在读取临时图床…</p> : null}
        {!settingsLoading && !settingsError && temporaryHosting ? <>
          {temporaryHosting.candidates.length ? <section className="agent-assistant__capability-suppliers">
              <ul className="agent-assistant__list">{temporaryHosting.candidates.map(candidate => <li key={candidate.exposerId}>
                <div className="agent-assistant__identity"><strong>{candidate.label}</strong><p>{candidate.configured ? "已配置" : "未配置"}{candidate.selected ? " · 当前选择" : ""}</p>{candidate.lastError ? <SettingsFeedback tone="warning">最近失败：{candidate.lastError}</SettingsFeedback> : null}</div>
                <div className="agent-assistant__actions">{candidate.ownerExtensionId ? <Button size="sm" tone="ghost" onClick={() => onOpenHostingOwner(candidate.ownerExtensionId!)}>配置</Button> : null}</div>
              </li>)}</ul>
            </section> : null}
          {temporaryHosting.lastFailure && !temporaryHosting.candidates.some(candidate => candidate.lastError) ? <SettingsFeedback tone="warning">最近失败：{temporaryHosting.lastFailure.message}</SettingsFeedback> : null}
        </> : null}
        {temporaryHosting && !temporaryHosting.candidates.length ? <div className="agent-assistant__empty-note">还没有可用的临时图床来源。</div> : null}
      </> : <>
        <p className="agent-assistant__capability-summary">{capability.description} · {status(capability.id as ActiveCapability, rows)}</p>
        {failed(capability.id) ? <SettingsFeedback tone="danger">{failed(capability.id)} <Button size="sm" onClick={onRetry}>重试</Button></SettingsFeedback> : null}
        {!pending(capability.id) && !failed(capability.id) && !rows.length ? <div className="agent-assistant__empty-note">尚未配置{capability.label}能力的提供商。{capability.id === "agent" ? <Button size="sm" tone="ghost" onClick={() => onNavigate("agents")}>配置本地 Agent</Button> : null}</div> : null}
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
      const reserved = item.id === "model3d";
      const rows = reserved || item.id === "hosting" ? [] : suppliers(item.id);
      const label = reserved ? "暂未接入" : status(item.id, rows);
      const split = !reserved && item.id === "agent" && !pending(item.id) && !failed(item.id);
      const counted = item.id === "agent" ? rows.filter(row => row.configured) : rows;
      const active = item.id !== "model3d" && item.id !== "hosting" ? item.id : null;
      const value = active ? counts(active, rows) : { local: 0, suppliers: 0 };
      const tooltip = item.id === "hosting"
        ? temporaryHosting?.candidates.map(candidate => <span key={candidate.exposerId}><strong>{candidate.label}</strong><span>{candidate.lastError ? "最近调用失败" : candidate.configured ? "已配置" : "未配置"}{candidate.selected ? " · 当前选择" : ""}</span></span>)
        : counted.length ? counted.map(row => <span key={row.id}><strong>{row.name}</strong><span>{row.status}</span></span>) : "尚未配置提供商，点击查看详情。";
      const empty = active !== null && !pending(item.id) && !failed(item.id) && value.local + value.suppliers === 0;
      const chooseAgent = empty && item.id === "agent" && !rows.length;
      if (chooseAgent) return <div key={item.id} className="agent-assistant__capability-card" data-capability={item.id} data-placeholder={false} data-empty={true} data-actions={true}>
        <span className="agent-assistant__capability-card-top"><item.icon size={26} /></span>
        <strong>{item.label}</strong><span className="agent-assistant__capability-description">{item.description}</span>
        <div className="agent-assistant__capability-add-actions">
          <Button size="sm" className="agent-assistant__capability-add" icon={<PlusIcon size={14} />} onClick={() => onNavigate("agents")}>连接本地 Agent</Button>
          <Button size="sm" className="agent-assistant__capability-add" icon={<PlusIcon size={14} />} onClick={() => onAdd("agent")}>添加模型提供商</Button>
        </div>
      </div>;
      return <button key={item.id} type="button" className="agent-assistant__capability-card" data-capability={item.id} data-placeholder={reserved} data-empty={empty} onClick={() => {
        if (empty && !rows.length) onAdd(item.id as ActiveCapability);
        else select(item.id);
      }}>
        <span className="agent-assistant__capability-card-top"><item.icon size={26} />{empty ? <PlusIcon size={16} /> : <ChevronRightIcon size={16} />}</span>
        <strong>{item.label}</strong><span className="agent-assistant__capability-description">{item.description}</span>
        {empty ? <span className="agent-assistant__capability-add"><PlusIcon size={14} />{rows.length ? "完成配置" : item.id === "agent" ? "添加 Agent" : "添加提供商"}</span> : <Tooltip disabled={reserved || pending(item.id) || Boolean(failed(item.id))} side="bottom" align="start" content={<div className="agent-assistant__supplier-tooltip">{tooltip}</div>}>
          <span className="agent-assistant__capability-count" data-split={split} data-error={!reserved && Boolean(failed(item.id))}>
            {split ? <><span data-count="local">已配置 {value.local} 个本地 Agent</span><span data-count="suppliers">已配置 {value.suppliers} 个提供商</span></> : label}
          </span>
        </Tooltip>}
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
