import type { CanvasRenderScene } from "@woohaa3/contracts";

/** 一次资源加载的身份；换源后旧身份不能结束新资源的加载提示。 */
export type NodeResourceLoad = { readonly nodeId: string; readonly source: string; loading: boolean };
export type NodeResourceLoadingReader = { isLoading?(nodeId: string): boolean };

/** 图片解码、视频首帧/缓冲和模型准备共用的浏览器加载状态，不写规范画布。 */
export class NodeResourceLoading {
  private readonly loads = new Map<string, NodeResourceLoad>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onChange?: () => void) {}

  track(nodeId: string, source: string): NodeResourceLoad {
    const previous = this.loads.get(nodeId);
    if (previous?.source === source) return previous;
    const load = { nodeId, source, loading: true };
    this.loads.set(nodeId, load);
    this.emit();
    return load;
  }

  setLoading(load: NodeResourceLoad, loading: boolean): void {
    if (this.loads.get(load.nodeId) !== load || load.loading === loading) return;
    load.loading = loading;
    this.emit();
  }

  remove(load: NodeResourceLoad): void {
    if (this.loads.get(load.nodeId) !== load) return;
    this.loads.delete(load.nodeId);
    this.emit();
  }

  retain(sources: ReadonlyMap<string, string>): void {
    for (const load of this.loads.values()) {
      if (sources.get(load.nodeId) !== load.source) this.remove(load);
    }
  }

  isLoading = (nodeId: string): boolean => this.loads.get(nodeId)?.loading ?? false;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  clear(): void {
    if (!this.loads.size) return;
    this.loads.clear();
    this.emit();
  }
  private emit(): void {
    this.onChange?.();
    for (const listener of this.listeners) listener();
  }
}

/** 三种资源统一投影为 mediaLoading，复用 Bevy 的加载环与文案。 */
export function applyNodeResourceLoading(
  scene: CanvasRenderScene,
  readers: Partial<Record<"image" | "video" | "model", NodeResourceLoadingReader | null>>
): void {
  for (const node of scene.nodes) {
    const reader = readers[node.type as keyof typeof readers];
    if (!node.busy && reader?.isLoading?.(node.id)) node.mediaLoading = true;
  }
}
