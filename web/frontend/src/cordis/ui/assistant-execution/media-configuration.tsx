import { useEffect, useState, useSyncExternalStore } from "react";
import { GenerationModelDirectory } from "@woohaa3/ui/assistant";
import type { CanvasTaskCatalogModel, ServiceConnectionView } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { readRecentGeneration, subscribeRecentGeneration, generationIdentity } from "../../services/assistant-execution/recent.js";

function unavailable(connection: ServiceConnectionView): string | undefined {
  return connection.removed ? "服务连接已移除" : !connection.enabled ? "服务连接已停用" :
    !connection.credentialConfigured ? "服务连接尚未配置凭据" : undefined;
}
/** Media Provider/modelKey identities stay distinct from assistant connection/model identities. */
export function MediaConfiguration(props: {
  models: readonly CanvasTaskCatalogModel[]; modelKey: string; sourceId: string; space: string; purpose: string;
  service?: AgentConversationService; disabled: boolean;
  onSelect(modelKey: string, sourceId: string): void; onManage?(): void; onValidation?(reason: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, retry] = useState(0);
  const [connections, setConnections] = useState<ServiceConnectionView[]>([]);
  const [loading, setLoading] = useState(!!props.service);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setConnections([]); setLoading(!!props.service); setError("");
    void props.service?.listServiceConnections?.().then(result => {
      if (!current) return;
      if (result.ok) setConnections(result.value); else setError(result.error);
    }).catch(() => { if (current) setError("服务连接读取失败，请重试"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [props.service, props.space, attempt]);
  const selectedConnection = connections.find(c => c.serviceConnectionId === props.sourceId);
  const validation = !props.sourceId ? "" : loading ? "正在读取服务连接" : error ||
    (!selectedConnection ? "原服务连接已失效，请重新选择" : unavailable(selectedConnection) ||
      (!selectedConnection.bindings.some(b => b.consumer === "provider" && b.modelKeys.includes(props.modelKey)) ? "原服务连接不支持当前模型" : ""));
  useEffect(() => { props.onValidation?.(validation); }, [validation]);
  useEffect(() => { setOpen(false); }, [props.space, props.purpose]);
  const recent = useSyncExternalStore(subscribeRecentGeneration,
    () => readRecentGeneration(props.space, props.purpose), () => readRecentGeneration(props.space, props.purpose));
  const entries = props.models.flatMap(model => {
    const configured = connections.filter(c => c.scope === "personal" && c.bindings.some(b => b.consumer === "provider" && b.modelKeys.includes(model.modelKey)));
    const sources = [{ id: model.providerId, label: model.providerId, reason: undefined as string | undefined },
      ...configured.map(c => ({ id: c.serviceConnectionId, label: c.name, reason: unavailable(c) }))];
    return sources.map(source => ({ identity: generationIdentity(source.id, model.modelKey), sourceIdentity: source.id,
      sourceLabel: source.label, modelIdentity: model.modelKey, modelId: model.providerModelId,
      label: model.title || model.providerModelId, detail: model.modelKey, unavailableReason: source.reason }));
  });
  const sources = [...new Map(entries.map(e => [e.sourceIdentity, { identity: e.sourceIdentity, label: e.sourceLabel, status: "ready" as const }])).values()];
  const source = props.sourceId || props.models.find(model => model.modelKey === props.modelKey)?.providerId || "";
  return <GenerationModelDirectory entries={entries} sources={sources} recent={recent}
    selected={generationIdentity(source, props.modelKey)} placeholder={validation || props.modelKey}
    loading={loading} error={error} onRetryAll={() => retry(v => v + 1)} open={open} onOpenChange={setOpen}
    disabled={props.disabled} onManage={props.onManage}
    onSelect={entry => props.onSelect(entry.modelIdentity, connections.some(c => c.serviceConnectionId === entry.sourceIdentity) ? entry.sourceIdentity : "")} />;
}
