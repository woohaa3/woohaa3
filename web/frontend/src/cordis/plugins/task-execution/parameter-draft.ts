/**
 * ModelExecutionHost 的草稿写入辅助（change: 2026-10-09-improve-canvas-workflow，任务 1.6）。
 *
 * 把「参数手势记录 + 草稿分区路由」从 host 组件抽出，保持 host 在文件体积守卫内。
 * 纯逻辑：只读写注入的 draft store，不触碰规范状态。
 */
import type { ModelDraftStore } from "./model-draft.js";

export type ParameterGestureInput = {
  nodeId: string;
  modelKey: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  apply: (values: Record<string, unknown>) => void;
};

export type ParameterGestureSink = (input: ParameterGestureInput) => void;

/**
 * 写入一次参数变更：先落草稿分区，再把「手势前值/当前值」交给页面编辑历史。
 */
export function applyParameterDraft(input: {
  draftStore: ModelDraftStore;
  nodeId: string;
  modelKey: string;
  values: Record<string, unknown>;
  onGesture?: ParameterGestureSink;
}): boolean {
  const { draftStore, nodeId, modelKey, values } = input;
  if (!input.onGesture) return false;
  const before = { ...(draftStore.get(nodeId, modelKey).parameters ?? {}) };
  draftStore.patch(nodeId, modelKey, { parameters: values });
  const after = { ...(draftStore.get(nodeId, modelKey).parameters ?? {}) };
  input.onGesture({
    nodeId,
    modelKey,
    before,
    after,
    apply: (next) => draftStore.patch(nodeId, modelKey, { parameters: next })
  });
  return true;
}
