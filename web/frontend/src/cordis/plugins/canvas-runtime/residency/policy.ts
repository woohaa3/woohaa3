/**
 * 页面级资源预算的集中策略
 * （change: 2026-10-23-scale-canvas-media-residency，design D3）。
 *
 * 这里是**唯一**定义并发、字节与渲染槽策略的地方：各媒体 owner（图片解码、视频会话、
 * 首帧取帧、模型准备、片场平面、预览）只能读这里的策略，不能各自放宽。
 *
 * 数值是拟实施起点，不是已测得的设备上限；真实设备校准只能有记录地改本文件与基准配置
 * （design D3 最后一段）。测试用 `resolveResidencyPolicy` 注入更小预算，不复制常量。
 */

/** 缩略图/纹理尺寸档（长边像素）。禁止全量固定 1024（design D3）。 */
export const THUMBNAIL_TIERS = [128, 256, 512, 1024] as const;
export type ThumbnailTier = (typeof THUMBNAIL_TIERS)[number];

/** 资源需求用途；数值越小优先级越高（design D1 的 purpose）。 */
export type ResidencyPurpose = "interactive" | "visible" | "prefetch" | "warm";

export const PURPOSE_RANK: Readonly<Record<ResidencyPurpose, number>> = {
  interactive: 0,
  visible: 1,
  prefetch: 2,
  warm: 3
};

/** 受预算约束的异步通道。 */
export type ResidencyChannel =
  | "image"
  | "video-session"
  | "video-frame"
  | "model-prepare"
  | "upload"
  | "preview";

export type ResidencyPolicy = {
  /** 每页同时未完成的图片解码数。 */
  imageDecodeConcurrency: number;
  /** 普通卡片 + 片场 + 聚焦合计的视频 decoder 数。 */
  videoSessionLimit: number;
  /** 同时真正未完成的视频首帧取帧数。 */
  videoFirstFrameConcurrency: number;
  /** 同时推进的重型模型准备数。 */
  modelPrepareConcurrency: number;
  /** 单帧重型模型准备的主线程片段预算（ms）；超出留到后续帧。 */
  modelPrepareBudgetMs: number;
  /** 每帧媒体上传 staging 预算（字节）。 */
  uploadBytesPerFrame: number;
  /** 每页 CPU 派生像素与 staging 预算（字节，含在途 reservation）。 */
  cpuDerivedBytes: number;
  /** 每页模型派生 CPU payload 预算（字节，含 IR/prepared/replay 可达副本）。 */
  modelPayloadBytes: number;
  /** 每页 GPU 派生资源估算预算（字节；保守估算，不是驱动实测显存）。 */
  gpuDerivedBytes: number;
  /** 每页预览渲染槽上限。 */
  previewSlots: number;
  /** 单帧普通预览刷新上限。 */
  previewRefreshesPerFrame: number;
  /** 离屏保留宽限（ms）；宽限结束后按预算淘汰。 */
  offscreenGraceMs: number;
  /** 可见需求外扩预热比例（视口尺寸的比例）。 */
  prefetchMarginFactor: number;
  /** 单次解码/光栅化的输入像素上限（超过则拒绝派生，不静默降质）。 */
  maxSourcePixels: number;
};

/**
 * 设计 D3 的初始策略。
 *
 * GPU 数字是保守估算：诊断里必须标注估算，不能称为驱动实测显存。
 */
export const DEFAULT_RESIDENCY_POLICY: ResidencyPolicy = {
  imageDecodeConcurrency: 2,
  videoSessionLimit: 12,
  videoFirstFrameConcurrency: 2,
  modelPrepareConcurrency: 2,
  modelPrepareBudgetMs: 6,
  uploadBytesPerFrame: 8 * 1024 * 1024,
  cpuDerivedBytes: 96 * 1024 * 1024,
  modelPayloadBytes: 64 * 1024 * 1024,
  gpuDerivedBytes: 256 * 1024 * 1024,
  previewSlots: 16,
  previewRefreshesPerFrame: 2,
  offscreenGraceMs: 1500,
  prefetchMarginFactor: 0.5,
  maxSourcePixels: 8192 * 8192
};

const LIMITS: Readonly<Record<keyof ResidencyPolicy, number>> = {
  imageDecodeConcurrency: 64,
  videoSessionLimit: 64,
  videoFirstFrameConcurrency: 32,
  modelPrepareConcurrency: 32,
  modelPrepareBudgetMs: 100,
  uploadBytesPerFrame: 1024 * 1024 * 1024,
  cpuDerivedBytes: 4096 * 1024 * 1024,
  modelPayloadBytes: 4096 * 1024 * 1024,
  gpuDerivedBytes: 8192 * 1024 * 1024,
  previewSlots: 256,
  previewRefreshesPerFrame: 32,
  offscreenGraceMs: 60_000,
  prefetchMarginFactor: 4,
  maxSourcePixels: 1e9
};

/**
 * 合并注入的策略覆盖。
 *
 * 只接受正有限数并在合理上界内：注入不能把并发写成 `Infinity` 或负数而绕开预算。
 */
export function resolveResidencyPolicy(override: Partial<ResidencyPolicy> = {}): ResidencyPolicy {
  const resolved: ResidencyPolicy = { ...DEFAULT_RESIDENCY_POLICY };
  for (const key of Object.keys(DEFAULT_RESIDENCY_POLICY) as (keyof ResidencyPolicy)[]) {
    const value = override[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    resolved[key] = Math.min(value, LIMITS[key]);
  }
  return resolved;
}

/** 某通道的并发上限；`upload` / `preview` 由字节或槽策略约束，返回 Infinity 表示无计数上限。 */
export function concurrencyLimit(policy: ResidencyPolicy, channel: ResidencyChannel): number {
  switch (channel) {
    case "image": return Math.floor(policy.imageDecodeConcurrency);
    case "video-session": return Math.floor(policy.videoSessionLimit);
    case "video-frame": return Math.floor(policy.videoFirstFrameConcurrency);
    case "model-prepare": return Math.floor(policy.modelPrepareConcurrency);
    case "preview": return Math.floor(policy.previewSlots);
    case "upload": return Number.POSITIVE_INFINITY;
  }
}

/** 某通道的字节预算；`Infinity` 表示本通道只受并发约束，字节由调用方按帧预算自行结算。 */
export function byteBudget(policy: ResidencyPolicy, channel: ResidencyChannel): number {
  switch (channel) {
    case "image":
    case "video-frame": return policy.cpuDerivedBytes;
    case "video-session": return policy.gpuDerivedBytes;
    case "model-prepare": return policy.modelPayloadBytes;
    case "upload": return policy.uploadBytesPerFrame;
    case "preview": return policy.gpuDerivedBytes;
  }
}

/**
 * 按实际显示尺寸选择缩略图档（长边）。
 *
 * 输入是内容框的物理像素长边（CSS 尺寸 × DPR），输出不小于该值的最近档；超过最大档即用
 * 最大档。禁止对全量节点固定 1024（design D3 表格最后一行、任务 4.3）。
 */
export function selectThumbnailTier(physicalEdge: number): ThumbnailTier {
  const edge = Number.isFinite(physicalEdge) ? Math.max(1, physicalEdge) : THUMBNAIL_TIERS[0];
  for (const tier of THUMBNAIL_TIERS) if (tier >= edge) return tier;
  return THUMBNAIL_TIERS[THUMBNAIL_TIERS.length - 1];
}

/** 估算 RGBA8 纹理字节。 */
export function estimateRgbaBytes(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.ceil(width) * Math.ceil(height) * 4;
}
