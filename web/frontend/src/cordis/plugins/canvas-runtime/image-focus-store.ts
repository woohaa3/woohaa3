/**
 * Canvas Runtime 的图片聚焦瞬时态持有器
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只持浏览器本地图片聚焦投影、有效目标集合与聚焦纹理；不写规范状态。
 */
export class ImageFocusStore {
  private details:import("./focus-details.js").ImageFocusDetails|null=null;
  setDetails=(frame:import("./focus-details.js").ImageFocusDetails|null):void=>{this.details=frame;};
  getDetails=():import("./focus-details.js").ImageFocusDetails|null=>this.details;
  private viewportTarget: import("../../focus/types.js").FocusViewportTarget | null = null;

  registerViewportTarget(target: import("../../focus/types.js").FocusViewportTarget): () => void {
    this.viewportTarget = target;
    return () => { if (this.viewportTarget === target) this.viewportTarget = null; };
  }

  getViewportTarget = (): import("../../focus/types.js").FocusViewportTarget | null => this.viewportTarget;

  private projection: import("@woohaa3/contracts").BevyImageFocus | null = null;
  private targets: readonly string[] = [];
  private targetId: string | null = null;
  private texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null = null;
  private readonly listeners = new Set<() => void>();

  get(): import("@woohaa3/contracts").BevyImageFocus | null {
    return this.projection;
  }

  getTargetId(): string | null {
    return this.targetId;
  }

  setTargetId(nodeId: string | null): void {
    this.targetId = nodeId;
  }

  setTargets(nodeIds: readonly string[]): void {
    this.targets = [...nodeIds];
  }

  isTargetValid(nodeId: string): boolean {
    return this.targets.includes(nodeId);
  }

  set(projection: import("@woohaa3/contracts").BevyImageFocus | null): void {
    this.projection = projection;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setTexture(texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null): void {
    this.texture = texture;
  }

  getTexture(): { nodeId: string; width: number; height: number; pixels: Uint8Array } | null {
    return this.texture;
  }
}
