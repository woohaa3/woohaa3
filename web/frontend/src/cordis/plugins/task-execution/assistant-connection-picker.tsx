import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentConnectionBinding, AgentReasoningEffort } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../../services/current-user.js";
import { agentDirectory } from "../../services/agent-directory.js";
import { agentDirectoryModels, agentModelSelection } from "./agent-model-selection.js";
import { ModelSelector } from "./execution-panel/model-selector.js";
import { AssistantConnectionSelector, ASSISTANT_SETUP_HINT } from "../../ui/assistant-execution/model-selector.js";
import { AssistantToolbar } from "../../ui/assistant-execution/toolbar.js";

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
  submit?: ReactNode;
}) {
  const user = useSyncExternalStore(props.currentUser.subscribe, props.currentUser.getSnapshot, props.currentUser.getSnapshot);
  const namespace = user?.dataScopeId;
  const directory = agentDirectory(props.service, namespace ?? "unresolved");
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const [selector, setSelector] = useState<"assistant" | "model" | null>(null);
  useEffect(() => { if (namespace && !state.ready) void directory.load(); }, [directory, namespace, state.ready]);
  const value = props.value;
  const emptyDirectory = state.ready && !state.loadingMessage && !state.error && !state.connections.length;
  const connection = state.connections.find(c => c.connectionId === value?.connection.connectionId);
  const models = agentDirectoryModels(connection?.models, connection ? state.catalogs[connection.adapterId]?.models : undefined);
  const toolDefault = connection?.authMode === "local-login";
  const selection = agentModelSelection(models, value?.model ?? "", value?.reasoningEffort ?? "", !toolDefault);
  const changed = Boolean(connection && value && (connection.adapterId !== value.connection.adapterId || connection.configRevision !== value.connection.configRevision || connection.credentialEpoch !== value.connection.credentialEpoch));
  const reason = !namespace ? "正在确认当前数据空间" : !state.ready ? state.loadingMessage || state.error || "正在读取助手…" : emptyDirectory ? ASSISTANT_SETUP_HINT : !connection ? "请选择助手连接" : changed ? "助手连接已更新，请重新选择" : !connection.ready ? connection.reason ?? "助手尚未就绪" : selection.missingRequiredModel ? "请选择助手模型" : selection.invalidModel ? "原模型已失效，请重新选择" : selection.invalidEffort ? "原 Variant 已失效，请重新选择" : "";
  const valid = Boolean(namespace && state.ready && !reason);
  useEffect(() => { props.onValidityChange(valid); }, [valid, props.onValidityChange]);
  const choose = (connectionId: string) => {
    const c = state.connections.find(c => c.connectionId === connectionId);
    if (c) props.onChange({ connection: { connectionId: c.connectionId, adapterId: c.adapterId, configRevision: c.configRevision, credentialEpoch: c.credentialEpoch } });
  };
  return <AssistantToolbar disabled={props.disabled} refreshing={Boolean(state.loadingMessage)}
    onRefresh={() => void directory.load(true)} onManage={props.onManage} submit={props.submit}
    assistant={
      <AssistantConnectionSelector empty={!props.compact && emptyDirectory} loading={Boolean(state.loadingMessage)} model={value?.connection.connectionId ?? ""}
        open={selector === "assistant"} onOpenChange={open => setSelector(open ? "assistant" : null)} onManage={props.onManage}
        disabled={props.disabled || !namespace || !state.ready} options={state.connections.map(c => ({ value: c.connectionId, label: c.name, detail: c.reason }))} onChange={choose} />}
    parameters={(props.compact && value || connection && (!toolDefault || models.length > 0)) ? <ModelSelector label="选择助手模型" model={value?.model ?? ""}
        keepOpenOnModelSelect
        open={selector === "model"} onOpenChange={open => setSelector(open ? "model" : null)} disabled={props.disabled || changed}
        options={[...(toolDefault || props.compact ? [{ value: "", label: "使用助手默认模型" }] : []), ...models.map(m => ({ value: m.id, label: m.label }))]}
        onChange={model => { if (value) props.onChange({ connection: value.connection, ...(model ? { model } : {}) }); }}
        variant={(selection.supportedEfforts.length || props.compact && value?.reasoningEffort) && value ? { value: value.reasoningEffort ?? "", options: [{ value: "", label: "默认 Variant" }, ...Array.from(new Set([...selection.supportedEfforts, ...(props.compact && value.reasoningEffort ? [value.reasoningEffort] : [])])).map(value => ({ value, label: value }))], onChange: effort => props.onChange({ connection: value.connection, ...(value.model ? { model: value.model } : {}), ...(effort ? { reasoningEffort: effort as AgentReasoningEffort } : {}) }) } : undefined} /> : undefined}
    notice={!props.compact && (reason || state.error || connection?.modelsError) ? <p className="mc-panel__notice">{reason || state.error || connection?.modelsError}</p> : null} />;
}
