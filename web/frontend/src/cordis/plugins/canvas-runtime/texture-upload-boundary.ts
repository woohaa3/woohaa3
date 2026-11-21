import { isNativeImage } from "./image-worker/native-port.js";
import { BEVY_TEXTURE_MAX_DIMENSION } from "./media-raster.js";
import { errorDetail, type RuntimeIssues } from "./runtime-issues.js";

export type TextureUploadSource = { sourceKey: string; nodeId?: string; preserveFailure?: boolean; scope?: import('./canvas-scope.js').CanvasScope };

/** Cache rejected source/quality until content changes or the user retries. */
export class TextureUploadBoundary {
  private readonly failed = new Map<string, string>();
  private readonly uploaded = new Set<string>();
  private readonly pendingIdentity = new Map<string,string>();
  private readonly appliedIdentity = new Map<string,string>();
  private readonly sharedUploaded = new Set<string>();
  private readonly pixelIds = new WeakMap<object, number>();
  private nextPixelId = 0;
  constructor(private readonly issues: RuntimeIssues) {}

  reset = (): void => { this.failed.clear(); this.uploaded.clear(); this.pendingIdentity.clear(); this.appliedIdentity.clear(); this.sharedUploaded.clear(); };
  retry = (): void => { this.failed.clear(); this.sharedUploaded.clear(); };
  upload(channel: "node" | "plane", id: string, width: number, height: number, pixels: import("@woohaa3/contracts").ImagePixelSource,
    invoke: (alreadyShared: boolean) => void, source?: TextureUploadSource): boolean {
    const key = `texture:${channel}:${id}`;
    let sourceKey = source?.sourceKey;
    if (!sourceKey) {
      let pixelId = this.pixelIds.get(pixels);
      if (pixelId === undefined) { pixelId = ++this.nextPixelId; this.pixelIds.set(pixels, pixelId); }
      sourceKey = String(pixelId);
    }
    const identity = `${sourceKey}:${width}:${height}`;
    if (this.failed.get(key) === identity) return false;
    const sharedKey = channel === "node" && source?.sourceKey
      ? `${source.scope?.token ?? ""}\u0000${source.sourceKey}\u0000${width}x${height}`
      : null;
    const alreadyShared = sharedKey !== null && this.sharedUploaded.has(sharedKey);
    try {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > BEVY_TEXTURE_MAX_DIMENSION || height > BEVY_TEXTURE_MAX_DIMENSION
        || (isNativeImage(pixels) ? pixels.width !== width || pixels.height !== height : pixels.length !== width * height * 4)) throw new Error(`Invalid texture (${width}×${height})`);
      this.appliedIdentity.delete(key);
      this.pendingIdentity.set(key,identity);
      invoke(alreadyShared);
      if (sharedKey !== null) this.sharedUploaded.add(sharedKey);
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
  acceptReceipts(json:string): void {
    const rows:unknown=JSON.parse(json);
    if(!Array.isArray(rows))throw new Error("Invalid texture receipt batch");
    for(const row of rows) {
      if(!Array.isArray(row) || row.length!==5)continue;
      const [channel,id,width,height,content]=row;
      if((channel!=="node" && channel!=="plane") || typeof id!=="string" || typeof content!=="string")continue;
      const key=`texture:${channel}:${id}`;
      const identity=`${content}:${width}:${height}`;
      // Plane producers have no stable content key in their Rust inbox; a new submission clears the prior receipt.
      if(channel==='plane' || this.pendingIdentity.get(key)===identity)this.appliedIdentity.set(key,this.pendingIdentity.get(key)??identity);
    }
  }
  applied(channel:"node"|"plane",id:string,width:number,height:number,content:string):boolean {
    return this.appliedIdentity.get(`texture:${channel}:${id}`)===`${content}:${width}:${height}`;
  }
  retain(nodeIds: ReadonlySet<string>, planeIds: ReadonlySet<string>): void {
    if (nodeIds.size === 0) this.sharedUploaded.clear();
    for (const key of new Set([...this.failed.keys(), ...this.uploaded])) {
      const isNode = key.startsWith("texture:node:");
      const id = key.slice(isNode ? "texture:node:".length : "texture:plane:".length);
      if (!(isNode ? nodeIds : planeIds).has(id)) {
        this.failed.delete(key); this.uploaded.delete(key); this.pendingIdentity.delete(key); this.appliedIdentity.delete(key); this.issues.clear(key);
      }
    }
  }
}
