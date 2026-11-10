import { AssistantConfiguration, ReasoningParameters } from "../../ui/assistant-execution/configuration.js";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentConnectionBinding, AgentReasoningEffort } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../../services/current-user.js";
import { agentDirectory } from "../../services/agent-directory.js";
import { agentDirectoryModels, agentModelSelection } from "./agent-model-selection.js";
import { ASSISTANT_SETUP_HINT } from "@woohaa3/ui/assistant";
import { AssistantToolbar } from "@woohaa3/ui/assistant";

export type AssistantConnectionSelection = { connection: AgentConnectionBinding; model?: string; reasoningEffort?: AgentReasoningEffort };

/** Shared assistant directory and model rules, also used by extension-owned composers. */
export function AssistantConnectionPicker(props: {
  service: AgentConversationService;
  currentUser: CurrentUserService;
  value: AssistantConnectionSelection | null;
  /** Reset transient configuration when a mounted picker is reused for another target. */
  draftIdentity?: string;
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
  const [notice, setNotice] = useState("");
  const scope = JSON.stringify([namespace, props.draftIdentity ?? "picker"]);
  const efforts = useRef<{ scope: string; values: Record<string, AgentReasoningEffort | ""> }>({ scope, values: {} });
  if (efforts.current.scope !== scope) efforts.current = { scope, values: {} };
  const effortKey = (connectionId: string, model?: string) => JSON.stringify([connectionId, model ?? ""]);
  if (props.value) efforts.current.values[effortKey(props.value.connection.connectionId, props.value.model)] = props.value.reasoningEffort ?? "";
  useEffect(() => { setSelector(null); setNotice(""); }, [scope]);
  useEffect(() => { if (namespace && !state.ready) void directory.load(); }, [directory, namespace, state.ready]);
  const value = props.value;
  const emptyDirectory = state.ready && !state.loadingMessage && !state.error && !state.connections.length;
  const connection = state.connections.find(c => c.connectionId === value?.connection.connectionId);
  const models = agentDirectoryModels(connection?.models, connection ? state.catalogs[connection.adapterId]?.models : undefined);
  const toolDefault = connection?.authMode === "local-login";
  const selection = agentModelSelection(models, value?.model ?? "", value?.reasoningEffort ?? "", !toolDefault);
  const changed = Boolean(connection && value && (connection.adapterId !== value.connection.adapterId || connection.configRevision !== value.connection.configRevision || connection.credentialEpoch !== value.connection.credentialEpoch));
  const reason = !namespace ? "正在确认当前数据空间" : !state.ready ? state.loadingMessage || state.error || "正在读取助手…" : emptyDirectory ? ASSISTANT_SETUP_HINT : !connection ? "请选择助手连接" : changed ? "助手连接已更新，请重新选择" : !connection.ready ? connection.reason ?? "助手尚未就绪" : selection.missingRequiredModel ? "请选择助手模型" : selection.invalidModel ? "原模型已失效，请重新选择" : selection.invalidEffort ? "原思考强度 已失效，请重新选择" : "";
  const valid = Boolean(namespace && state.ready && !reason);
  useEffect(() => { props.onValidityChange(valid); }, [valid, props.onValidityChange]);
  return <AssistantToolbar disabled={props.disabled} refreshing={Boolean(state.loadingMessage)}
    onRefresh={() => void directory.load(true)} onManage={props.onManage} submit={props.submit}
    assistant={<AssistantConfiguration service={props.service} connectionId={value?.connection.connectionId ?? ""} model={value?.model ?? ""} purpose="world" open={selector === "assistant"} onOpenChange={open => setSelector(open ? "assistant" : null)} disabled={props.disabled || !namespace} onManage={props.onManage}
      onSelect={(c, model) => {
        const saved = efforts.current.values[effortKey(c.connectionId, model)];
        const options = agentDirectoryModels(c.models, state.catalogs[c.adapterId]?.models).find(m => m.id === model)?.reasoningEfforts ?? [];
        setNotice(value?.reasoningEffort && !options.includes(value.reasoningEffort) && !saved ? "新模型不支持原思考强度，已恢复默认" : "");
        props.onChange({ connection: { connectionId: c.connectionId, adapterId: c.adapterId, configRevision: c.configRevision, credentialEpoch: c.credentialEpoch }, ...(model ? { model } : {}), ...(saved && options.includes(saved) ? { reasoningEffort: saved } : {}) });
      }} />}
    parameters={<ReasoningParameters value={value?.reasoningEffort ?? ""} options={selection.supportedEfforts} open={selector === "model"} onOpenChange={open => setSelector(open ? "model" : null)} disabled={props.disabled} onChange={effort => { if (value) props.onChange({ ...value, reasoningEffort: effort ? effort as AgentReasoningEffort : undefined }); }} />}
    notice={!props.compact && (reason || state.error || connection?.modelsError || notice) ? <p className="mc-panel__notice">{reason || state.error || connection?.modelsError || notice}</p> : null} />;
}
