import { BEVY_TEXTURE_MAX_DIMENSION } from "./media-raster.js";
import { errorDetail, type RuntimeIssues } from "./runtime-issues.js";

export type TextureUploadSource = { sourceKey: string; nodeId?: string; preserveFailure?: boolean };

/** Cache rejected source/quality until content changes or the user retries. */
export class TextureUploadBoundary {
  private readonly failed = new Map<string, string>();
  private readonly uploaded = new Set<string>();
  private readonly pixelIds = new WeakMap<Uint8Array, number>();
  private nextPixelId = 0;
  constructor(private readonly issues: RuntimeIssues) {}

  reset = (): void => { this.failed.clear(); this.uploaded.clear(); };
  retry = (): void => { this.failed.clear(); };
  upload(channel: "node" | "plane", id: string, width: number, height: number, pixels: Uint8Array,
    invoke: () => void, source?: TextureUploadSource): boolean {
    const key = `texture:${channel}:${id}`;
    let sourceKey = source?.sourceKey;
    if (!sourceKey) {
      let pixelId = this.pixelIds.get(pixels);
      if (pixelId === undefined) { pixelId = ++this.nextPixelId; this.pixelIds.set(pixels, pixelId); }
      sourceKey = String(pixelId);
    }
    const identity = `${sourceKey}:${width}:${height}`;
    if (this.failed.get(key) === identity) return false;
    try {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > BEVY_TEXTURE_MAX_DIMENSION || height > BEVY_TEXTURE_MAX_DIMENSION
        || pixels.length !== width * height * 4) throw new Error(`Invalid texture (${width}×${height}, ${pixels.length} bytes)`);
      invoke();
      this.uploaded.add(key);
      // A lower-quality fallback must not erase the failed focus-source issue.
      if (!source?.preserveFailure) {
        this.failed.delete(key);
        this.issues.clear(key);
      }
      return true;
    } catch (error) {
      this.failed.set(key, identity);
      this.issues.report({ key, scope: "texture", operation: channel === "node" ? "set_texture" : "set_model_media_texture",
        nodeId: source?.nodeId ?? (channel === "node" ? id : undefined),
        message: "媒体预览上传失败，可以重试或更换素材。", detail: errorDetail(error),
        recoverable: true, retainedPreview: this.uploaded.has(key) });
      return false;
    }
  }
  retain(nodeIds: ReadonlySet<string>, planeIds: ReadonlySet<string>): void {
    for (const key of new Set([...this.failed.keys(), ...this.uploaded])) {
      const isNode = key.startsWith("texture:node:");
      const id = key.slice(isNode ? "texture:node:".length : "texture:plane:".length);
      if (!(isNode ? nodeIds : planeIds).has(id)) {
        this.failed.delete(key); this.uploaded.delete(key); this.issues.clear(key);
      }
    }
  }
}
