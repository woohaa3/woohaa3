/**
 * 3D 参数瞬时预览存储
 * （change: replace-godot-canvas-runtime-with-bevy）。
 *
 * DOM 参数面板输入期间写入这里（不写规范状态）；`interaction-controller` 合成快照时合并。
 * 提交完成后**不清空**：保留预览直到服务端权威 `nodeData` 回流或超时，避免松手/完成瞬间闪回。
 */

/** 3D 模型摆放草稿（renderer-neutral；offset/scale/yaw）。 */
export type ModelPlacementDraft = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

/** 参数面板产生的一次瞬时/提交 patch。 */
export type ParameterPatch = {
  modelPlacement?: ModelPlacementDraft;
};

type Entry = { patch: ParameterPatch; deadline: number };

/** 预览在权威数据未回流时的最长保留时间。 */
export const PARAMETER_PREVIEW_TIMEOUT_MS = 4000;

class ParameterPreviewStore {
  private readonly previews = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  /** 记录预览；`deadline` 缺省为当前时间 + 超时。 */
  set(nodeId: string, patch: ParameterPatch, deadline = Date.now() + PARAMETER_PREVIEW_TIMEOUT_MS): void {
    this.previews.set(nodeId, { patch, deadline });
    this.emit();
  }

  get(nodeId: string): ParameterPatch | undefined {
    return this.previews.get(nodeId)?.patch;
  }

  /** 权威数据已回流或超时：丢弃该节点预览。 */
  resolve(nodeId: string): void {
    if (this.previews.delete(nodeId)) this.emit();
  }

  clearAll(): void {
    if (this.previews.size === 0) return;
    this.previews.clear();
    this.emit();
  }

  /** 当前预览；调用方按 `deadline` 与权威值决定是否 `resolve`。 */
  entries(): ReadonlyMap<string, Entry> {
    return this.previews;
  }

  subscribe = (listener: () => void): (() => void) => {
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
export const parameterPreviewStore = new ParameterPreviewStore();
