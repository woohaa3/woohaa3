import { useCallback, useEffect, useRef, useState } from "react";
import type { McpInstallClient, McpInstallTarget } from "@woohaa3/contracts";
import { createMcpInstallationRemote, type McpInstallationRemote } from "../../services/mcp-installation-remote.js";
import { Button, CheckIcon, IconButton, McpClientLogo, SettingsFeedback, Tooltip } from "../../../shared/ui/index.js";
import { mcpInstallation } from "../../mcp-installation.js";
import { resolveModelMcpServerUrl } from "../../mcp-endpoint.js";
import { mcpCanvasPrompt } from "../../mcp-hint.js";

const GROUP_LABEL: Record<McpInstallClient["group"], string> = { cli: "命令行", editor: "编辑器" };

type TargetRef = { client: McpInstallClient; target: McpInstallTarget };

/** 多目标客户端（DeepSeek Harness 的 profile）在提示里带上目标名，单目标只显示客户端名。 */
const targetTitle = ({ client, target }: TargetRef) =>
  client.targets.length > 1 ? `${client.label} — ${target.label}` : client.label;

export function McpConnectionPanel({ canvasId, remote: injectedRemote }: { canvasId?: string; remote?: McpInstallationRemote }) {
  const [remote] = useState(() => injectedRemote ?? createMcpInstallationRemote());
  const [clients, setClients] = useState<McpInstallClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 安装失败不放进宫格提示里单独藏着：异常原因在宫格下方就近列出，便于不悬停也能看到。 */
  const [issues, setIssues] = useState<Record<string, string>>({});
  /** 最近一次安装成功的目标：宫格只用图标标识，结果反馈仍需要不悬停可见。 */
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const serverUrl = resolveModelMcpServerUrl();
  const installation = mcpInstallation(serverUrl);
  const context = JSON.stringify([serverUrl, canvasId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    setIssues({});
    setNotice(null);
    void remote.detect().then(result => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error); return; }
      setClients(result.value.clients);
      const found: Record<string, string> = {};
      for (const client of result.value.clients) for (const target of client.targets) {
        if (target.error) found[`${client.id}:${target.key}`] = target.error;
      }
      setIssues(found);
    }).catch(() => { if (!cancelled) setError("客户端检测失败，请重试。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [remote, revision]);
  const report = useCallback((key: string, message: string | null) => setIssues(current => {
    if (!message) {
      if (!(key in current)) return current;
      const next = { ...current }; delete next[key]; return next;
    }
    return current[key] === message ? current : { ...current, [key]: message };
  }), []);
  return <section className="agent-assistant__mcp" data-ai-tab="mcp">
    <div>
      <div className="agent-assistant__navigation"><h3>安装到本机客户端</h3><Button size="sm" tone="ghost" disabled={loading} onClick={() => refresh(value => value + 1)}>重新检测</Button></div>
      <p>自动配置应用宿主机器上的客户端。悬停图标查看名称、配置位置与状态，点击即写入。</p>
      {loading ? <p>正在检测客户端…</p> : error ? <SettingsFeedback tone="danger">{error}</SettingsFeedback> : clients.length ? <div className="agent-assistant__mcp-groups">
        {(["cli", "editor"] as const).map(group => {
          const members = clients.filter(client => client.group === group);
          return members.length ? <section key={group} className="agent-assistant__mcp-group" data-mcp-group={group}>
            <h4>{GROUP_LABEL[group]}</h4>
            <div className="agent-assistant__mcp-grid">
              {members.flatMap(client => client.targets.map(target => <InstallTarget
                key={`${revision}:${client.id}:${target.key}`}
                client={client}
                target={target}
                remote={remote}
                reported={issues[`${client.id}:${target.key}`] !== undefined}
                onIssue={message => report(`${client.id}:${target.key}`, message)}
                onInstalled={message => setNotice(message)}
              />))}
            </div>
          </section> : null;
        })}
        {notice ? <SettingsFeedback tone="success">{notice}</SettingsFeedback> : null}
        {Object.entries(issues).filter(([, message]) => message).map(([key, message]) => <SettingsFeedback key={key} tone="danger">
          <span className="agent-assistant__mcp-issue-target">{issueTarget(key, clients)}</span>{message}
        </SettingsFeedback>)}
      </div> : <p>未检测到受支持的客户端。安装客户端后可重新检测。</p>}
    </div>
    <details>
      <summary>手动安装到其他设备或客户端</summary>
      <p>{installation.instructions}</p>
      <CopyGuidance key={`install:${context}`} content={installation.content} action={installation.action} success="已复制；请在客户端完成安装。" />
    </details>
    {canvasId ? <div>
      <h3>操作当前画布</h3>
      <CopyGuidance key={`canvas:${context}`} content={mcpCanvasPrompt(canvasId)} action="复制画布指引" success="已复制；请交给客户端中的助手。" />
    </div> : null}
  </section>;
}

/** 失败行前缀：`clientId:targetKey` 还原成「客户端 — 目标」的可读名。 */
function issueTarget(key: string, clients: McpInstallClient[]) {
  const [id, targetKey] = key.split(":");
  const client = clients.find(item => item.id === id);
  const target = client?.targets.find(item => item.key === targetKey);
  if (!client || !target) return `${key}：`;
  return `${targetTitle({ client, target })}：`;
}

/**
 * 一个安装目标是一个图标格：客户端身份由品牌图形表达，名称、配置位置与状态只放在悬停提示里。
 * 已安装的格子带对勾角标并禁用重复点击；失败时格子显示危险色边框，点击即重试。
 */
function InstallTarget({ client, target, remote, reported, onIssue, onInstalled }: TargetRef & {
  remote: McpInstallationRemote;
  /** 该目标的错误已列在宫格下方，提示里不重复。 */
  reported: boolean;
  onIssue: (message: string | null) => void;
  onInstalled: (message: string) => void;
}) {
  const [installed, setInstalled] = useState(target.configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(target.error ?? null);
  const [hint, setHint] = useState(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const install = async () => {
    if (inFlight.current || installed) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const result = await remote.install(client.id, target.key);
      if (!active.current) return;
      if (!result.ok) { setError(result.error); onIssue(result.error); return; }
      const updated = result.value.client.targets.find(item => item.key === target.key);
      setInstalled(updated?.configured ?? result.value.client.configured);
      if (updated?.error) { setError(updated.error); onIssue(updated.error); }
      else { setError(null); onIssue(null); onInstalled(`${targetTitle({ client, target })}：配置已写入，重新打开客户端后使用。`); }
    } catch { if (active.current) { const message = "安装失败，请检查客户端配置后重试。"; setError(message); onIssue(message); } }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const title = targetTitle({ client, target });
  const state = error ? "error" : installed ? "installed" : "ready";
  const status = busy ? "正在安装…" : error ? (reported ? "安装失败，原因见下方说明。" : error) : installed ? "配置已写入，重新打开客户端后使用。" : "点击安装";
  return <Tooltip
    open={hint}
    onOpenChange={setHint}
    side="top"
    className="agent-assistant__mcp-tooltip"
    content={<span className="agent-assistant__mcp-hint">
      <strong>{title}</strong>
      <span className="agent-assistant__config-path">{target.path}</span>
      <span data-tone={error ? "error" : installed ? "installed" : "ready"}>{status}</span>
    </span>}
  >
    {/* 子元素的 data-state 覆盖 Radix Trigger 的开关态，用于表达安装状态。 */}
    <span
      className="agent-assistant__mcp-tile"
      data-state={state}
      data-mcp-target={`${client.id}:${target.key}`}
      onPointerEnter={() => setHint(true)}
      onPointerLeave={() => setHint(false)}
      onFocus={() => setHint(true)}
      onBlur={() => setHint(false)}
    >
      <IconButton
        className="agent-assistant__mcp-tile-button"
        label={title}
        size="md"
        tone="ghost"
        disabled={busy || installed}
        onClick={() => void install()}
      >
        <McpClientLogo client={client.id} size={28} />
      </IconButton>
      {installed ? <CheckIcon className="agent-assistant__mcp-badge" size={12} /> : null}
    </span>
  </Tooltip>;
}

function CopyGuidance({ content, action, success }: { content: string; action: string; success: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const copy = async () => {
    const current = ++request.current;
    setState("copying");
    try {
      await navigator.clipboard.writeText(content);
      if (current === request.current) setState("copied");
    } catch {
      if (current === request.current) setState("failed");
    }
  };
  return <div className="agent-assistant__mcp-field">
    <code>{content}</code>
    <Button size="sm" disabled={state === "copying"} onClick={() => void copy()}>{action}</Button>
    {state === "copied" ? <p>{success}</p> : state === "failed" ? <SettingsFeedback tone="danger">复制失败，请手动选择并复制内容，或点击按钮重试。</SettingsFeedback> : null}
  </div>;
}
