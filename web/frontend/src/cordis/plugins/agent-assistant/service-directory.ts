import { useEffect, useState } from "react";
import type { ServiceConnectionDirectory, ServiceConnectionView } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";

/** One read model supplies the overview, source list and diagnostics. */
export function useServiceDirectory(service: AgentConversationService, revision: number) {
  const [directory, setDirectory] = useState<ServiceConnectionDirectory | null>(null);
  const [loading, setLoading] = useState(Boolean(service.serviceConnectionDirectory || service.listServiceConnections));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = service.serviceConnectionDirectory
      ? service.serviceConnectionDirectory()
      : service.listServiceConnections?.().then(result => result.ok
        ? { ok: true as const, value: { connections: result.value, providers: [], duplicates: [] } }
        : result);
    if (!read) return;
    setLoading(true);
    void read.then(result => {
      if (!active) return;
      if (result.ok) { setDirectory(result.value); setError(null); }
      else setError(result.error);
    }).catch(() => { if (active) setError("模型提供商读取失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [service, revision]);
  return { directory, loading, error };
}

export function serviceSourceState(source: ServiceConnectionView) {
  if (source.removed) return { label: "已移除", tone: "warning" } as const;
  if (!source.enabled) return { label: "已停用", tone: "warning" } as const;
  if (!source.credentialConfigured) return { label: source.kind === "oauth" ? "待授权" : "待配置密钥", tone: "warning" } as const;
  // A saved secret and capability projection are not an upstream connectivity test.
  return { label: "已配置", tone: "neutral" } as const;
}
