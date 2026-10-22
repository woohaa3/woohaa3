import { submitPhotocraftTexture } from "../../performance/photocraft-performance.js";
import { beginLifecycleSpan, measureLifecycle } from "../../performance/lifecycle-performance.js";
/**
 * 节点媒体纹理同步（change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 移植 `xyflow-bevy/web/media-renderer.js`：把**图片**像素上传给 Bevy
 * （`set_texture(nodeId, w, h, rgba)`），供节点卡内的 Sprite 显示。纹理尺寸保持图片自身
 * 宽高比（不填充、不裁剪），因此节点内容框 contain 后媒体必然顶住某一轴的两条边。
 *
 * - 只读取稳定资产（`assets` 中 status: ready 的 image）；
 * - 按 nodeId 缓存 URL，URL 变化才重新解码；上传一次后标记 sent；
 * - 迟到回调防护：解码完成时若该 nodeId 已被替换/移除则丢弃。
 *
 * 视频节点（change: enable-video-node-live-preview）的纹理**不由这里负责**：真实解码帧与
 * poster 回退都由 `video-frame-session.ts` 的浏览器视频会话上传，避免图片路径把视频 URL
 * 当图片解码（旧实现会失败或只显示封面）。
 */
import { MediaOperationBoundary } from "./media-operation-boundary.js";
import { errorDetail } from "./runtime-issues.js";
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import type { BevyRuntime } from "./bevy-runtime.js";
import { rasterizeDrawable, defaultRasterCanvasFactory, type RasterCanvasFactory } from "./media-raster.js";
import { NodeResourceLoading, type NodeResourceLoad } from "../../services/node-resource-loading.js";
import { appPublicUrl } from "../../services/app-base-path.js";
import { withMediaCanvasHint } from "../../services/paths.js";

/**
 * 纹理最长边上限（像素）。纹理尺寸**保持图片自身宽高比**（不填充、不裁剪），
 * 因此 Bevy 侧 contain 后图片必然顶住内容框的某一轴边缘、无多余边距。
 */
export const TEXTURE_MAX_DIMENSION = 1024;

export type TextureSyncOptions = {
  runtime: BevyRuntime;
  getCanvas: () => ServerCanvas | null;
  /**
   * 额外的 nodeId → 本地预览 URL（上传中的幽灵节点）。
   * 与规范资产一样走同一解码/上传路径，使 ghost 卡片内能显示本地图片。
   */
  getPreviewUrls?: () => ReadonlyMap<string, string>;
  getFocusTexture?: () => { nodeId: string; width: number; height: number; pixels: Uint8Array } | null;
  getFocusDetails?:()=>import("./focus-details.js").ImageFocusDetails|null;
  /** 解码函数：URL → 图像；测试可注入。 */
  loadImage?: (url: string) => Promise<HTMLImageElement>;
  /** 帧 canvas 工厂：测试可注入。 */
  createCanvas?: RasterCanvasFactory;
  /** 变化后的回调（触发一次 scene flush）。 */
  onChange?: () => void;
};

export type TextureUploader = {
  /** 按当前画布同步纹理（幂等：已上传的不重复）。 */
  sync(): void;
  /** 上传完成的节点 id 集合（用于 mapper 的 texture 标记，可选）。 */
  textureNodeIds(): ReadonlySet<string>;
  isLoading?(nodeId: string): boolean;
  dispose(): void;
};

type Entry = {
  url: string;
  load: NodeResourceLoad;
  ready: boolean;
  failed?: boolean;
  sent: boolean;
  pixels?: Uint8Array;
  /** 纹理像素尺寸（=图片自身比例缩放到上限内），供上传使用。 */
  width?: number;
  height?: number;
};

export function createTextureSync(options: TextureSyncOptions): TextureUploader {
  const loadImage = options.loadImage ?? loadImageViaDom;
  const createCanvas = options.createCanvas ?? defaultRasterCanvasFactory;
  /** nodeId → { url, ready, sent }。 */
  const entries = new Map<string, Entry>();
  const loading = new NodeResourceLoading(options.onChange, "image-prepare");
  const uploads = new MediaOperationBoundary(options.runtime);
  const uploaded = new Set<string>();
  let runtimeGeneration = options.runtime.generation?.() ?? 0;
  let retryVersion = options.runtime.retryVersion?.() ?? 0;
  let disposed = false;
  let overrideUploaded = false;
  let previousOverride: ReturnType<NonNullable<TextureSyncOptions["getFocusTexture"]>> = null;
  let previousDetails:import("./focus-details.js").ImageFocusDetails|null|undefined;

  const desiredUrls = (canvas: ServerCanvas): Map<string, string> => {
    const assets = new Map<string, StoredAsset>(canvas.assets.map((asset) => [asset.id, asset]));
    const nodeData = canvas.nodeData as Record<string, { outputAssetId?: unknown } | undefined>;
    const desired = new Map<string, string>();
    for (const node of canvas.document.nodes) {
      // 只处理图片节点；视频画面由 video-frame-session 负责（design D1/D2）。
      if (node.type !== "image") continue;
      const outputId = nodeData[node.id]?.outputAssetId;
      if (typeof outputId !== "string") continue;
      const asset = assets.get(outputId);
      if (!asset || asset.status !== "ready") continue;
      // asset.url 是应用逻辑受控路径（`/api/media/<storageKey>`）；DOM/解码出口在此加一次公开
      // 前缀，并带上本画布的读提示（`?canvas=<id>`），让宿主按画布路由到远端存储。
      const url = asset.url ? appPublicUrl(withMediaCanvasHint(asset.url, canvas.id)) : "";
      if (!url) continue;
      desired.set(node.id, url);
    }
    // 上传中的幽灵节点：本地预览 URL（object URL），同样走解码/上传；真实节点出现后覆盖它。
    const previews = options.getPreviewUrls?.();
    if (previews) {
      for (const [nodeId, url] of previews) desired.set(nodeId, url);
    }
    return desired;
  };

  return {
    sync() {
      if (disposed) return;
      const canvas = options.getCanvas();
      if (!canvas) {
        entries.clear();
        uploaded.clear();
        previousOverride = null;
        loading.clear();
        return;
      }
      const desired = desiredUrls(canvas);
      loading.retain(desired);
      uploads.retainNodes(new Set(desired.keys()));
      const nextGeneration = options.runtime.generation?.() ?? 0;
      if (nextGeneration !== runtimeGeneration) {
        runtimeGeneration = nextGeneration;
        uploaded.clear(); previousOverride = null;
        previousDetails=undefined;
        for (const entry of entries.values()) entry.sent = false;
      }
      const retry = options.runtime.retryVersion?.() ?? 0;
      if (retry !== retryVersion) {
        retryVersion = retry;
        for (const [id, entry] of entries) if (entry.failed) entries.delete(id);
        previousOverride = null;
        previousDetails=undefined;
      }
      for (const id of uploaded) if (!desired.has(id)) uploaded.delete(id);
      const override = options.getFocusTexture?.() ?? null;
      if (previousOverride && previousOverride !== override) {
        uploads.clear(`focus:${previousOverride.nodeId}`);
        const original = entries.get(previousOverride.nodeId);
        if (original) original.sent = false;
      }
      // 移除不再需要的节点纹理缓存。
      for (const [id, entry] of entries) {
        if (desired.get(id) !== entry.url) {
          entries.delete(id);
          uploads.clear(`image:${id}`);
          options.runtime.clearRuntimeIssue?.(`decode:image:${id}`);
        }
      }
      let changed = false;
      for (const [id, url] of desired) {
        if (entries.has(id)) continue;
        const entry: Entry = { url, load: loading.track(id, url), ready: false, sent: false };
        entries.set(id, entry);
        loading.setLoading(entry.load, true);
        void measureLifecycle("image-load-decode", () => loadImage(url))
          .then((image) => {
            if (disposed || entries.get(id) !== entry) return;
            const endRaster = beginLifecycleSpan("image-raster");
            let raster;
            try {
              raster = rasterize(image, createCanvas);
              if (!raster) throw new Error("图片预览无法读取像素");
              endRaster();
            } catch (error) { endRaster("error"); throw error; }
            entry.pixels = raster.pixels;
            entry.width = raster.width;
            entry.height = raster.height;
            entry.ready = true;
            options.runtime.clearRuntimeIssue?.(`decode:image:${id}`);
            changed = true;
            options.onChange?.();
          })
          .catch(error => {
            if (!disposed && entries.get(id) === entry) {
              entry.failed = true;
              loading.setLoading(entry.load, false, "error");
              options.runtime.reportRuntimeIssue?.({ key: `decode:image:${id}`, scope: "texture", operation: "decode-image",
                nodeId: id, message: "图片预览加载失败，可以重试或更换素材。", detail: errorDetail(error),
                recoverable: true, retainedPreview: uploaded.has(id) });
            }
          });
      }
      if (override && override !== previousOverride) {
        const accepted = uploads.run(`focus:${override.nodeId}`, override, override.nodeId,
          () => submitPhotocraftTexture(override.pixels, () => options.runtime.setTexture(override.nodeId, override.width, override.height, override.pixels)) !== false);
        overrideUploaded = !!accepted;
        if (accepted) {
          const original = entries.get(override.nodeId);
          if (original) loading.setLoading(original.load, false);
          uploaded.add(override.nodeId); changed = true;
        }
      }
      if (!override) overrideUploaded = false;
      const details=options.getFocusDetails?.()??null;
      if(details!==previousDetails) {
        const nodeId=details?.nodeId??previousDetails?.nodeId??"";
        const accepted=uploads.run(`focus-details:${nodeId}`,details,nodeId,()=>{
          if(details) {
            if(!options.runtime.setImageFocusDetails)throw new Error("画布内核缺少图片细节纹理接口");
            try {options.runtime.setImageFocusDetails(details);}
            catch(error){options.runtime.setImageFocusDetails(null);throw error;}
          } else options.runtime.setImageFocusDetails?.(null);
          return true;
        });
        previousDetails=details;
        if(accepted!==true)details?.onUploadFailure?.();
      }
      // A failed focus upgrade still allows the card to upload once decoding finishes.
      for (const [id, entry] of entries) {
        if ((id === override?.nodeId && overrideUploaded) || !entry.ready || entry.sent || !entry.pixels || !entry.width || !entry.height) continue;
        const endSubmit = beginLifecycleSpan("image-submit");
        const accepted = uploads.run(`image:${id}`, entry, id,
          () => options.runtime.setTexture(id, entry.width!, entry.height!, entry.pixels!,
            { sourceKey: entry.url, preserveFailure: id === override?.nodeId }) !== false);
        endSubmit(accepted ? "ok" : "error");
        loading.setLoading(entry.load, false, accepted ? "ok" : "error");
        if (accepted) { entry.sent = true; uploaded.add(id); changed = true; }
      }
      previousOverride = override;
      if (changed) options.onChange?.();
    },
    textureNodeIds() {
      return new Set(uploaded);
    },
    isLoading: loading.isLoading,
    dispose() {
      disposed = true;
      uploads.run("focus-details:dispose",null,previousDetails?.nodeId??"",()=>options.runtime.setImageFocusDetails?.(null));
      previousDetails=null;
      uploads.retainNodes(new Set());
      for (const id of entries.keys()) options.runtime.clearRuntimeIssue?.(`decode:image:${id}`);
      entries.clear();
      uploaded.clear();
      loading.clear();
    }
  };
}


/**
 * 把图片按**自身宽高比**缩放到最长边 `TEXTURE_MAX_DIMENSION` 内并取 RGBA。
 *
 * 关键：纹理尺寸 = 图片自身尺寸（等比缩放），**不填充、不裁剪**。这样 Bevy 在节点
 * 内容框内 contain 后，媒体必然顶住某一轴的两条边，不会出现「无论节点多宽都有左右边距」。
 */
function rasterize(
  image: HTMLImageElement,
  createCanvas: RasterCanvasFactory
): { pixels: Uint8Array; width: number; height: number } | null {
  return rasterizeDrawable(image, { width: image.width, height: image.height }, createCanvas, TEXTURE_MAX_DIMENSION);
}

function loadImageViaDom(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败。"));
    image.src = url;
  });
}
