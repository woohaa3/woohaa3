import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import type { AgentConnectionView } from "@woohaa3/contracts";
import { useSlot } from "../../host.js";
import { Button, SettingsFeedback, ServiceLogo } from "../../../shared/ui/index.js";
import { BackIcon } from "../../../shared/ui/icons.js";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";
import { UiPortalScope } from "../../../shared/ui/UiProvider.js";
import { Dialog, DialogHeader, DialogTitle, DialogBody } from "../../services/dialogs/Dialog.js";
import { McpConnectionPanel } from "./mcp-connection-panel.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import "./style.css";

type Page = "connections" | "add" | "configuration";
type Payload = { canvasId?: string; nodeId?: string; kind?: string };
const kinds = [
  { id: "installed", label: "调用本机 Agent", title: "调用本机 Agent", services: [{ id: "codex", name: "Codex" }, { id: "opencode", name: "OpenCode" }, { id: "codebuddy", name: "CodeBuddy" }], detail: "使用应用宿主机器上已安装的 Agent。" },
  { id: "api-key", label: "API Key", title: "连接模型 API", services: [{ id: "responses-protocol", name: "Responses" }, { id: "messages-protocol", name: "Messages" }, { id: "chat-protocol", name: "Chat Completions" }, { id: "gemini-protocol", name: "Gemini" }], detail: "使用已有的模型 API 地址与密钥。" },
  { id: "login", label: "授权", title: "连接 ChatGPT", services: [{ id: "chatgpt", name: "ChatGPT" }], detail: "通过 ChatGPT 账号授权连接。" },
] as const;
const GenerationProviders = lazy(() => import("../settings/provider-settings-cards.js").then(module => ({ default: module.ProviderSettingsCards })));

function connectionState(connection: AgentConnectionView) {
  const failure = Object.values(connection.status).find(evidence => evidence.state === "failed" || evidence.state === "unavailable");
  const dependency = connection.runtime?.dependency;
  const issue = failure ?? (dependency?.state === "failed" || dependency?.state === "unavailable" ? dependency : null);
  return issue ? connection.reason ?? issue.reason ?? "连接不可用，请检查配置。" : connection.authMode === "api-key" && connection.credentialConfigured === false ? "尚未保存 API Key" : null;
}

export function AgentAssistant({ service, payload, onClose, settingsStore, onConfigurationSaved }: { service: AgentConversationService; payload: Payload; onClose: () => void; settingsStore?: BackendSettingsStore; onConfigurationSaved?: () => void }) {
  const contributions = useSlot("agent-assistant.configuration");
  const [tab, setTab] = useState(payload.kind === "generation" || payload.kind === "mcp" ? payload.kind : "intelligence");
  const [generationVisited, setGenerationVisited] = useState(payload.kind === "generation");
  const [page, setPage] = useState<Page>(payload.kind && !["generation", "mcp"].includes(payload.kind) ? "configuration" : "connections");
  const [kind, setKind] = useState(payload.kind ?? "");
  const [connections, setConnections] = useState<AgentConnectionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void service.listConnections().then((result) => {
      if (cancelled) return;
      if (result.ok) { setConnections(result.value); setError(null); }
      else setError(result.error);
    }).catch(() => { if (!cancelled) setError("连接读取失败，请重试。"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service, revision]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice, revision]);
  const current = connections.find((connection) => connection.connectionId === selected);
  const configuration = contributions.find((entry) => current ? entry.owner === current.extensionId : entry.kind === kind);
  const Config = configuration?.render;
  const contextual = Boolean(payload.canvasId && payload.nodeId);
  const title = tab !== "intelligence" ? "AI 助手" : page === "connections" ? "AI 助手" : page === "add" ? "添加助手" : current?.name ?? kinds.find((item) => item.id === kind)?.title ?? "配置助手";
  const back = () => { setPage("connections"); setSelected(null); setKind(""); setError(null); refresh((value) => value + 1); };
  const saved = (connectionId: string) => { onConfigurationSaved?.(); back(); setNotice(connectionId ? "已保存" : null); };
  const useConnection = (connectionId: string) => {
    globalThis.dispatchEvent(new CustomEvent("woohaa3-agent-assistant-selection", { detail: { canvasId: payload.canvasId, nodeId: payload.nodeId, connectionId } }));
    onClose();
  };

  return <Dialog.Content size="lg" className={`agent-assistant${tab === "intelligence" && page === "add" ? " agent-assistant--add" : tab === "generation" ? " agent-assistant--generation" : ""}`} ariaLabel="AI 助手">
    <UiPortalScope>
      <DialogHeader onClose={onClose}><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody>
        <div className="ui-tabs__list agent-assistant__tabs">
          <button type="button" className="ui-tabs__trigger" data-state={tab === "intelligence" ? "active" : "inactive"} onClick={() => setTab("intelligence")}>助手</button>
          <button type="button" className="ui-tabs__trigger" data-state={tab === "generation" ? "active" : "inactive"} onClick={() => { setTab("generation"); setGenerationVisited(true); }}>生成服务</button>
          <button type="button" className="ui-tabs__trigger" data-state={tab === "mcp" ? "active" : "inactive"} onClick={() => setTab("mcp")}>MCP</button>
        </div>
        <section hidden={tab !== "intelligence"} data-ai-tab="intelligence"><UiPortalScope>
        {page !== "connections" ? <nav className="agent-assistant__back"><Button size="sm" tone="ghost" icon={<BackIcon size={14} />} onClick={back}>所有助手</Button></nav> : null}
        {error ? <SettingsFeedback tone="danger">{error} <Button size="sm" onClick={() => refresh((value) => value + 1)}>重试</Button></SettingsFeedback> : null}
        {page === "connections" ? <>
          <div className="agent-assistant__navigation"><h3>当前已配置助手</h3>{notice ? <span>{notice}</span> : null}{connections.length ? <Button size="sm" onClick={() => { setSelected(null); setPage("add"); }}>添加助手</Button> : null}</div>
          {loading ? <p>正在读取助手…</p> : connections.length === 0 ? <div className="agent-assistant__empty"><h3>连接你的第一个助手</h3><Button tone="primary" onClick={() => setPage("add")}>添加助手</Button></div> : <ul className="agent-assistant__list">{connections.map((connection) => <li key={connection.connectionId}>
            <div className="agent-assistant__identity"><strong><span className="service-identity"><ServiceLogo service={connection.authMode === "oauth" ? "chatgpt" : connection.adapterId} />{connection.name}</span></strong>{connectionState(connection) ? <p className="agent-assistant__status">{connectionState(connection)}</p> : null}</div>
            <div className="agent-assistant__actions"><Button size="sm" tone="ghost" onClick={() => { setSelected(connection.connectionId); setPage("configuration"); }}>管理</Button>{contextual ? <Button size="sm" tone="primary" onClick={() => useConnection(connection.connectionId)}>使用</Button> : null}</div>
          </li>)}</ul>}

        </> : page === "add" ? <AddConnectionForm contributions={contributions} onSaved={saved} /> : Config ? <div className="agent-assistant__configuration"><Config key={selected ?? kind} connectionId={selected ?? undefined} onSaved={saved} />{current && current.extensionId !== "local-agent" ? <ConnectionDiagnostics connection={current} /> : null}</div> : <p>当前环境未启用此连接的配置扩展。请在设置页由管理员启用后重试。</p>}
        </UiPortalScope></section>
        {generationVisited ? <section hidden={tab !== "generation"} data-ai-tab="generation"><UiPortalScope>{settingsStore ? <Suspense fallback={<p>正在读取 Provider 配置…</p>}><GenerationProviders store={settingsStore} compact /></Suspense> : <p>当前环境未提供 Provider 配置服务。</p>}</UiPortalScope></section> : null}
        {tab === "mcp" ? <McpConnectionPanel canvasId={payload.canvasId} /> : null}
      </DialogBody>
    </UiPortalScope>
  </Dialog.Content>;
}

function AddConnectionForm({ contributions, onSaved }: {
  contributions: ReadonlyArray<{ kind: string; render: ComponentType<{ connectionId?: string; onSaved?: (connectionId: string) => void }> }>;
  onSaved: (connectionId: string) => void;
}) {
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  return <div className="agent-assistant__add">
    <div className="agent-assistant__methods">{kinds.map(item => {
      const available = contributions.some(entry => entry.kind === item.id);
      return <button key={item.id} type="button" className="agent-assistant__method" data-kind={item.id} data-selected={selectedKind === item.id} disabled={!available}
        onClick={() => { setSelectedKind(item.id); setVisited(current => current.includes(item.id) ? current : [...current, item.id]); }}>
        <strong>{item.label}</strong>
        <span className="agent-assistant__brands">{item.services.map(service => <span className="service-identity" key={service.id}><ServiceLogo service={service.id} size={18} />{service.name}</span>)}</span>
        <span className="agent-assistant__method-description">{available ? item.detail : "当前环境未启用"}</span>
      </button>;
    })}</div>
    <div className="agent-assistant__forms">{visited.map(id => {
      const Entry = contributions.find(entry => entry.kind === id)?.render;
      // Keep the instance and its portal container together under the hidden owner.
      return <div key={id} data-form-kind={id} hidden={selectedKind !== id} className="agent-assistant__add-form">
        <UiPortalScope>{Entry ? <Entry onSaved={onSaved} /> : <p>当前环境未启用此连接的配置扩展。</p>}</UiPortalScope>
      </div>;
    })}</div>
  </div>;
}

function ConnectionDiagnostics({ connection }: { connection: AgentConnectionView }) {
  return <details className="agent-assistant__diagnostics"><summary>连接诊断</summary><dl><div><dt>运行位置</dt><dd>本机宿主</dd></div>{Object.entries(connection.status).map(([name, evidence]) => <div key={name}><dt>{({ transport: "连接", credential: connection.authMode === "api-key" ? "API Key" : "认证", modelAccess: "模型访问", tools: "目标工具" } as Record<string, string>)[name]}</dt><dd>{name === "credential" && connection.authMode === "api-key" && evidence.state === "ready" ? "已保存（模型权限待验证）" : evidence.reason ?? ({ unknown: "待验证", ready: "检查通过", unavailable: "不可用", failed: "检查失败", pending: "检查中", unsupported: "不支持" }[evidence.state])}</dd></div>)}</dl>{connection.runtime ? <p>{connection.runtime.engine} · {connection.runtime.engineVersion}</p> : null}</details>;
}
