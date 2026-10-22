/**
 * 按 `{ nodeId, modelKey }` 隔离的未提交草稿
 * （change: add-image-text-node-execution，任务 3.4；
 *   change: 2026-09-29-add-pluggable-model-interactions，任务 4.1 / design D1 / D8）。
 *
 * 只保存**尚未提交**的输入（prompt、参数、模型专用临时状态）。点击执行后
 * prompt/parameters/active run 进入规范画布聚合，面板状态从 `nodeData`/`jobs` 派生 ——
 * 这里绝不保存任务状态，否则刷新后会出现「第二份规范状态」。
 *
 * 草稿按 `{ nodeId, modelKey }` 隔离；切换模型时 Host 显式沿用当前节点提示词，
 * 模型参数仍各自保留，避免 Seedance marker 模式与普通视频参数互相污染。
 * 节点被删除时其草稿由调用方清理。
 */
import type { ExecutionPanelRunSnapshot } from "../../ui/index.js";

export type NodeExecutionDraft = {
  prompt?: string;
  parameters?: Record<string, unknown>;
  /** 模型专用临时状态（如 Seedance 未确认 intents）；删除动作先落草稿，宿主可再提交权威命令。 */
  videoEditIntents?: readonly import("../../ui/index.js").ExecutionPanelVideoEditIntent[];
};

export type DraftListener = () => void;

/**
 * 草稿分区的内部哨兵：调用方未提供 `modelKey` 时使用。
 *
 * change: 2026-10-07-remove-residual-compatibility —— 这是 store 内部键的一部分，
 * 不再是跨分区读取的回退分区（调用方按 `{nodeId, modelKey}` 精确读取）。
 */
export const NO_MODEL_KEY = "*";

function keyOf(nodeId: string, modelKey: string | undefined): string {
  return `${nodeId}\u0000${modelKey && modelKey !== "" ? modelKey : NO_MODEL_KEY}`;
}

export class NodeDraftStore {
  private readonly drafts = new Map<string, NodeExecutionDraft>();
  private readonly listeners = new Set<DraftListener>();

  /** 返回稳定引用，`useSyncExternalStore` 依赖它判断是否需要重渲染。 */
  get = (nodeId: string | null | undefined, modelKey?: string): NodeExecutionDraft | undefined => {
    if (!nodeId) return undefined;
    return this.drafts.get(keyOf(nodeId, modelKey));
  };

  patch(nodeId: string, patch: NodeExecutionDraft, modelKey?: string): void {
    if (nodeId === "") return;
    const key = keyOf(nodeId, modelKey);
    const current = this.drafts.get(key) ?? {};
    const merged: NodeExecutionDraft = { ...current };
    // 忽略 undefined：面板的 `onChange` 只带变更的字段，把 undefined 写进去会
    // 把先前输入的 prompt 擦掉（随后回落到已提交值，表现为输入被重置）。
    if (patch.prompt !== undefined) merged.prompt = patch.prompt;
    if (patch.parameters !== undefined) merged.parameters = patch.parameters;
    if (patch.videoEditIntents !== undefined) merged.videoEditIntents = patch.videoEditIntents;
    this.drafts.set(key, merged);
    this.emit();
  }

  /** 用面板回调的提交快照填充草稿（保证「已提交的输入」也留在面板上）。 */
  applySnapshot(nodeId: string, snapshot: ExecutionPanelRunSnapshot, modelKey?: string): void {
    this.patch(nodeId, { prompt: snapshot.prompt, parameters: snapshot.parameters }, modelKey);
  }

  clear(nodeId: string, modelKey?: string): void {
    if (modelKey === undefined) {
      // 清理该节点的全部模型分区。
      let changed = false;
      for (const key of this.drafts.keys()) {
        if (key.startsWith(`${nodeId}\u0000`)) {
          this.drafts.delete(key);
          changed = true;
        }
      }
      if (changed) this.emit();
      return;
    }
    if (this.drafts.delete(keyOf(nodeId, modelKey))) this.emit();
  }

  /** 清掉所有已不存在于画布中的节点草稿。 */
  prune(existingNodeIds: ReadonlySet<string>): void {
    let changed = false;
    for (const key of this.drafts.keys()) {
      const nodeId = key.slice(0, key.indexOf("\u0000"));
      if (!existingNodeIds.has(nodeId)) {
        this.drafts.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  clearAll(): void {
    if (this.drafts.size === 0) return;
    this.drafts.clear();
    this.emit();
  }

  subscribe = (listener: DraftListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 页面级单例。 */
export const nodeDraftStore = new NodeDraftStore();
