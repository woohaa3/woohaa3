import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FilmSetConversionModelCandidate, FilmSetConversionSettings, FilmSetConversionSourceKind, AgentReasoningEffort } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { agentDirectoryModels, agentModelSelection, readAssistantPreference, rememberAssistantPreference } from "../../services/assistant-execution/selection.js";
import { AssistantModelSelector, AssistantConnectionSelector, ASSISTANT_SETUP_HINT } from "./model-selector.js";

/** Same owner directory as ordinary authoring; unsupported delivery capabilities remain visible. */
export function AssistantDeliverySelection({ service, candidates, sourceKind, value, disabled, onChange, onValidityChange, onManage }: {
  service: AgentConversationService; candidates: readonly FilmSetConversionModelCandidate[]; sourceKind: FilmSetConversionSourceKind;
  value: FilmSetConversionSettings; disabled: boolean; onChange(value: FilmSetConversionSettings): void;
  onValidityChange(valid: boolean): void; onManage?: () => void;
}) {
  const directory = agentDirectory(service, service.getDataScopeId?.() ?? "page");
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const [open, setOpen] = useState<"assistant" | "model" | null>(null);
  useEffect(() => { void directory.load(); }, [directory]);
  const scope = service.getDataScopeId?.() ?? "page";
  const initialized = useRef(false);
  useEffect(() => {
    if (!snapshot.ready || initialized.current) return;
    initialized.current = true;
    if (value.connection) return;
    const preference = readAssistantPreference(scope);
    const connection = snapshot.connections.find(c => c.connectionId === preference?.connectionId);
    if (!connection || !preference) return;
    onChange({ ...value, connection: { connectionId: connection.connectionId, adapterId: connection.adapterId, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch },
      modelKey: preference.model ? `${connection.adapterId}:${preference.model}` : undefined, reasoningEffort: preference.reasoningEffort || undefined });
  }, [snapshot.ready, snapshot.connections, scope, value, onChange]);
  const change = (next: FilmSetConversionSettings) => {
    if (next.connection) rememberAssistantPreference(scope, { sourceId: next.connection.adapterId, connectionId: next.connection.connectionId,
      model: next.modelKey?.startsWith(`${next.connection.adapterId}:`) ? next.modelKey.slice(next.connection.adapterId.length + 1) : undefined, reasoningEffort: next.reasoningEffort });
    onChange(next);
  };
  const connection = snapshot.connections.find(candidate => candidate.connectionId === value.connection?.connectionId);
  const emptyDirectory = snapshot.ready && !snapshot.loadingMessage && !snapshot.error && !snapshot.connections.length;
  const catalog = connection ? snapshot.catalogs[connection.adapterId] : undefined;
  // Registered candidate ports advertise delivery-specific vision/schema support; ordinary
  // discussion attachment capabilities may differ for the same owner connection.
  const nativeCandidate = (adapterId: string) => sourceKind !== "model3d" && snapshot.catalogs[adapterId]?.capabilities?.candidateGeneration?.imageInput === true;
  const supports = (adapterId: string) => nativeCandidate(adapterId) || candidates.some(candidate => candidate.assistant?.adapterId === adapterId && candidate.supports.includes(sourceKind));
  const models = agentDirectoryModels(connection?.models, catalog?.models);
  const prefix = `${connection?.adapterId}:`;
  const model = candidates.find(candidate => candidate.modelKey === value.modelKey)?.assistant?.model
    ?? (connection && nativeCandidate(connection.adapterId) && value.modelKey?.startsWith(prefix) ? value.modelKey.slice(prefix.length) : "");
  const selection = agentModelSelection(models, model, value.reasoningEffort ?? "", true);
  const matching = (id: string) => candidates.find(candidate => candidate.assistant && candidate.assistant.adapterId === connection?.adapterId && candidate.assistant.model === id && candidate.supports.includes(sourceKind))
    ?? (connection && nativeCandidate(connection.adapterId) && models.some(model => model.id === id) ? { modelKey: `${connection.adapterId}:${id}` } : undefined);
  const reason = emptyDirectory ? ASSISTANT_SETUP_HINT : !connection ? "请选择助手连接" : !connection.ready ? connection.reason ?? "助手尚未就绪"
    : !supports(connection.adapterId) ? "此助手暂不支持从素材创建片场"
    : value.connection?.configRevision !== connection.configRevision || value.connection?.credentialEpoch !== connection.credentialEpoch ? "助手连接版本已变更，请重新选择"
    : selection.invalidModel || selection.missingRequiredModel || !matching(model) ? "请选择支持此素材的助手模型"
    : selection.invalidEffort ? "原 Variant 已失效，请重新选择" : "";
  const valid = snapshot.ready && !reason;
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);
  return <>
    <AssistantConnectionSelector empty={emptyDirectory} loading={Boolean(snapshot.loadingMessage)} model={value.connection?.connectionId ?? ""} options={snapshot.connections.map(connection => ({ value: connection.connectionId, label: connection.name,
      detail: !supports(connection.adapterId) ? "此助手暂不支持从素材创建片场" : connection.reason ?? undefined,
      disabled: !supports(connection.adapterId) }))}
      open={open === "assistant"} onOpenChange={value => setOpen(value ? "assistant" : null)} disabled={disabled || Boolean(snapshot.loadingMessage)} onManage={onManage}
      onChange={id => { const connection = snapshot.connections.find(candidate => candidate.connectionId === id); if (connection) change({ ...value,
        connection: { connectionId: id, adapterId: connection.adapterId, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch }, modelKey: undefined, reasoningEffort: undefined }); }} />
    {connection ? <AssistantModelSelector label="选择助手模型" model={model} options={models.map(model => ({ value: model.id, label: model.label, disabled: !matching(model.id) }))}
      open={open === "model"} onOpenChange={value => setOpen(value ? "model" : null)} disabled={disabled || !connection} keepOpenOnModelSelect
      onChange={model => change({ ...value, modelKey: matching(model)?.modelKey, reasoningEffort: undefined })}
      variant={selection.supportedEfforts.length ? { value: value.reasoningEffort ?? "", options: [{ value: "", label: "默认 Variant" }, ...selection.supportedEfforts.map(value => ({ value, label: value }))],
        onChange: effort => change({ ...value, reasoningEffort: effort ? effort as AgentReasoningEffort : undefined }) } : undefined} /> : null}
    {snapshot.loadingMessage || reason || snapshot.error ? <p className={`${emptyDirectory ? "" : "authoring-generate__reason "}assistant-creation-controls__notice`}>{snapshot.loadingMessage || snapshot.error || reason}</p> : null}
  </>;
}
