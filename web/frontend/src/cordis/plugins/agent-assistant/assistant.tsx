import { Component, lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { AgentConnectionView, ServiceConnectionView } from "@woohaa3/contracts";
import { useSlot } from "../../host.js";
import { ContributionBoundary as Guard } from "../../contribution-boundary.js";
import { useOptionalService } from "../../react.js";
import { Button, IconButton, SettingsFeedback, ServiceLogo } from "@woohaa3/ui";
import { BackIcon, CloseIcon } from "@woohaa3/ui/icons";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";
import { UiPortalScope } from "@woohaa3/ui/primitives";
import { McpConnectionPanel, type McpPanelSnapshot } from "./mcp-connection-panel.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { providerConfigGroups } from "../settings/plugin-groups.js";
import { HostingOwnerConfiguration, HostingSourceConfiguration } from "./hosting-configuration.js";
import { PluginIconMark } from "../settings/plugin-icons.js";
import { CapabilityOverview, type CapabilityPage } from "./capability-pages.js";
import type { ActiveCapability } from "./capability-directory.js";
import { useServiceDirectory, serviceSourceState } from "./service-directory.js";
import { AgentAssistantShell } from "./dialog-shell.js";

type Page = "connections" | "add" | "configuration";
type Payload = { canvasId?: string; nodeId?: string; kind?: string; page?: "add"; connectionId?: string; section?: "generation-history" | "diagnostics" };
const kinds = [
  { id: "installed", setupOrder: 10, label: "我有本地 agent", title: "连接本地 agent", services: [{ id: "chatgpt", name: "本地 ChatGPT" }, { id: "opencode", name: "本地 OpenCode" }, { id: "codebuddy", name: "本地 CodeBuddy" }], detail: "使用运行本应用的电脑上已安装的 agent。" },
  { id: "login", setupOrder: 40, label: "我有 ChatGPT 账号", title: "连接 ChatGPT", services: [{ id: "chatgpt", name: "ChatGPT" }], detail: "使用已有的 ChatGPT 账号登录并授权。" },
  { id: "api-key", setupOrder: 10, label: "我有 API Key", title: "连接自定义兼容服务", services: [], detail: "填写兼容服务的协议、地址和 API Key。" },
] as const;
const GenerationProviders = lazy(() => import("../settings/provider-settings-cards.js").then(module => ({ default: module.ProviderSettingsCards })));

function connectionState(connection: AgentConnectionView) {
  const failure = Object.values(connection.status).find(evidence => evidence.state === "failed" || evidence.state === "unavailable");
  const dependency = connection.runtime?.dependency;
  const issue = failure ?? (dependency?.state === "failed" || dependency?.state === "unavailable" ? dependency : null);
  return issue ? connection.reason ?? issue.reason ?? "连接不可用，请检查配置。" : connection.authMode === "api-key" && connection.credentialConfigured === false ? "尚未保存 API Key" : null;
}

export function AgentAssistant({ service, payload, onClose, settingsStore, onConfigurationSaved, onHistoryClose }: { service: AgentConversationService; payload: Payload; onClose: () => void; settingsStore?: BackendSettingsStore; onConfigurationSaved?: () => void; onHistoryClose?: () => boolean }) {
  const contributions = useSlot("agent-assistant.configuration");
  const initialPage: CapabilityPage = payload.section === "generation-history" ? "generation-history" : ["generation", "api-key", "login"].includes(payload.kind ?? "") || payload.page === "add" ? "sources" : payload.kind === "installed" ? "agents" : payload.kind === "mcp" ? "mcp" : "overview";
  const [page, setPage] = useState<CapabilityPage>(initialPage);
  const [servicesVisited, setServicesVisited] = useState(initialPage === "sources");
  const [localVisited, setLocalVisited] = useState(initialPage === "agents");
  const [historyVisited, setHistoryVisited] = useState(initialPage === "generation-history");
  const historyContributions = useSlot("ai-center.generation-history");
  const History = historyContributions[0]?.render;
  const userNavigated = useRef(false);
  const [addRequest, requestAdd] = useState(0);
  const [addCapability, setAddCapability] = useState<ActiveCapability | undefined>();
  const [sourceRequest, setSourceRequest] = useState<{ id: string } | null>(null);
  const [hostingConfiguration, setHostingConfiguration] = useState<{ ownerId?: string } | null>(null);
  const [overviewRevision, resetOverview] = useState(0);
  const [connections, setConnections] = useState<AgentConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [mcp, setMcp] = useState<McpPanelSnapshot | null>(null);
  const directoryState = useServiceDirectory(service, revision);
  const navigate = (next: CapabilityPage) => {
    userNavigated.current = true;
    setHostingConfiguration(null);
    setPage(next);
    if (next === "overview") resetOverview(value => value + 1);
    if (next === "generation-history") setHistoryVisited(true);
    if (next === "sources") setServicesVisited(true);
    if (next === "agents") setLocalVisited(true);
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void service.listConnections().then(result => {
      if (cancelled) return;
      if (result.ok) { setConnections(result.value); setError(null); }
      else setError(result.error);
    }).catch(() => { if (!cancelled) setError("连接读取失败，请重试。"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service, revision]);
  useEffect(() => {
    userNavigated.current = false;
    setHostingConfiguration(null);
    setPage(initialPage);
    if (initialPage === "generation-history") setHistoryVisited(true);
    if (initialPage === "sources") setServicesVisited(true);
    if (initialPage === "agents") setLocalVisited(true);
  }, [payload]);
  useEffect(() => {
    if (!payload.connectionId || payload.section || userNavigated.current) return;
    const connection = connections.find(item => item.connectionId === payload.connectionId);
    if (connection) navigate(isLocalConnection(connection) ? "agents" : "sources");
    else if (directoryState.directory?.connections.some(source => source.serviceConnectionId === payload.connectionId || source.bindings.some(binding => binding.consumerId === payload.connectionId))) navigate("sources");
  }, [payload, connections, directoryState.directory]);
  const saved = () => { onConfigurationSaved?.(); refresh(value => value + 1); };
  const choose = (connection: AgentConnectionView) => {
    if (!connection.ready) return;
    globalThis.dispatchEvent(new CustomEvent("woohaa3-agent-assistant-selection", { detail: { canvasId: payload.canvasId, nodeId: payload.nodeId, connectionId: connection.connectionId } }));
    onClose();
  };
  const chooseById = (connectionId: string) => {
    const connection = connections.find(item => item.connectionId === connectionId);
    if (connection) choose(connection);
  };
  const add = (capability?: ActiveCapability) => { setAddCapability(capability); navigate("sources"); requestAdd(value => value + 1); };
  const openSource = (id: string) => { setSourceRequest({ id }); navigate("sources"); };
  const settingsState = useSyncExternalStore(settingsStore?.subscribe ?? (() => () => {}), settingsStore?.getState ?? (() => null));
  useEffect(() => { void settingsStore?.load(); }, [settingsStore]);
  const hostingSaved = () => { setHostingConfiguration(null); saved(); };
  const localConnections = connections.filter(isLocalConnection);
  const sourceConnections = connections.filter(connection => !isLocalConnection(connection));
  const sources = directoryState.directory?.connections ?? [];
  const localContribution = contributions.find(entry => entry.kind === "installed");
  const LocalConfiguration = localContribution?.render;
  const navigation: { id: CapabilityPage; label: string; count?: number }[] = [
    { id: "overview", label: "能力总览" },
    { id: "agents", label: "本地 Agent", count: localConnections.length },
    { id: "sources", label: "模型提供商", count: directoryState.directory ? sources.length : sourceConnections.length },
    { id: "mcp", label: "MCP 服务", count: mcp?.configured },
    { id: "generation-history", label: "生成历史" },
  ];
  return <AgentAssistantShell onClose={onClose}>
        <nav className="agent-assistant__sidebar">{navigation.map(item => <button key={item.id} type="button" data-page={item.id} data-state={page === item.id ? "active" : "inactive"} onClick={() => navigate(item.id)}><span>{item.label}</span>{item.count !== undefined ? <small>{item.count}</small> : null}</button>)}</nav>
        <div className="agent-assistant__content">
          <section hidden={page !== "overview"} className="agent-assistant__page" data-ai-page="overview">
            {error ? <SettingsFeedback tone="danger">{error} <Button size="sm" onClick={() => refresh(value => value + 1)}>重试</Button></SettingsFeedback> : null}
            <CapabilityOverview key={overviewRevision} local={localConnections} remote={sourceConnections} sources={sources} loading={loading} connectionError={error} sourceLoading={directoryState.loading} sourceError={directoryState.error} mcp={mcp} contextual={Boolean(payload.canvasId && payload.nodeId)} onNavigate={navigate} onAdd={add} onOpenSource={openSource} onUse={chooseById} onRetry={() => refresh(value => value + 1)}
              temporaryHosting={settingsState?.status === "ready" ? settingsState.snapshot.extensionPoints?.temporaryHosting ?? null : null}
              settingsLoading={settingsState?.status === "loading"}
              settingsError={settingsState?.status === "error" ? settingsState.error : settingsState?.status === "unauthorized" ? "临时图床配置由管理员管理。" : null}
              hostingSettingsStore={settingsStore}
              onRetrySettings={() => void settingsStore?.load()}
              onOpenHostingOwner={ownerId => setHostingConfiguration({ ownerId })}
              onConfigureHosting={() => setHostingConfiguration({})} />
          </section>
          {localVisited ? <section hidden={page !== "agents"} className="agent-assistant__page" data-ai-page="agents"><UiPortalScope>
            <div className="agent-assistant__page-heading"><h2>本地 Agent</h2><span className="agent-assistant__muted">宿主电脑 · {localConnections.length} 个连接</span></div>
            {error ? <SettingsFeedback tone="danger">{error}</SettingsFeedback> : null}
            <div className="agent-assistant__local-configuration">{LocalConfiguration ? <LocalConfiguration onSaved={saved} /> : <p className="agent-assistant__empty-note">当前环境未启用本地 Agent 扩展。</p>}</div>
            {localConnections.length && payload.canvasId && payload.nodeId ? <><div className="agent-assistant__section-heading"><h3>用于当前目标</h3></div><ul className="agent-assistant__list">{localConnections.map(connection => <li key={connection.connectionId}><div className="agent-assistant__identity"><strong><span className="service-identity"><ServiceLogo service={connection.adapterId} />{connection.name}</span></strong><p>{connectionState(connection)}</p></div><Button size="sm" tone="primary" disabled={!connection.ready} onClick={() => choose(connection)}>使用</Button></li>)}</ul></> : null}
          </UiPortalScope></section> : null}
          <section hidden={page !== "mcp"} className="agent-assistant__page" data-ai-page="mcp"><UiPortalScope><div className="agent-assistant__page-heading"><h2>MCP 服务</h2></div><McpConnectionPanel canvasId={payload.canvasId} onStatusChange={setMcp} refreshRevision={revision} /></UiPortalScope></section>
          {servicesVisited ? <section hidden={page !== "sources"} className="agent-assistant__page" data-ai-page="sources"><UiPortalScope>
            {service.listServiceConnections || service.serviceConnectionDirectory ? <ServiceSources service={service} connections={connections} contributions={contributions.filter(entry => entry.kind !== "installed")} payload={payload} settingsStore={settingsStore} directoryState={directoryState} addRequest={addRequest} addCapability={addCapability} sourceRequest={sourceRequest} onSaved={saved} onChoose={choose} /> : <ConnectionPanel key={sourceRequest?.id} local={false} connections={sourceConnections} contributions={contributions.filter(entry => entry.kind !== "installed")} payload={sourceRequest ? { ...payload, connectionId: sourceRequest.id } : payload} loading={loading} onSaved={saved} onChoose={choose} />}
          </UiPortalScope></section> : null}
          {historyVisited ? <section hidden={page !== "generation-history"} className="agent-assistant__page agent-assistant__history" data-ai-page="generation-history">
            <div className="agent-assistant__page-heading"><h2>生成历史</h2></div>
            {!payload.canvasId ? <p>从画布打开后查看生成历史。</p> : History ? <HistoryBoundary key={`${payload.canvasId}:${historyContributions[0]?.id}`}><Suspense fallback={<p>正在加载生成历史…</p>}><History canvasId={payload.canvasId} active={page === "generation-history"} onClose={onHistoryClose ?? (() => { onClose(); return true; })} /></Suspense></HistoryBoundary> : <SettingsFeedback tone="danger">生成历史不可用：历史模块未装配。</SettingsFeedback>}
          </section> : null}
          {hostingConfiguration ? <AssistantDrawer title={hostingConfiguration.ownerId
            ? settingsState?.status === "ready" ? settingsState.snapshot.extensionPoints?.temporaryHosting?.candidates.find(candidate => candidate.ownerExtensionId === hostingConfiguration.ownerId)?.label ?? "来源配置" : "来源配置"
            : "临时图床配置"} onClose={() => setHostingConfiguration(null)}>
            {settingsState?.status === "ready" && settingsStore ? hostingConfiguration.ownerId
              ? <HostingOwnerConfiguration ownerId={hostingConfiguration.ownerId} snapshot={settingsState.snapshot} store={settingsStore} onSaved={hostingSaved} />
              : <HostingSourceConfiguration snapshot={settingsState.snapshot} onOpenOwner={ownerId => setHostingConfiguration({ ownerId })} />
              : <SettingsFeedback tone="warning">{settingsState?.status === "error" ? settingsState.error : "临时图床配置暂不可用。"}<Button size="sm" onClick={() => void settingsStore?.load()}>重试</Button></SettingsFeedback>}
          </AssistantDrawer> : null}
        </div>
  </AgentAssistantShell>;
}

class HistoryBoundary extends Component<{ children: ReactNode }, { failed: boolean; revision: number }> {
  state = { failed: false, revision: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <SettingsFeedback tone="danger">生成历史模块加载失败。<Button onClick={() => this.setState({ failed: false, revision: this.state.revision + 1 })}>重新加载</Button></SettingsFeedback> : <div key={this.state.revision} className="agent-assistant__history-view">{this.props.children}</div>;
  }
}

function AssistantDrawer({ title, onClose, children, hidden = false, wide = false }: { title: string; onClose: () => void; children: ReactNode; hidden?: boolean; wide?: boolean }) {
  return <div className="agent-assistant__drawer-layer" hidden={hidden} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className={`agent-assistant__drawer${wide ? " agent-assistant__drawer--wide" : ""}`}>
      <div className="agent-assistant__drawer-head"><h2>{title}</h2><IconButton size="sm" label="关闭详情" onClick={onClose}><CloseIcon size={16} /></IconButton></div>
      <div className="agent-assistant__drawer-body"><UiPortalScope>{children}</UiPortalScope></div>
    </aside>
  </div>;
}

function isLocalConnection(connection: AgentConnectionView) {
  return connection.authMode === "local-login" || connection.runCategory === "local-appserver";
}

type ConfigurationContribution = {
  id: string;
  owner?: string;
  kind: string;
  label: string;
  description?: string;
  icon?: string;
  modelTypes?: readonly string[];
  setupOrder?: number;
  providerId?: string;
  render: ComponentType<{ connectionId?: string; onSaved?: (connectionId: string) => void }>;
};
type ProviderTemplate = { id: string; label: string; providerId: string; description: string; icon?: string; website?: string; setupOrder?: number; usesApiKey: boolean; modelTypes: readonly string[] };
const MODEL_TYPE_LABELS = [["language", "文本"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]] as const;

function ModelTypeTags({ types }: { types: readonly string[] }) {
  const labels = MODEL_TYPE_LABELS.filter(([type]) => types.includes(type));
  return <span className="agent-assistant__model-types">{labels.length ? labels.map(([type, label]) => <span key={type} data-model-type={type}>{label}</span>) : <span>模型待发现</span>}</span>;
}
function ConnectionPanel({ local, compact = false, connections, contributions, payload, loading, onSaved, onChoose }: {
  local: boolean; connections: AgentConnectionView[]; contributions: readonly ConfigurationContribution[];
  payload: Payload; loading: boolean; onSaved: () => void; onChoose: (connection: AgentConnectionView) => void;
  compact?: boolean;
}) {
  const initialKind = local ? payload.kind === "installed" ? "installed" : "" : ["api-key", "login"].includes(payload.kind ?? "") ? payload.kind! : "";
  const [page, setPage] = useState<Page>(initialKind || payload.connectionId ? "configuration" : payload.page === "add" ? "add" : "connections");
  const [kind] = useState(initialKind);
  const [selected, setSelected] = useState<string | null>(payload.connectionId ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = connections.find(item => item.connectionId === selected);
  const configuration = contributions.find(entry => current ? entry.owner === current.extensionId : entry.kind === kind);
  const Config = configuration?.render;
  const back = () => { setPage("connections"); setSelected(null); };
  const saved = (id: string) => { onSaved(); back(); setNotice(id ? "已保存" : null); };
  const contextual = Boolean(payload.canvasId && payload.nodeId);
  const heading = local ? "本地 Agent" : "API 与账号授权";
  const showAddAction = !local;
  const showNavigation = !compact || notice || showAddAction;
  return <>
    {page !== "connections" ? <nav className="agent-assistant__back"><Button size="sm" tone="ghost" icon={<BackIcon size={14} />} onClick={back}>{local ? "所有本地助手" : "所有模型提供商"}</Button></nav> : null}
    {page === "connections" ? <>
      {showNavigation ? <div className={`agent-assistant__navigation${compact ? " agent-assistant__navigation--compact" : ""}`}>{compact ? null : <h3>{heading}</h3>}{notice ? <span>{notice}</span> : null}{showAddAction ? <Button size="sm" onClick={() => { setSelected(null); setPage("add"); }}>添加连接</Button> : null}</div> : null}
      {loading ? <p>正在读取连接…</p> : connections.length === 0 ? local ? <div className="agent-assistant__local-empty"><div className="agent-assistant__local-empty-copy"><strong>连接宿主电脑上的 Agent</strong><p>检测到本机 Agent 后，它们会直接出现在这里。也可以先选择一种本地 Agent 完成配置。</p></div><AddConnectionForm contributions={contributions} onSaved={saved} local /></div> : <div className="agent-assistant__empty"><p>尚未配置 API 或账号授权。</p></div> : <ul className="agent-assistant__list">{connections.map(connection => <li key={connection.connectionId}>
        <div className="agent-assistant__identity"><strong><span className="service-identity"><ServiceLogo service={connection.authMode === "oauth" ? "chatgpt" : connection.adapterId} />{connection.name}</span></strong>{connectionState(connection) ? <p className="agent-assistant__status">{connectionState(connection)}</p> : null}</div>
        <div className="agent-assistant__actions"><Button size="sm" tone="ghost" onClick={() => { setSelected(connection.connectionId); setPage("configuration"); }}>管理</Button>{contextual ? <Button size="sm" tone="primary" disabled={!connection.ready} onClick={() => onChoose(connection)}>使用</Button> : null}</div>
      </li>)}</ul>}
    </> : page === "add" ? <AddConnectionForm contributions={contributions} onSaved={saved} local={local} /> : selected && !current ? loading ? <p>正在读取连接…</p> : <p>此连接已不存在或属于另一入口，请返回列表重新选择。</p> : Config ? <div className="agent-assistant__configuration"><Config key={selected ?? kind} connectionId={selected ?? undefined} onSaved={saved} /></div> : <p>当前环境未启用此连接的配置扩展。请在设置页由管理员启用后重试。</p>}
  </>;
}

function ProviderWebsite({ website, children, className = "" }: { website?: string; children: ReactNode; className?: string }) {
  const href = website && /^https?:\/\//i.test(website) ? website : undefined;
  return <a className={`agent-assistant__provider-website ${className}`} href={href} target={href ? "_blank" : undefined} rel={href ? "noopener noreferrer" : undefined}>{children}</a>;
}

function AddConnectionForm({ contributions, onSaved, local, providerGroups = [], settingsStore, initialKind, capability }: {
  local: boolean;
  contributions: ReadonlyArray<{
    id: string;
    kind: string;
    label: string;
    description?: string;
    icon?: string;
    modelTypes?: readonly string[];
    setupOrder?: number;
    render: ComponentType<{ connectionId?: string; onSaved?: (connectionId: string) => void }>;
  }>;
  onSaved: (connectionId: string) => void;
  providerGroups?: readonly ProviderTemplate[];
  settingsStore?: BackendSettingsStore;
  initialKind?: string;
  capability?: ActiveCapability;
}) {
  const [selectedKind, setSelectedKind] = useState<string | null>(initialKind ?? null);
  const [visited, setVisited] = useState<string[]>(initialKind ? [initialKind] : []);
  const addRef = useRef<HTMLDivElement>(null);
  const selectionScrollTop = useRef(0);
  const selectMethod = (id: string) => {
    const container = addRef.current?.closest<HTMLElement>(".agent-assistant__drawer-body, .agent-assistant__page");
    selectionScrollTop.current = container?.scrollTop ?? 0;
    setSelectedKind(id);
    setVisited(current => current.includes(id) ? current : [...current, id]);
  };
  useEffect(() => {
    const container = addRef.current?.closest<HTMLElement>(".agent-assistant__drawer-body, .agent-assistant__page");
    if (container) container.scrollTop = selectedKind ? 0 : selectionScrollTop.current;
  }, [selectedKind]);
  const providerMethods = local ? [] : providerGroups.filter(group => !capability || group.modelTypes.includes(capability === "agent" ? "language" : capability));
  const loginProviderMethods = local ? [] : contributions
    .filter(entry => entry.kind === "provider-login")
    .filter(entry => !capability || (entry.modelTypes ?? []).includes(capability === "agent" ? "language" : capability))
    .map(entry => ({ type: "login-provider" as const, id: `login-provider:${entry.id}`, setupOrder: entry.setupOrder ?? 60, label: entry.label, entry }));
  const methods = [
    ...kinds.filter(item => local ? item.id === "installed" : item.id !== "installed" && (!capability || capability === "agent"))
      .map(item => ({ type: "connection" as const, id: item.id, setupOrder: item.setupOrder, item })),
    ...providerMethods.map(group => ({ type: "provider" as const, id: `provider:${group.providerId}`, setupOrder: group.setupOrder ?? 100, group })),
    ...loginProviderMethods,
  ].sort((a, b) => a.setupOrder - b.setupOrder);
  const knownSelection = selectedKind && methods.some(method => method.id === selectedKind) ? selectedKind : null;
  const selectedMethod = selectedKind
    ? kinds.find(item => item.id === selectedKind)
      ?? providerMethods.find(group => `provider:${group.providerId}` === selectedKind)
      ?? loginProviderMethods.find(method => method.id === selectedKind)
    : null;
  const selectedLabel = selectedMethod?.label ?? null;
  return <div ref={addRef} className="agent-assistant__add" data-step={knownSelection ? "configuration" : "selection"}>
    <div className="agent-assistant__methods" hidden={knownSelection !== null}>{methods.map(method => {
      const { id } = method;
      if (method.type === "login-provider") {
        const { entry } = method;
        return <div key={id} className="agent-assistant__method agent-assistant__method--provider" data-kind={id} data-selected={knownSelection === id}>
          <ProviderWebsite><span className="agent-assistant__provider-mark"><PluginIconMark icon={entry.icon} size={22} /></span><strong>{entry.label}</strong></ProviderWebsite>
          <span className="agent-assistant__method-description">{entry.description ?? "使用已有账号登录并授权。"}</span>
          <div className="agent-assistant__method-footer"><ModelTypeTags types={entry.modelTypes ?? []} /><div className="agent-assistant__method-actions"><Button size="sm" tone="primary" onClick={() => selectMethod(id)}>配置</Button></div></div>
        </div>;
      }
      if (method.type === "provider") {
        const { group } = method;
        return <div key={id} className="agent-assistant__method agent-assistant__method--provider" data-kind={id} data-selected={knownSelection === id}>
          <ProviderWebsite website={group.website}><span className="agent-assistant__provider-mark"><PluginIconMark icon={group.icon} size={22} /></span><strong>{group.label}</strong></ProviderWebsite>
          <span className="agent-assistant__method-description">{group.description || "使用此提供商的现有配置。"}</span>
          <div className="agent-assistant__method-footer"><ModelTypeTags types={group.modelTypes} /><div className="agent-assistant__method-actions">{group.usesApiKey ? <ProviderWebsite website={group.website} className="agent-assistant__get-api-key">获取 API Key</ProviderWebsite> : null}<Button size="sm" tone="primary" onClick={() => selectMethod(id)}>配置</Button></div></div>
        </div>;
      }
      const { item } = method;
      const available = contributions.some(entry => entry.kind === id);
      const website = id === "login" ? "https://chatgpt.com" : undefined;
      return <div key={id} className="agent-assistant__method" data-kind={id} data-selected={selectedKind === id} data-disabled={!available}>
        <ProviderWebsite website={website}><strong>{item.label}</strong></ProviderWebsite>
        <span className="agent-assistant__brands">{item.services.map(service => <ProviderWebsite website={website} key={service.id}><span className="service-identity"><ServiceLogo service={service.id} size={18} />{service.name}</span></ProviderWebsite>)}</span>
        <span className="agent-assistant__method-description">{available ? item.detail : "当前环境未启用"}</span>
        <div className="agent-assistant__method-footer">{id !== "installed" ? <ModelTypeTags types={["language"]} /> : null}<Button size="sm" tone="primary" disabled={!available} onClick={() => selectMethod(id)}>配置</Button></div>
      </div>;
    })}</div>
    {capability && capability !== "agent" && !providerMethods.length && selectedKind === null ? <p className="agent-assistant__empty-note">当前没有可配置的{MODEL_TYPE_LABELS.find(([type]) => type === capability)?.[1]}提供商扩展。</p> : null}
    <div className="agent-assistant__forms" hidden={knownSelection === null}>
      <div className="agent-assistant__form-heading">
        <Button size="sm" tone="ghost" icon={<BackIcon size={14} />} onClick={() => setSelectedKind(null)}>返回选择</Button>
        <h3>{selectedLabel}</h3>
      </div>
      {visited.map(id => {
        const contribution = contributions.find(entry => entry.kind === id || (entry.kind === "provider-login" && id === `login-provider:${entry.id}`));
        const Entry = contribution?.render;
        const providerId = id.startsWith("provider:") ? id.slice("provider:".length) : undefined;
        // Keep the instance and its portal container together under the hidden owner.
        return <div key={id} data-form-kind={id} hidden={knownSelection !== id} className="agent-assistant__add-form">
          <UiPortalScope>{providerId && settingsStore ? <Suspense fallback={<p>正在读取 Provider 配置…</p>}><GenerationProviders store={settingsStore} compact providerId={providerId} onSaved={() => onSaved(providerId)} /></Suspense> : Entry ? <Entry onSaved={onSaved} /> : <p>当前环境未启用此连接的配置扩展。</p>}</UiPortalScope>
        </div>;
      })}
    </div>
  </div>;
}

function ProviderBalanceSlot({ providerId, contributions }: { providerId: string | undefined; contributions: ReadonlyArray<{ providerId: string; render: ComponentType }> }) {
  const entry = providerId ? contributions.find(item => item.providerId === providerId) : undefined;
  if (!entry) return null;
  const Balance = entry.render;
  return <Guard entry={entry} slot="agent-assistant.provider-balance" fallback="hidden"><Balance /></Guard>;
}

function ServiceSources({ service, connections, contributions, payload, settingsStore, directoryState, addRequest, addCapability, sourceRequest, onSaved, onChoose }: {
  service: AgentConversationService; connections: AgentConnectionView[]; contributions: readonly ConfigurationContribution[];
  payload: Payload; settingsStore?: BackendSettingsStore; directoryState: ReturnType<typeof useServiceDirectory>; addRequest: number; onSaved: () => void; onChoose: (connection: AgentConnectionView) => void;
  addCapability?: ActiveCapability; sourceRequest: { id: string } | null;
}) {
  const { directory, loading, error: directoryError } = directoryState;
  const sources = directory?.connections ?? [];
  const [confirmation, setConfirmation] = useState<import("@woohaa3/contracts").ServiceConnectionManagement | null>(null);
  const [busy, setBusy] = useState(false);
  const mergeOperations = useRef(new Map<string, string>());
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(Boolean(payload.page === "add" || ["api-key", "login"].includes(payload.kind ?? "")) && !payload.connectionId);
  const [visited, setVisited] = useState<string[]>([]);
  const settings = useSyncExternalStore(settingsStore?.subscribe ?? (() => () => {}), settingsStore?.getState ?? (() => null));
  const modelsService = useOptionalService("generationModelsStatus");
  const modelState = useSyncExternalStore(modelsService?.subscribe ?? (() => () => {}), modelsService?.getSnapshot ?? (() => null));
  const loginProviderMethods = contributions
    .filter(entry => entry.kind === "provider-login")
    .map(entry => ({ id: `login-provider:${entry.id}`, entry }));
  const balanceContributions = useSlot("agent-assistant.provider-balance");
  const providerGroups: ProviderTemplate[] = settings?.status === "ready" ? providerConfigGroups(settings.snapshot).flatMap(group => group.providerId ? [{
    id: group.id, label: group.label, providerId: group.providerId, description: group.description, icon: group.icon, website: group.website, setupOrder: group.setupOrder,
    usesApiKey: group.entries.some(entry => entry.secret && entry.key.endsWith(".apiKey")),
    modelTypes: group.modelTypes ?? (modelState
      ? modelState.models.filter(model => model.providerId === group.providerId && !model.tombstone).map(model => model.modelType)
      : directory?.providers.find(provider => provider.providerId === group.providerId)?.models.map(model => model.type) ?? []),
  }] : []) : [];
  useEffect(() => { void settingsStore?.load(); }, [settingsStore]);
  const [addVisited, setAddVisited] = useState(adding);
  const [initialMethod, setInitialMethod] = useState<string | undefined>();
  const [activeCapability, setActiveCapability] = useState<ActiveCapability | undefined>();
  const handledSourceRequest = useRef<typeof sourceRequest>(null);
  useEffect(() => { if (addRequest) { setActiveCapability(addCapability); setAdding(true); setAddVisited(true); setSelected(null); } }, [addRequest, addCapability]);
  const showAdd = () => { setActiveCapability(undefined); setInitialMethod(undefined); setAdding(true); setAddVisited(true); setSelected(null); };
  const open = (id: string) => { setSelected(id); setAdding(false); setVisited(current => current.includes(id) ? current : [...current, id]); };
  useEffect(() => {
    if (!payload.connectionId || payload.section) return;
    const source = sources.find(item => item.serviceConnectionId === payload.connectionId || item.bindings.some(binding => binding.consumerId === payload.connectionId));
    if (source) open(source.serviceConnectionId);
  }, [payload.connectionId, sources]);
  useEffect(() => {
    if (!sourceRequest || handledSourceRequest.current === sourceRequest) return;
    const source = sources.find(item => item.serviceConnectionId === sourceRequest.id || item.bindings.some(binding => binding.consumerId === sourceRequest.id));
    if (source) { handledSourceRequest.current = sourceRequest; open(source.serviceConnectionId); }
  }, [sourceRequest, sources]);
  const back = () => { setSelected(null); setAdding(false); };
  const confirmChange = async () => {
    if (!confirmation || !service.manageServiceConnection || busy) return;
    const action = confirmation.action;
    setBusy(true); setError(null);
    try {
      const result = await service.manageServiceConnection(confirmation);
      if (result.ok) { setConfirmation(null); if (action === "remove") back(); onSaved(); }
      else setError(result.error);
    } catch { setError("操作未确认，请保留本次操作并重试。"); }
    finally { setBusy(false); }
  };
  const current = sources.find(source => source.serviceConnectionId === selected);
  const selectedProvider = selected?.startsWith("template:") ? selected.slice("template:".length) : current?.bindings.find(binding => binding.consumer === "provider")?.consumerId;
  return <>
    <div className="agent-assistant__page-heading"><h2>模型提供商</h2><Button tone="primary" onClick={showAdd}>添加连接</Button></div>
    {loading ? <p>正在读取模型提供商…</p> : null}
    {directoryError ? <SettingsFeedback tone="danger">{directoryError} <Button size="sm" onClick={onSaved}>重新读取</Button></SettingsFeedback> : null}
    {!loading && !directoryError && !sources.length && !loginProviderMethods.length ? <div className="agent-assistant__empty agent-assistant__empty--service"><h3>添加你的第一个模型提供商</h3><p>添加 API、中转站或账号授权，用于助手与生成。</p><Button size="lg" tone="primary" onClick={showAdd}>添加第一个模型提供商</Button></div> : null}
    {sources.length || loginProviderMethods.length ? <ul className="agent-assistant__list agent-assistant__source-list">{loginProviderMethods.map(method => (
      <li key={method.id}><div className="agent-assistant__identity"><strong><span className="agent-assistant__provider-mark"><PluginIconMark icon={method.entry.icon} size={22} /></span>{method.entry.label}</strong></div><div className="agent-assistant__meta"><ProviderBalanceSlot providerId={method.entry.providerId} contributions={balanceContributions} /><span className="agent-assistant__state" data-tone="neutral">账号登录</span></div><div className="agent-assistant__actions"><Button size="sm" tone="ghost" onClick={() => { setInitialMethod(method.id); setSelected(null); setAdding(true); setAddVisited(true); }}>配置</Button></div></li>
    ))}{sources.map(source => {
      const connection = connections.find(item => source.bindings.some(binding => binding.consumerId === item.connectionId));
      const state = serviceSourceState(source);
      const providerId = source.bindings.find(binding => binding.consumer === "provider")?.consumerId;
      const icon = providerGroups.find(group => group.providerId === providerId)?.icon ?? (source.kind === "oauth" ? "identity" : "provider");
      return <li key={source.serviceConnectionId}><div className="agent-assistant__identity"><strong><span className="agent-assistant__provider-mark"><PluginIconMark icon={icon} size={22} /></span>{source.name}</strong></div><div className="agent-assistant__meta"><ProviderBalanceSlot providerId={providerId} contributions={balanceContributions} /><span className="agent-assistant__state" data-tone={state.tone}>{state.label}{source.managedByAdministrator ? " · 只读" : ""}</span></div><div className="agent-assistant__actions"><Button size="sm" tone="ghost" onClick={() => open(source.serviceConnectionId)}>配置</Button>{connection && payload.canvasId && payload.nodeId ? <Button size="sm" disabled={!connection.ready} onClick={() => onChoose(connection)}>使用</Button> : null}</div></li>;
    })}</ul> : null}
    {addVisited ? <AssistantDrawer title={activeCapability ? `添加${activeCapability === "agent" ? " Agent" : MODEL_TYPE_LABELS.find(([type]) => type === activeCapability)?.[1]}提供商` : "添加模型提供商"} onClose={back} hidden={!adding} wide>
      <AddConnectionForm key={`${addRequest}:${initialMethod ?? activeCapability ?? "all"}`} capability={activeCapability} local={false} initialKind={initialMethod ?? (activeCapability ? undefined : payload.kind)} contributions={contributions} providerGroups={providerGroups} settingsStore={settingsStore} onSaved={() => { onSaved(); back(); }} />
      {settings?.status === "loading" ? <p>正在读取提供商…</p> : settings?.status === "error" ? <SettingsFeedback tone="danger">{settings.error} <Button size="sm" onClick={() => void settingsStore?.load()}>重试</Button></SettingsFeedback> : settings?.status === "unauthorized" ? <p>提供商配置由管理员管理。个人 API 与账号授权仍可使用。</p> : null}
    </AssistantDrawer> : null}
    <AssistantDrawer title={current?.name ?? "连接配置"} onClose={back} hidden={!selected}>
      {error ? <SettingsFeedback tone="danger">{error} <Button size="sm" onClick={onSaved}>重新读取</Button></SettingsFeedback> : null}
    {visited.map(id => {
      const source = sources.find(item => item.serviceConnectionId === id);
      const provider = id.startsWith("template:") ? id.slice("template:".length) : source?.scope === "site" ? source.bindings.find(binding => binding.consumer === "provider")?.consumerId : undefined;
      const binding = source?.bindings.find(item => item.consumer === "agent" || item.consumer === "oauth");
      const Contribution = contributions.find(entry => entry.owner === binding?.extensionId)?.render;
      return <div key={id} hidden={selected !== id}><UiPortalScope>
        {source ? <div className="agent-assistant__source-summary"><dl><div><dt>范围</dt><dd>{source.scope === "site" ? "站点共享" : "个人"}</dd></div><div><dt>认证</dt><dd>{source.kind === "oauth" ? "账号授权" : "API Key"}</dd></div><div><dt>用途绑定</dt><dd>{source.bindings.length} 个</dd></div></dl><p>修改认证后，旧回合和排队调用需要重新确认。</p></div> : null}
        {source && service.manageServiceConnection ? <>
          {!source.managedByAdministrator && !source.locked && source.kind === "api" ? <>
            <Button size="sm" tone="ghost" onClick={() => setConfirmation({ action: "enabled", serviceConnectionId: id, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch, enabled: !source.enabled })}>{source.enabled ? "停用来源" : "启用来源"}</Button>
            {source.scope === "personal" || !source.enabled ? <Button size="sm" tone="ghost" onClick={() => setConfirmation({ action: "remove", serviceConnectionId: id, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch })}>移除来源</Button> : null}
            <AdditionalProtocolForm source={source} onConfirm={setConfirmation} />
          </> : null}
          {source.scope === "site" && !source.managedByAdministrator && !source.bindings.some(binding => binding.bindingId.startsWith("provider-assistant:")) && source.capabilities.some(capability => capability.purpose === "discussion" && capability.protocol === "chat-completions") ? <Button size="sm" onClick={() => setConfirmation({ action: "assistant", serviceConnectionId: id, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch, enabled: !source.bindings.some(binding => binding.consumerId === "shared:chat-completions") })}>{source.bindings.some(binding => binding.consumerId === "shared:chat-completions") ? "关闭共享助手用途" : "开放共享讨论用途"}</Button> : null}
          {source.scope === "personal" && source.kind === "api" ? <details><summary>绑定普通文本生成</summary><p>沿用 Provider 的模型身份，共用此来源的 Key。仅列出已适配的相同模型。</p>{directory?.providers.flatMap(provider => provider.models.filter(model => model.type === "language" && source.capabilities.some(capability => capability.purpose === "discussion" && capability.modelId === model.modelId && provider.protocols.includes(capability.protocol))).map(model => <Button key={model.modelKey} size="sm" onClick={() => setConfirmation({ action: "provider", serviceConnectionId: id, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch, providerId: provider.providerId, modelId: model.modelId })}>{model.modelKey}</Button>))}</details> : null}
          {directory?.duplicates.filter(pair => pair.includes(id)).map(pair => {
            const otherId = pair.find(candidate => candidate !== id)!;
            const other = sources.find(source => source.serviceConnectionId === otherId);
            if (!other || source.managedByAdministrator || other.managedByAdministrator) return null;
            return <div key={otherId}><p>可能与「{other.name}」重复。相同地址也可以是不同账号；只在确认同一授权时合并。</p><Button size="sm" onClick={() => {
              const key = JSON.stringify([id, otherId, source.configRevision, other.configRevision]);
              let operationId = mergeOperations.current.get(key);
              if (!operationId) { operationId = crypto.randomUUID(); mergeOperations.current.set(key, operationId); }
              setConfirmation({ action: "merge", operationId, retainedId: id, removedId: otherId, retained: source, removed: other });
            }}>保留此来源并合并 {other.bindings.length} 个绑定</Button></div>;
          })}
        </> : null}
        {source?.managedByAdministrator ? <p>此共享来源由管理员管理。</p> : provider && settingsStore ? <Suspense fallback={<p>正在读取配置…</p>}><GenerationProviders store={settingsStore} compact providerId={provider} onSaved={() => { onSaved(); back(); }} /></Suspense> : Contribution && binding ? <Contribution connectionId={binding.consumerId} onSaved={() => { onSaved(); back(); }} /> : <p>当前来源未提供配置适配器，请启用对应扩展。</p>}
      </UiPortalScope></div>;
    })}
    {confirmation ? <div className="provider-connection__confirmation"><p>{confirmation.action === "protocol" ? "确认新增此协议入口并共用当前认证？请确认该地址属于同一受信任服务。手填模型只开放讨论，不授予目标工具权限。" : confirmation.action === "enabled" ? `确认${confirmation.enabled ? "启用" : "停用"}整个来源？将影响该来源的全部消费绑定和后续调用；已提交回执仍保留。` : confirmation.action === "merge" ? "确认使用保留来源的认证重绑消费者？原来源和历史保留；执行中的回合会阻止合并。" : confirmation.action === "assistant" ? "确认调整站点共享讨论用途？此操作影响已获站点使用权限的用户；不会授予作品写入或工具权限。" : confirmation.action === "remove" ? "确认移除来源？后续调用与旧工具授权将失效；已提交结果与历史保留。Provider 配置变化后可重新投影。" : "确认让此 Provider 使用当前来源？不会复制 Key，也不会发送生成请求。"}</p><Button size="sm" disabled={busy} onClick={() => setConfirmation(null)}>取消</Button><Button size="sm" disabled={busy} onClick={() => void confirmChange()}>确认</Button></div> : null}
    {selectedProvider && settings?.status === "unauthorized" ? <p>此共享来源由管理员管理。</p> : null}
    </AssistantDrawer>
  </>;
}


function AdditionalProtocolForm({ source, onConfirm }: { source: ServiceConnectionView; onConfirm: (input: import("@woohaa3/contracts").ServiceConnectionManagement) => void }) {
  const protocols = (["responses", "messages", "chat-completions", "gemini"] as const).filter(protocol => !source.endpoints.some(endpoint => endpoint.protocol === protocol));
  const [protocol, setProtocol] = useState<import("@woohaa3/contracts").ServiceConnectionProtocol>(() => protocols[0] ?? "chat-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  if (!protocols.length) return null;
  const selectedProtocol = protocols.includes(protocol as typeof protocols[number]) ? protocol : protocols[0]!;
  return <details><summary>更多协议入口</summary><form className="provider-connection" onSubmit={event => {
    event.preventDefault();
    onConfirm({ action: "protocol", serviceConnectionId: source.serviceConnectionId, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch,
      endpoint: { protocol: selectedProtocol, baseUrl: baseUrl.trim() }, models: models.split(/[,，\n]/).map(model => model.trim()).filter(Boolean) });
  }}><p>同一受信任服务的多个协议共用当前 Key；不同账号或不同 Key 应新建来源。</p><label>API 协议<select value={selectedProtocol} onChange={event => setProtocol(event.target.value as typeof protocol)}>{protocols.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}</select></label><label>Base URL<input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label><label>模型 ID<input required value={models} onChange={event => setModels(event.target.value)} placeholder="多个模型用逗号分隔" /></label><Button size="sm" type="submit">保存协议入口</Button></form></details>;
}
