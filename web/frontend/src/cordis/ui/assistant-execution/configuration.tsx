import { useEffect, useSyncExternalStore } from "react";
import { GenerationModelDirectory } from "@woohaa3/ui/assistant";
import type { AgentConnectionView, GenerationModelEntry } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { agentDirectoryModels } from "../../services/assistant-execution/selection.js";
import { generationIdentity, readRecentGeneration, subscribeRecentGeneration } from "../../services/assistant-execution/recent.js";
export { ReasoningParameters } from "@woohaa3/ui/assistant";
/** All entry points share directory reads; execution/target authority stays with the supplied owner. */
export function AssistantConfiguration({ service, connectionId, model, purpose, open, onOpenChange, onSelect, onManage, disabled, reasonFor }: {
  service: AgentConversationService; connectionId: string; model: string; purpose: string;
  open: boolean; onOpenChange(open: boolean): void; onSelect(connection: AgentConnectionView, model: string): void;
  onManage?(): void; disabled?: boolean; reasonFor?(connection: AgentConnectionView, model: string): string | undefined;
}) {
  const space = service.getDataScopeId?.() ?? "page";
  const directory = agentDirectory(service, space);
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const recent = useSyncExternalStore(subscribeRecentGeneration, () => readRecentGeneration(space, purpose), () => readRecentGeneration(space, purpose));
  useEffect(() => { void directory.load(); }, [directory, open]);
  const entries: GenerationModelEntry[] = state.connections.flatMap(c => {
    const models = agentDirectoryModels(c.models, state.catalogs[c.adapterId]?.models);
    const options = [...(c.authMode === "local-login" && purpose !== "text" ? [{ id: "", label: "使用助手默认模型" }] : []), ...models];
    return options.map(m => ({ identity: generationIdentity(c.connectionId, m.id), sourceIdentity: c.connectionId, modelIdentity: m.id, modelId: m.id, label: m.label, sourceLabel: c.name, detail: `${c.adapterId} · ${c.connectionId}`, isDefault: !m.id,
      unavailableReason: reasonFor?.(c, m.id) || (!c.ready ? c.reason || "助手尚未就绪" : undefined) || (!(c.models?.length ?? 0) && state.sourceStates?.[c.adapterId]?.status === "failed" && !!m.id ? "目录读取失败，请重试" : undefined) }));
  });
  return <GenerationModelDirectory entries={entries} sources={state.connections.map(c => ({ identity: c.connectionId, label: c.name,
    status: (c.models?.length ?? 0) ? "ready" : state.sourceStates?.[c.adapterId]?.status ?? "unloaded", error: state.sourceStates?.[c.adapterId]?.error ?? c.modelsError }))}
    loading={!state.ready && !!state.loadingMessage} error={!state.connections.length ? state.error : undefined} onRetryAll={() => void directory.load(true)}
    placeholder={connectionId ? `${model || "使用助手默认模型"} · ${state.connections.find(c => c.connectionId === connectionId)?.name || connectionId}` : "来源与模型"}
    selected={generationIdentity(connectionId, model)} open={open} onOpenChange={onOpenChange} disabled={disabled}
    onSelect={e => { const c = state.connections.find(c => c.connectionId === e.sourceIdentity); if (c) onSelect(c, e.modelIdentity); }}
    onManage={onManage} onRetry={id => { const c = state.connections.find(c => c.connectionId === id); if (c) void directory.retry(c.adapterId); }} recent={recent} />;
}
