import type { CanvasRenderScene, PreparedModelResource } from "@woohaa3/contracts";

export type ModelRenderIssue = {
  nodeId: string;
  title: string;
  message: string;
  detail: string;
  retainedPreview: boolean;
};

/**
 * 模型资源的失败隔离与提示
 * （change: optimize-model-scene-snapshot-hot-path；change: 2026-10-23-scale-canvas-media-residency
 * 拆出「声明失败」与「payload 准备失败」两类记录）。
 *
 * descriptor 声明失败会让该节点的模型引用失效（回退上一帧合法引用并提示）；payload 准备失败
 * 只在当前需求下记录，节点保留卡片与合法缓存图，内容变化或显式重试后再准备。
 */
export class ModelResourceFailures {
  private readonly failed = new Map<string, { resource: PreparedModelResource | undefined; detail: string }>();
  private issues: readonly ModelRenderIssue[] = [];
  private readonly listeners = new Set<() => void>();
  /** 失败集合的变更版本：`setScene` 据此决定是否需要为「本帧新失败」重新投影一次。 */
  private changeVersion = 0;
  /** 最近一次投影后的节点（用于在场景未重提时立即刷新提示）。 */
  private lastNodes: CanvasRenderScene["nodes"] = [];
  private lastPrevious: ReadonlyMap<string, CanvasRenderScene["nodes"][number]> = new Map();

  getSnapshot = (): readonly ModelRenderIssue[] => this.issues;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  retry = (): void => {
    if (!this.failed.size) return;
    this.failed.clear();
    this.changeVersion += 1;
  };

  /** 该模型的当前失败是否已经记录（同内容不重复尝试准备）。 */
  isFailed(key: string, resource: PreparedModelResource | undefined): boolean {
    const cached = this.failed.get(key);
    return !!cached && cached.resource === resource;
  }

  /** 失败集合的变更版本（成功/失败/清除都会递增）。 */
  version(): number {
    return this.changeVersion;
  }

  /**
   * 记录一次 payload 准备失败（不改变已提交场景的模型引用）。
   *
   * 用于 lease 变化触发的补准备：失败节点保留卡片与合法缓存图，只在内容变化或显式重试后
   * 重新准备（design D5 / 任务 5.5）。
   */
  fail(key: string, resource: PreparedModelResource | undefined, detail: string): void {
    if (this.isFailed(key, resource)) return;
    this.failed.set(key, { resource, detail });
    this.changeVersion += 1;
    this.publish();
  }

  /** 清除某 key 的失败记录（成功准备/内容变化）。 */
  clear(key: string): void {
    if (!this.failed.delete(key)) return;
    this.changeVersion += 1;
    this.publish();
  }

  project(
    scene: CanvasRenderScene,
    resources: ReadonlyMap<string, PreparedModelResource>,
    previousScene: CanvasRenderScene | null,
    register: (resource: PreparedModelResource) => void
  ): CanvasRenderScene {
    const previous = new Map(previousScene?.nodes.map((node) => [node.id, node]) ?? []);
    const activeKeys = new Set<string>();
    const nodes = scene.nodes.map((node) => {
      const key = node.model?.resourceKey;
      if (!key) return node;
      activeKeys.add(key);
      const resource = resources.get(key);
      if (!this.isFailed(key, resource)) {
        try {
          if (!resource) throw new Error(`未知模型资源 ${key}`);
          register(resource);
          if (this.failed.delete(key)) this.changeVersion += 1;
        } catch (error) {
          this.failed.set(key, { resource, detail: error instanceof Error ? error.message : String(error) });
          this.changeVersion += 1;
        }
      }
      const failure = this.failed.get(key);
      if (!failure) return node;
      const retained = previous.get(node.id);
      return { ...node, model: retained?.model, compositeAsset: retained?.model ? retained.compositeAsset : node.compositeAsset };
    });
    for (const key of this.failed.keys()) if (!activeKeys.has(key)) this.failed.delete(key);
    // 提示按**原始**场景引用统计：失败节点已被替换成上一帧合法引用（可能没有 model），
    // 用替换后的节点会漏掉提示。
    this.lastNodes = scene.nodes;
    this.lastPrevious = previous;
    this.refresh();
    return this.issues.length ? { ...scene, nodes } : scene;
  }

  /** 按最近一次投影的节点重建提示集合（只报告仍被场景引用的失败）。 */
  private publish(): void {
    this.refresh();
  }

  private refresh(): void {
    const issues: ModelRenderIssue[] = [];
    for (const node of this.lastNodes) {
      const key = node.model?.resourceKey;
      if (!key) continue;
      const failure = this.failed.get(key);
      if (!failure) continue;
      const retained = this.lastPrevious.get(node.id);
      issues.push({
        nodeId: node.id,
        title: node.title || "未命名模型",
        message: resourceFailureMessage(failure.detail),
        detail: failure.detail,
        retainedPreview: retained?.model !== undefined
      });
    }
    if (JSON.stringify(issues) === JSON.stringify(this.issues)) return;
    this.issues = issues;
    for (const listener of this.listeners) listener();
  }
}

export function resourceFailureMessage(detail: string): string {
  if (/payload too large/i.test(detail)) return "模型数据超过预览容量，请简化模型或减少片场内容。";
  if (/memory|allocation/i.test(detail)) return "模型预览所需内存不足，请减少模型复杂度。";
  if (/未知模型资源|unknown model resource/i.test(detail)) return "模型预览资源尚未就绪，可以重试加载。";
  return "模型预览加载失败，可以重试或修改模型。";
}
