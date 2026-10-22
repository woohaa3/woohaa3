import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentConnectionBinding, AgentReasoningEffort } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../../services/current-user.js";
import { agentDirectory } from "../../services/agent-directory.js";
import { agentDirectoryModels, agentModelSelection } from "./agent-model-selection.js";
import { ModelSelector } from "./execution-panel/model-selector.js";
import { Button } from "../../../shared/ui/Button.js";
import "./assistant-connection-picker.css";

export type AssistantConnectionSelection = { connection: AgentConnectionBinding; model?: string; reasoningEffort?: AgentReasoningEffort };

/** Shared assistant directory and model rules, also used by extension-owned composers. */
export function AssistantConnectionPicker(props: {
  service: AgentConversationService;
  currentUser: CurrentUserService;
  value: AssistantConnectionSelection | null;
  disabled?: boolean;
  /** 执行中的冻结选择，只显示工具栏，不再次提供配置操作或校验提示。 */
  compact?: boolean;
  onChange(value: AssistantConnectionSelection): void;
  onValidityChange(valid: boolean): void;
  onManage(): void;
}) {
  const user = useSyncExternalStore(props.currentUser.subscribe, props.currentUser.getSnapshot, props.currentUser.getSnapshot);
  const namespace = user?.dataScopeId;
  const directory = agentDirectory(props.service, namespace ?? "unresolved");
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const [selector, setSelector] = useState<"assistant" | "model" | null>(null);
  useEffect(() => { if (namespace && !state.ready) void directory.load(); }, [directory, namespace, state.ready]);
  const value = props.value;
  const connection = state.connections.find(c => c.connectionId === value?.connection.connectionId);
  const models = agentDirectoryModels(connection?.models, connection ? state.catalogs[connection.adapterId]?.models : undefined);
  const toolDefault = connection?.authMode === "local-login";
  const selection = agentModelSelection(models, value?.model ?? "", value?.reasoningEffort ?? "", !toolDefault);
  const changed = Boolean(connection && value && (connection.adapterId !== value.connection.adapterId || connection.configRevision !== value.connection.configRevision || connection.credentialEpoch !== value.connection.credentialEpoch));
  const reason = !namespace ? "正在确认当前数据空间" : !state.ready ? state.loadingMessage || state.error || "正在读取助手…" : !connection ? "请选择助手连接" : changed ? "助手连接已更新，请重新选择" : !connection.ready ? connection.reason ?? "助手尚未就绪" : selection.missingRequiredModel ? "请选择助手模型" : selection.invalidModel ? "原模型已失效，请重新选择" : selection.invalidEffort ? "原 Variant 已失效，请重新选择" : "";
  const valid = Boolean(namespace && state.ready && !reason);
  useEffect(() => { props.onValidityChange(valid); }, [valid, props.onValidityChange]);
  const choose = (connectionId: string) => {
    const c = state.connections.find(c => c.connectionId === connectionId);
    if (c) props.onChange({ connection: { connectionId: c.connectionId, adapterId: c.adapterId, configRevision: c.configRevision, credentialEpoch: c.credentialEpoch } });
  };
  return <div className={`assistant-connection-picker${props.compact ? " assistant-connection-picker--compact" : ""}`}>
    <div className="assistant-connection-picker__controls">
      <ModelSelector label="选择助手" model={value?.connection.connectionId ?? ""} placeholder={state.loadingMessage ? "正在读取助手…" : "选择助手"}
        open={selector === "assistant"} onOpenChange={open => setSelector(open ? "assistant" : null)} onManage={props.onManage}
        disabled={props.disabled || !namespace || !state.ready} options={state.connections.map(c => ({ value: c.connectionId, label: c.name, detail: c.reason }))} onChange={choose} />
      {(props.compact && value || connection && (!toolDefault || models.length > 0)) ? <ModelSelector label="选择助手模型" model={value?.model ?? ""}
        keepOpenOnModelSelect
        open={selector === "model"} onOpenChange={open => setSelector(open ? "model" : null)} disabled={props.disabled || changed}
        options={[...(toolDefault || props.compact ? [{ value: "", label: "使用助手默认模型" }] : []), ...models.map(m => ({ value: m.id, label: m.label }))]}
        onChange={model => { if (value) props.onChange({ connection: value.connection, ...(model ? { model } : {}) }); }}
        variant={(selection.supportedEfforts.length || props.compact && value?.reasoningEffort) && value ? { value: value.reasoningEffort ?? "", options: [{ value: "", label: "默认 Variant" }, ...Array.from(new Set([...selection.supportedEfforts, ...(props.compact && value.reasoningEffort ? [value.reasoningEffort] : [])])).map(value => ({ value, label: value }))], onChange: effort => props.onChange({ connection: value.connection, ...(value.model ? { model: value.model } : {}), ...(effort ? { reasoningEffort: effort as AgentReasoningEffort } : {}) }) } : undefined} /> : null}
    </div>
    {!props.compact && (reason || state.error || connection?.modelsError) ? <p className="mc-panel__notice">{reason || state.error || connection?.modelsError}</p> : null}
    {!props.compact ? <div className="assistant-connection-picker__controls">
      <Button size="sm" tone="neutral" disabled={props.disabled || Boolean(state.loadingMessage)} onClick={() => void directory.load(true)}>刷新助手</Button>
      <Button size="sm" tone="neutral" disabled={props.disabled} onClick={props.onManage}>管理助手</Button>
    </div> : null}
  </div>;
}
