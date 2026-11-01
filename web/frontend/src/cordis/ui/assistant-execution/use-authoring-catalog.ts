/**
 * 创作入口的模型目录读取（从 `authoring-composer.tsx` 的同名 `useEffect` 原样移出）。
 *
 * 移出原因只是 file-budget：`authoring-composer.tsx` 曾越过 800 物理行上限。这里只做
 * 「按 来源:连接 读一次模型目录并写回 catalog」，状态仍由调用方的 `useState` 持有。
 */
import { useEffect } from "react";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { readAgentCatalog } from "../../plugins/task-execution/agent-model-selection.js";

export type AuthoringCatalogState = {
  key: string;
  models: readonly AgentCatalogEntry[];
  loading: boolean;
  error?: string;
};

type AgentCatalogEntry = import("@woohaa3/contracts").AgentModelView;

export function useAuthoringCatalog(input: {
  service: AgentConversationService | undefined;
  sourceId: string | null | undefined;
  connectionId: string | null | undefined;
  modelKey: string;
  /** 连接自带的模型列表；非空时不再读目录。 */
  connectionModels: readonly unknown[] | undefined;
  /** 每次刷新 +1，用来强制重读。 */
  attempt: number;
  setCatalog: (update: (current: AuthoringCatalogState) => AuthoringCatalogState) => void;
}): void {
  const {
    service,
    sourceId,
    connectionId,
    modelKey,
    connectionModels,
    attempt,
    setCatalog
  } = input;
  const connectionModelsKey = JSON.stringify(connectionModels ?? null);
  useEffect(() => {
    if (
      (connectionModels?.length ?? 0) > 0 ||
      !service?.catalog ||
      !sourceId ||
      !connectionId
    )
      return;
    let cancelled = false;
    // 重读期间保留已加载的目录：瞬时失败或空响应不应把已经可用的大列表变成空列表，
    // 否则用户会看到「模型突然全部消失」，且同一次失败还会把当前选择判成已失效。
    setCatalog((current) =>
      current.key === modelKey
        ? { ...current, loading: true }
        : { key: modelKey, models: [], loading: true },
    );
    void readAgentCatalog(service, sourceId)
      .then((result) => {
        if (cancelled) return;
        setCatalog((current) => {
          const previous = current.key === modelKey ? current.models : [];
          const error = result.ok ? result.value.error : result.error;
          if (result.ok && result.value.models.length > 0)
            return {
              key: modelKey,
              models: result.value.models,
              loading: false,
              ...(error ? { error } : {}),
            };
          if (previous.length > 0)
            return {
              key: modelKey,
              models: previous,
              loading: false,
              ...(error ? { error } : {}),
            };
          return {
            key: modelKey,
            models: result.ok ? result.value.models : [],
            loading: false,
            ...(error ? { error } : {}),
          };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog((current) =>
          current.key === modelKey && current.models.length > 0
            ? { ...current, loading: false, error: "模型目录读取失败，请刷新连接。" }
            : { key: modelKey, models: [], loading: false, error: "模型目录读取失败，请刷新连接。" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [service, sourceId, connectionId, modelKey, connectionModelsKey, attempt]);
}
