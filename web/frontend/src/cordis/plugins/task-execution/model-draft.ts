/**
 * Model Execution Host 的受控 draft store 与模型选择
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1 / design D4 / D8）。
 *
 * Host 是 `{ nodeId, modelKey }` 草稿的 owner：Panel 只通过 `patchDraft` 写、`draft` 读，
 * 拿不到 raw store。draft 只保存**未提交**输入；已提交状态仍由规范 Canvas 派生。
 *
 * 本地 selection 只在受控 preferredModelKey 写入确认前覆盖规范选择；
 * 未提交 prompt/参数继续仅属于各模型草稿分区。
 */
import type { ModelExecutionDraft, ModelExecutionDraftPatch } from "../../contract/model-interaction.js";
import { nodeDraftStore } from "../task-execution/drafts.js";

export type ModelDraftStore = {
  get(nodeId: string, modelKey: string): ModelExecutionDraft;
  patch(nodeId: string, modelKey: string, patch: ModelExecutionDraftPatch): void;
  persist(nodeId: string, modelKey: string, draft: ModelExecutionDraft): void;
  clear(nodeId: string, modelKey: string): void;
  getSelection(nodeId: string): string | null;
  setSelection(nodeId: string, modelKey: string): void;
  clearSelection(nodeId: string): void;
  subscribe(listener: () => void): () => void;
};

export function createModelDraftStore(): ModelDraftStore {
  const selected = new Map<string, string>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    get(nodeId, modelKey) {
      const existing = nodeDraftStore.get(nodeId, modelKey);
      return {
        prompt: typeof existing?.prompt === "string" ? existing.prompt : "",
        parameters: existing?.parameters ? { ...existing.parameters } : {}
      };
    },
    patch(nodeId, modelKey, patch) {
      nodeDraftStore.patch(
        nodeId,
        {
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
        },
        modelKey
      );
    },
    persist(nodeId, modelKey, draft) {
      nodeDraftStore.patch(nodeId, { prompt: draft.prompt, parameters: { ...draft.parameters } }, modelKey);
    },
    clear(nodeId, modelKey) {
      nodeDraftStore.clear(nodeId, modelKey);
    },
    getSelection(nodeId) {
      return selected.get(nodeId) ?? null;
    },
    setSelection(nodeId, modelKey) {
      if (modelKey === "") return;
      selected.set(nodeId, modelKey);
      emit();
    },
    clearSelection(nodeId) {
      if (selected.delete(nodeId)) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

const legacyClaims = new WeakMap<object, string>();
/** Read an explicitly identified legacy draft once. Ambiguous source identities are never inferred. */
export function migrateLegacyModelDraft(store: ModelDraftStore, input: { nodeId: string; modelKey: string; sourceId: string; target: string; partition: string }) {
  const legacy = nodeDraftStore.get(input.nodeId, input.modelKey);
  if (!legacy || (legacy.parameters?.model !== undefined && legacy.parameters.model !== input.modelKey)) return false;
  const source = typeof legacy.parameters?.serviceConnectionId === "string" ? legacy.parameters!.serviceConnectionId : "";
  if (source !== input.sourceId || legacyClaims.has(legacy)) return false;
  legacyClaims.set(legacy, input.target);
  store.patch(input.target, input.partition, legacy);
  return true;
}
