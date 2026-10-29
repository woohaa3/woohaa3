/**
 * 节点媒体纹理同步（change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 移植 `xyflow-bevy/web/media-renderer.js`：把**图片**像素上传给 Bevy
 * （`set_texture(nodeId, w, h, rgba)`），供节点卡内的 Sprite 显示。纹理尺寸保持图片自身
 * 宽高比（不填充、不裁剪），因此节点内容框 contain 后媒体必然顶住某一轴的两条边。
 *
 * change: 2026-10-23-scale-canvas-media-residency（design D1/D2/D4）：
 * - **先准入再创建**：只有页面资源协调器 admitted 的节点才进入加载；未准入保持占位/缓存图。
 * - **按内容身份共享**：同一 storageKey 的在途解码与像素只保留一份（nodeId 只绑定实例），
 *   1000 张引用同一资产的卡片只启动一次解码，不再 1000 次 loadImage。
 * - **有界并发**：解码经 `image` 通道准入（默认 2 个未完成任务），函数返回不归还名额。
 * - **受控尺寸档**：按实际投影物理长边选 128/256/512/1024 档，禁止全量固定 1024。
 *
 * 视频节点（change: enable-video-node-live-preview）的纹理**不由这里负责**：真实解码帧与
 * poster 回退都由 `video-frame-session.ts` 的浏览器视频会话上传。
 */
import { MediaOperationBoundary } from "./media-operation-boundary.js";
import { errorDetail } from "./runtime-issues.js";
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import type { BevyRuntime } from "./bevy-runtime.js";
import { rasterizeDrawable, defaultRasterCanvasFactory, type RasterCanvasFactory } from "./media-raster.js";
import { NodeResourceLoading, type NodeResourceLoad } from "../../services/node-resource-loading.js";
import { appPublicUrl } from "../../services/app-base-path.js";
import { withMediaCanvasHint } from "../../services/paths.js";
import { selectThumbnailTier, THUMBNAIL_TIERS, type ThumbnailTier } from "./residency/policy.js";
import { canvasStructureKey } from "./residency/projection.js";
import type { CanvasResourceCoordinator, ResidencyPurpose } from "./residency/index.js";
import {
  IMAGE_RETRY_DELAYS_MS,
  IMAGE_RETRY_MAX_ATTEMPTS,
  isTransientImageFailure,
  loadImageViaDom
} from "./image-load.js";

/**
 * 纹理最长边上限（像素）。纹理尺寸**保持图片自身宽高比**（不填充、不裁剪），
 * 因此 Bevy 侧 contain 后图片必然顶住内容框的某一轴边缘、无多余边距。
 */
export const TEXTURE_MAX_DIMENSION = 1024;

/** 单个节点在本帧的准入信息（由页面资源协调器提供）。 */
export type TextureAdmission = {
  /** 是否已准入；未准入的节点只用占位或上一合法图。 */
  admitted: boolean;
  purpose: ResidencyPurpose;
  /** 已选档位（长边像素）；缺省由 `detailSize` 派生。 */
  tier: ThumbnailTier;
};

export type TextureSyncOptions = {
  runtime: BevyRuntime;
  getCanvas: () => ServerCanvas | null;
  /** Runtime-resolved provider asset for mediaContent nodes before persistence lands. */
  getMediaAsset?: (nodeId: string) => StoredAsset | null | undefined;
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
  /** 图片解码完成：给出原图像素尺寸（卡片按图片比例定尺寸用）。 */
  onImageSize?: (nodeId: string, size: { width: number; height: number }) => void;
  /**
   * 页面级资源需求与预算 owner（change: 2026-10-23，design D1）。
   *
   * 提供时：只加载 admitted 节点，解码经 `image` 通道准入，尺寸走受控档位。
   * 缺省（旧单元测试/注入运行时）保留既有「按画布全量同步」行为，但同内容仍然共享一次解码。
   */
  residency?: CanvasResourceCoordinator;
  /** 该节点当前的准入信息；缺省视为已准入、visible、1024 档。 */
  admissionOf?: (nodeId: string) => TextureAdmission | null;
};

export type TextureUploader = {
  /** 按当前画布同步纹理（幂等：已上传的不重复）。 */
  sync(): void;
  /** 上传完成的节点 id 集合（用于 mapper 的 texture 标记，可选）。 */
  textureNodeIds(): ReadonlySet<string>;
  isLoading?(nodeId: string): boolean;
  dispose(): void;
};

/** 一份已解码/已上传的图片内容（按内容身份共享，nodeId 只持引用）。 */
type ContentEntry = {
  /** 内容身份：受控 URL（含画布提示）在单次 attach 内已足够稳定；不含 nodeId。 */
  key: string;
  url: string;
  /** 当前档位；变化才重新解码。 */
  tier: ThumbnailTier;
  ready: boolean;
  failed?: boolean;
  /**
   * CPU 像素已释放（design D4 / 任务 4.5）。
   *
   * 所有引用该内容的节点都确认上传后，JS 侧不再保留像素副本；运行代际变化或新节点加入时
   * 按需重读（不从 GPU 猜测原图）。共享 GPU 纹理由 Bevy 按内容身份持有，因此释放 CPU 副本
   * 不影响其他卡片。
   */
  released?: boolean;
  pixels?: Uint8Array;
  width?: number;
  height?: number;
  /** 引用该内容的 nodeId 集合（最后引用结束才关闭像素）。 */
  nodes: Set<string>;
  /** 传输失败后已排定的自动重试计时器（design D2/D8）；内容失败时不设置。 */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** 已用掉的自动重试次数；达到 `IMAGE_RETRY_MAX_ATTEMPTS` 后转为显式重试。 */
  retryAttempts?: number;
};

type NodeEntry = {
  url: string;
  contentKey: string;
  tier: ThumbnailTier;
  load: NodeResourceLoad;
  /** 本节点是否已上传（nodeId 级：同内容不同节点各自需要一次 setTexture）。 */
  sent: boolean;
};

export function createTextureSync(options: TextureSyncOptions): TextureUploader {
  const loadImage = options.loadImage ?? loadImageViaDom;
  const createCanvas = options.createCanvas ?? defaultRasterCanvasFactory;
  const residency = options.residency;
  /** nodeId → 绑定信息。 */
  const entries = new Map<string, NodeEntry>();
  /** contentKey → 共享解码内容。 */
  const contents = new Map<string, ContentEntry>();
  const loading = new NodeResourceLoading(options.onChange);
  const uploads = new MediaOperationBoundary(options.runtime);
  const uploaded = new Set<string>();
  let runtimeGeneration = options.runtime.generation?.() ?? 0;
  let retryVersion = options.runtime.retryVersion?.() ?? 0;
  let disposed = false;
  let overrideUploaded = false;
  let previousOverride: ReturnType<NonNullable<TextureSyncOptions["getFocusTexture"]>> = null;
  let previousDetails:import("./focus-details.js").ImageFocusDetails|null|undefined;
  /**
   * 绑定集合 memo（design D7 / 任务 7.1）。
   *
   * 画布身份、准入集合版本、幽灵预览表和聚焦覆盖都没变时，静止帧不重新遍历全部文档节点
   * 解析媒体 URL；只推进已准入内容的就绪上传。
   */
  let boundCanvas: ServerCanvas | null = null;
  let boundRevision = -1;
  let boundPreviews: ReadonlyMap<string, string> | null = null;
  let boundStructure = "";
  let boundDesired: Map<string, { url: string; tier: ThumbnailTier }> | null = null;

  /** 内容身份：URL 本身（已含画布读提示）；不含 nodeId（design D4）。 */
  const contentKeyOf = (url: string): string => url;

  /**
   * 该节点当前的准入信息。
   *
   * 缺省（未注入回调）视为已准入，保持旧单元测试/注入运行时可用；回调返回 `null` 表示
   * **明确未准入**，必须保持占位，不能回落到默认准入（否则先准入再创建的门禁失效）。
   */
  const admissionOf = (nodeId: string): TextureAdmission => {
    if (!options.admissionOf) return { admitted: true, purpose: "visible", tier: TEXTURE_MAX_DIMENSION };
    return options.admissionOf(nodeId) ?? { admitted: false, purpose: "visible", tier: THUMBNAIL_TIERS[0] };
  };

  const desiredUrls = (canvas: ServerCanvas): Map<string, { url: string; tier: ThumbnailTier }> => {
    const assets = new Map<string, StoredAsset>(canvas.assets.map((asset) => [asset.id, asset]));
    const nodeData = canvas.nodeData as Record<string, { outputAssetId?: unknown } | undefined>;
    const desired = new Map<string, { url: string; tier: ThumbnailTier }>();
    for (const node of canvas.document.nodes) {
      // 只处理图片节点；视频画面由 video-frame-session 负责（design D1/D2）。
      if (node.type !== "image") continue;
      const outputId = nodeData[node.id]?.outputAssetId;
      const asset = (typeof outputId === "string" ? assets.get(outputId) : undefined) ?? options.getMediaAsset?.(node.id);
      if (!asset || asset.status !== "ready") continue;
      // asset.url 是应用逻辑受控路径（`/api/media/<storageKey>`）；DOM/解码出口在此加一次公开
      // 前缀，并带上本画布的读提示（`?canvas=<id>`），让宿主按画布路由到远端存储。
      const url = asset.url ? appPublicUrl(withMediaCanvasHint(asset.url, canvas.id)) : "";
      if (!url) continue;
      // 先准入再创建：未准入节点不进入加载集合，保持占位/上一合法图。
      const admission = admissionOf(node.id);
      if (!admission.admitted) continue;
      desired.set(node.id, { url, tier: admission.tier });
    }
    // 上传中的幽灵节点：本地预览 URL（object URL），同样走解码/上传；真实节点出现后覆盖它。
    const previews = options.getPreviewUrls?.();
    if (previews) {
      for (const [nodeId, url] of previews) desired.set(nodeId, { url, tier: TEXTURE_MAX_DIMENSION });
    }
    return desired;
  };

  /** 释放不再被任何节点引用的共享内容与像素（逐层释放的第一步）。 */
  const releaseContent = (key: string): void => {
    const content = contents.get(key);
    if (!content) return;
    if (content.nodes.size > 0) return;
    if (content.retryTimer !== undefined) {
      globalThis.clearTimeout(content.retryTimer);
      content.retryTimer = undefined;
    }
    contents.delete(key);
  };

  /**
   * 传输失败后的有界自动重试（design D2/D8）。
   *
   * 只在内容仍被需求、未被换源/删除时重排；复用同一 `image` 通道（不绕过并发上限），
   * 次数受 `IMAGE_RETRY_MAX_ATTEMPTS` 约束。返回 false 表示不自动重试（交给显式重试）。
   */
  const scheduleRetry = (
    target: ContentEntry,
    url: string,
    tier: ThumbnailTier,
    purpose: ResidencyPurpose,
    key: string
  ): boolean => {
    const attempt = target.retryAttempts ?? 0;
    if (attempt >= IMAGE_RETRY_MAX_ATTEMPTS) return false;
    if (contents.get(key) !== target || target.nodes.size === 0) return false;
    target.retryAttempts = attempt + 1;
    // 重新进入「加载中」：卡片继续显示自己的占位/上次合法图，而不是先闪一次错误态。
    for (const nodeId of target.nodes) {
      const node = entries.get(nodeId);
      if (node) loading.setLoading(node.load, true);
    }
    target.retryTimer = globalThis.setTimeout(() => {
      target.retryTimer = undefined;
      if (disposed || contents.get(key) !== target || target.nodes.size === 0) return;
      startDecode(target, url, tier, purpose, key);
    }, IMAGE_RETRY_DELAYS_MS[attempt]);
    // 未引用时计时器不该单独维持内容存活；节点释放路径会清掉它。
    return true;
  };

  /**
   * 启动一次内容解码（含准入）。
   *
   * 从 `bindNode` 抽出，使「上传完成后释放 CPU 像素」之后仍能按需重读同一内容
   * （任务 4.5）：重读走同一条 image 通道预算，不会绕过并发上限。
   */
  const startDecode = (target: ContentEntry, url: string, tier: ThumbnailTier, purpose: ResidencyPurpose, key: string): void => {
    target.released = false;
    if (target.retryTimer !== undefined) {
      globalThis.clearTimeout(target.retryTimer);
      target.retryTimer = undefined;
    }
    const decode = async (): Promise<void> => {
      const image = await loadImage(url);
      if (disposed || contents.get(key) !== target) return;
      const raster = rasterize(image, createCanvas, tier);
      if (!raster) throw new Error("图片预览无法读取像素");
      target.pixels = raster.pixels;
      target.width = raster.width;
      target.height = raster.height;
      target.ready = true;
      target.failed = false;
      target.retryAttempts = 0;
      for (const nodeId of target.nodes) {
        options.runtime.clearRuntimeIssue?.(`decode:image:${nodeId}`);
        options.onImageSize?.(nodeId, { width: image.width, height: image.height });
      }
    };
    const run = residency
      ? residency.admit<void>({
          channel: "image",
          key,
          purpose,
          bytes: tier * tier * 4,
          run: decode
        }).then((outcome) => {
          if (outcome.status !== "settled") throw errorOf(outcome);
        })
      : decode();
    void run
      .catch(error => {
        if (disposed || contents.get(key) !== target) return;
        target.failed = true;
        // 传输失败（媒体服务重启/网关 5xx/网络中断）不是内容错误：按有界退避自动重试，
        // 避免一次几秒的重启把健康素材永久钉成「加载失败」（design D2/D8）。
        // 内容失败（4xx、解码失败）仍只走显式重试，静止帧不反复启动失败任务。
        if (isTransientImageFailure(error) && scheduleRetry(target, url, tier, purpose, key)) return;
        for (const nodeId of target.nodes) {
          const node = entries.get(nodeId);
          if (!node) continue;
          loading.setLoading(node.load, false);
          options.runtime.reportRuntimeIssue?.({ key: `decode:image:${nodeId}`, scope: "texture", operation: "decode-image",
            nodeId, message: "图片预览加载失败，可以重试或更换素材。", detail: errorDetail(error),
            recoverable: true, retainedPreview: uploaded.has(nodeId) });
        }
      })
      .then(() => {
        if (disposed) return;
        options.onChange?.();
      });
  };

  /**
   * 该内容是否还有未上传的引用者。
   *
   * 用于决定是否必须保留 CPU 像素：全部引用者确认上传后即可释放（任务 4.5）。
   */
  const hasPendingUpload = (content: ContentEntry): boolean => {
    for (const nodeId of content.nodes) {
      const entry = entries.get(nodeId);
      if (entry && !entry.sent) return true;
    }
    return false;
  };

  /** 把某个已解码内容绑定到节点（必要时重新上传）。 */
  const bindNode = (nodeId: string, url: string, tier: ThumbnailTier): void => {
    const key = contentKeyOf(url);
    const previous = entries.get(nodeId);
    const unchanged = previous && previous.url === url && previous.tier === tier;
    if (unchanged) {
      // 引用已存在：只要内容还在就保持。
      if (contents.has(key)) return;
    }
    if (previous && (previous.url !== url || previous.tier !== tier)) {
      const oldContent = contents.get(previous.contentKey);
      oldContent?.nodes.delete(nodeId);
      if (previous.contentKey !== key) releaseContent(previous.contentKey);
      uploads.clear(`image:${nodeId}`);
    }
    const content = contents.get(key);
    if (content) {
      content.nodes.add(nodeId);
      entries.set(nodeId, { url, contentKey: key, tier, load: previous?.load ?? loading.track(nodeId, url), sent: previous?.sent ?? false });
      // 同一张图已解码过（例如重复导入）：新卡片同样按比例定尺寸。
      if (content.ready && content.width && content.height) {
        options.onImageSize?.(nodeId, { width: content.width, height: content.height });
      }
      return;
    }
    const entry: NodeEntry = {
      url,
      contentKey: key,
      tier,
      load: previous?.load ?? loading.track(nodeId, url),
      sent: previous?.sent ?? false
    };
    entries.set(nodeId, entry);
    loading.setLoading(entry.load, true);
    const target: ContentEntry = { key, url, tier, ready: false, nodes: new Set([nodeId]) };
    contents.set(key, target);
    // 先准入再创建：解码本身也经 image 通道（并发 + 真实在途计数）。
    startDecode(target, url, tier, admissionOf(nodeId).purpose, key);
  };

  /** 清理不再需要的节点绑定（删除/换源/未准入/失权）。 */
  const retainNodes = (desired: ReadonlyMap<string, { url: string; tier: ThumbnailTier }>): void => {
    for (const [id, entry] of entries) {
      const want = desired.get(id);
      if (want && want.url === entry.url && want.tier === entry.tier) continue;
      entries.delete(id);
      uploaded.delete(id);
      uploads.clear(`image:${id}`);
      loading.remove(entry.load);
      options.runtime.clearRuntimeIssue?.(`decode:image:${id}`);
      const content = contents.get(entry.contentKey);
      if (content) {
        content.nodes.delete(id);
        // 最后引用者消失时，待定的自动重试也要取消，不能对已删除节点重试。
        if (content.nodes.size === 0 && content.retryTimer !== undefined) {
          globalThis.clearTimeout(content.retryTimer);
          content.retryTimer = undefined;
        }
      }
      releaseContent(entry.contentKey);
    }
  };

  return {
    sync() {
      if (disposed) return;
      const canvas = options.getCanvas();
      if (!canvas) {
        entries.clear();
        contents.clear();
        uploaded.clear();
        previousOverride = null;
        loading.clear();
        boundCanvas = null;
        boundDesired = null;
        boundStructure = "";
        return;
      }
      // 需求集合 memo（design D7 / 任务 7.1）：画布身份 + 准入版本 + 幽灵预览表都没变时复用
      // 上一帧绑定，不重新遍历全量节点解析媒体 URL。
      const previews = options.getPreviewUrls?.() ?? null;
      const revision = residency?.projectionRevision() ?? -1;
      // 结构信号（节点/资产容器身份 + revision）一起参与 memo：即使调用方原地改了 working
      // 文档，也不会把旧绑定当成最新需求继续复用。
      const structure = canvasStructureKey(canvas);
      let desired = boundDesired;
      if (!desired || canvas !== boundCanvas || revision !== boundRevision || previews !== boundPreviews
        || structure !== boundStructure) {
        desired = desiredUrls(canvas);
        boundCanvas = canvas;
        boundRevision = revision;
        boundPreviews = previews;
        boundStructure = structure;
        boundDesired = desired;
      }
      const desiredLoads = new Map([...desired].map(([nodeId, value]) => [nodeId, value.url]));
      loading.retain(desiredLoads);
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
        for (const [key, content] of contents) {
          if (content.retryTimer !== undefined) {
            globalThis.clearTimeout(content.retryTimer);
            content.retryTimer = undefined;
          }
          if (content.failed) contents.delete(key);
        }
        for (const [id, entry] of [...entries]) if (!desired.has(id) || !contents.has(entry.contentKey)) entries.delete(id);
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
      // 移除不再需要的节点纹理缓存；先算好删除，再补齐新增（共享内容保留）。
      retainNodes(desired);
      let changed = false;
      for (const [id, { url, tier }] of desired) {
        const before = entries.get(id);
        bindNode(id, url, tier);
        if (!before || before.url !== url || before.tier !== tier) changed = true;
      }
      if (override && override !== previousOverride) {
        const accepted = uploads.run(`focus:${override.nodeId}`, override, override.nodeId,
          () => options.runtime.setTexture(override.nodeId, override.width, override.height, override.pixels) !== false);
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
      const restarted = new Set<string>();
      for (const [id, entry] of entries) {
        if ((id === override?.nodeId && overrideUploaded) || entry.sent) continue;
        const content = contents.get(entry.contentKey);
        if (!content) continue;
        if (content.released) {
          // 像素已按任务 4.5 释放，但仍有未上传引用者（运行代际恢复 / 新绑定）：按需重读一次。
          // 同内容每帧最多重读一次；失败内容不自动重试（保持占位，等显式重试）。
          if (content.ready && !content.failed && !restarted.has(content.key)) {
            restarted.add(content.key);
            startDecode(content, content.url, content.tier, admissionOf(id).purpose, content.key);
          }
          continue;
        }
        if (!content.ready || !content.pixels || !content.width || !content.height) continue;
        // 每帧上传 staging 预算（design D3）：额度用尽就留到下一帧，不能记成失败
        // （「本帧没上传」不是资源错误，只是被延后）。
        if (!(residency?.spendUploadBytes(content.width * content.height * 4) ?? true)) continue;
        const accepted = uploads.run(`image:${id}`, content, id,
          () => options.runtime.setTexture(id, content.width!, content.height!, content.pixels!,
            { sourceKey: content.url, preserveFailure: id === override?.nodeId }) !== false);
        loading.setLoading(entry.load, false);
        if (accepted) { entry.sent = true; uploaded.add(id); changed = true; }
      }
      // 逐层释放（design D4 / 任务 4.5）：所有引用者都已确认上传后，JS 侧不再保留像素副本。
      // 只做 JS 去重或只清屏幕图元都不算完成回收；Bevy 侧按内容身份共享纹理，像素可再读。
      //
      // 例外：聚焦升级与编辑细节**必须**保留原图（design D4「保持聚焦原图/编辑细节」）——
      // 退出聚焦要立刻重传原图，不能先黑一下再等重读。
      const retainedNodes = new Set<string>();
      const focusNode = override?.nodeId ?? details?.nodeId;
      if (focusNode) retainedNodes.add(focusNode);
      for (const content of contents.values()) {
        if (!content.ready || content.released || !content.pixels) continue;
        if (hasPendingUpload(content)) continue;
        if ([...content.nodes].some(nodeId => retainedNodes.has(nodeId))) continue;
        content.pixels = undefined;
        content.released = true;
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
      for (const key of contents.keys()) residency?.cancel(key);
      for (const content of contents.values()) {
        if (content.retryTimer === undefined) continue;
        globalThis.clearTimeout(content.retryTimer);
        content.retryTimer = undefined;
      }
      entries.clear();
      contents.clear();
      uploaded.clear();
      loading.clear();
    }
  };
}

function errorOf(outcome: { status: string; error?: unknown }): Error {
  return outcome.error instanceof Error ? outcome.error : new Error(`图片准备${outcome.status}`);
}

/**
 * 把图片按**自身宽高比**缩放到最长边 `maxDimension` 内并取 RGBA。
 *
 * 关键：纹理尺寸 = 图片自身尺寸（等比缩放），**不填充、不裁剪**。这样 Bevy 在节点
 * 内容框内 contain 后，媒体必然顶住某一轴的两条边，不会出现「无论节点多宽都有左右边距」。
 */
function rasterize(
  image: HTMLImageElement,
  createCanvas: RasterCanvasFactory,
  maxDimension: number = TEXTURE_MAX_DIMENSION
): { pixels: Uint8Array; width: number; height: number } | null {
  // 保留既有公开 helper 语义：档位不能超过 Bevy 纹理硬上限。
  const limit = Math.min(selectThumbnailTier(maxDimension), TEXTURE_MAX_DIMENSION);
  return rasterizeDrawable(image, { width: image.width, height: image.height }, createCanvas, limit);
}
