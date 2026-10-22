/**
 * Canvas Runtime 的视频聚焦瞬时态持有器
 * （change: 2026-10-10-add-video-node-focus-workspace）。
 *
 * 只持浏览器本地视频聚焦投影、有效目标集合与聚焦纹理；不写规范状态。与 `ImageFocusStore`
 * 同构：图片/视频聚焦互斥，共用单一 Camera2d 与纹理覆盖通道。
 */
export class VideoFocusStore {
  private projection: import("@woohaa3/contracts").BevyVideoFocus | null = null;
  private targets: readonly string[] = [];
  private targetId: string | null = null;
  private texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null = null;
  private readonly listeners = new Set<() => void>();

  get(): import("@woohaa3/contracts").BevyVideoFocus | null {
    return this.projection;
  }

  getTargetId(): string | null {
    return this.targetId;
  }

  setTargetId(nodeId: string | null): void {
    this.targetId = nodeId;
    this.emit();
  }

  setTargets(nodeIds: readonly string[]): void {
    this.targets = [...nodeIds];
  }

  isTargetValid(nodeId: string): boolean {
    return this.targets.includes(nodeId);
  }

  set(projection: import("@woohaa3/contracts").BevyVideoFocus | null): void {
    this.projection = projection;
    this.emit();
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

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
