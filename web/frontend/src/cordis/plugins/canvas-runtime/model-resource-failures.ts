import type { CanvasRenderScene, PreparedModelResource } from "@woohaa3/contracts";

export type ModelRenderIssue = {
  nodeId: string;
  title: string;
  message: string;
  detail: string;
  retainedPreview: boolean;
};

/** Isolate immutable resource failures from the canvas and retry only on request/content changes. */
export class ModelResourceFailures {
  private readonly failed = new Map<string, { resource: PreparedModelResource | undefined; detail: string }>();
  private issues: readonly ModelRenderIssue[] = [];
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): readonly ModelRenderIssue[] => this.issues;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  retry = (): void => { this.failed.clear(); };

  project(
    scene: CanvasRenderScene,
    resources: ReadonlyMap<string, PreparedModelResource>,
    previousScene: CanvasRenderScene | null,
    register: (resource: PreparedModelResource) => void
  ): CanvasRenderScene {
    const previous = new Map(previousScene?.nodes.map((node) => [node.id, node]) ?? []);
    const issues: ModelRenderIssue[] = [];
    const activeKeys = new Set<string>();
    const nodes = scene.nodes.map((node) => {
      const key = node.model?.resourceKey;
      if (!key) return node;
      activeKeys.add(key);
      const resource = resources.get(key);
      const cached = this.failed.get(key);
      if (!cached || cached.resource !== resource) {
        try {
          if (!resource) throw new Error(`未知模型资源 ${key}`);
          register(resource);
          this.failed.delete(key);
        } catch (error) {
          this.failed.set(key, { resource, detail: error instanceof Error ? error.message : String(error) });
        }
      }
      const failure = this.failed.get(key);
      if (!failure) return node;
      const retained = previous.get(node.id);
      issues.push({
        nodeId: node.id,
        title: node.title || "未命名模型",
        message: resourceFailureMessage(failure.detail),
        detail: failure.detail,
        retainedPreview: retained?.model !== undefined
      });
      return { ...node, model: retained?.model, compositeAsset: retained?.model ? retained.compositeAsset : node.compositeAsset };
    });
    for (const key of this.failed.keys()) if (!activeKeys.has(key)) this.failed.delete(key);
    if (JSON.stringify(issues) !== JSON.stringify(this.issues)) {
      this.issues = issues;
      for (const listener of this.listeners) listener();
    }
    return issues.length ? { ...scene, nodes } : scene;
  }
}

export function resourceFailureMessage(detail: string): string {
  if (/payload too large/i.test(detail)) return "模型数据超过预览容量，请简化模型或减少片场内容。";
  if (/memory|allocation/i.test(detail)) return "模型预览所需内存不足，请减少模型复杂度。";
  if (/未知模型资源|unknown model resource/i.test(detail)) return "模型预览资源尚未就绪，可以重试加载。";
  return "模型预览加载失败，可以重试或修改模型。";
}
