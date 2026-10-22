/**
 * Model Execution Host 的受控 draft store 与模型选择
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1 / design D4 / D8）。
 *
 * Host 是 `{ nodeId, modelKey }` 草稿的 owner：Panel 只通过 `patchDraft` 写、`draft` 读，
 * 拿不到 raw store。draft 只保存**未提交**输入；已提交状态仍由规范 Canvas 派生。
 *
 * 每个节点还有一个 session-only 的 `selectedModelKey`，用于在切换模型时定位到目标草稿分区；
 * 它不是规范状态，刷新即丢弃（模型最终身份仍由 Host 固定并写入 canonical）。
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
