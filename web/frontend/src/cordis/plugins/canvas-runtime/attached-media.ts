/** 创建一次 Canvas attach 的媒体 owner，并把唯一播放头接到片场解码器。 */
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { BevyRuntime } from "./bevy-runtime.js";
import type { CanvasRuntimeOptions } from "./canvas-runtime-options.js";
import type { AnimationPlaybackStore } from "./animation-playback-store.js";
import { createTextureSync } from "./texture-sync.js";
import { planImageCardFit } from "./media-card-fit.js";
import { createVideoFrameSessions } from "./video-frame-session.js";
import { createCompositeAssetMediaSessions } from "./composite-asset-media-session.js";
import { isDevVideoDisabled, hasMismatchedFlag, withoutVideoMediaSources, withoutVideoNodes } from "./dev-media-switches.js";
import {
  CanvasResourceCoordinator,
  createContentIdentity,
  createResidencyCandidateCache,
  createResidencyProjector
} from "./residency/index.js";

export type AttachedMedia = {
  textureSync: ReturnType<typeof createTextureSync>;
  videoSessions: ReturnType<typeof createVideoFrameSessions>;
  compositeAssetMediaSessions: ReturnType<typeof createCompositeAssetMediaSessions>;
  /** 页面级资源需求与预算 owner（change: 2026-10-23，design D1）。 */
  residency: CanvasResourceCoordinator;
  /** 每帧投影需求（必须先于各媒体 owner 的 `sync()`）。 */
  projectResidency: () => string[];
  dispose: () => void;
};

export function createAttachedMedia(input: {
  runtime: BevyRuntime;
  options: CanvasRuntimeOptions;
  getPreviewUrls: () => ReadonlyMap<string, string>;
  getFocusTexture: Parameters<typeof createTextureSync>[0]["getFocusTexture"];
  getFocusDetails?:Parameters<typeof createTextureSync>[0]["getFocusDetails"];
  isFocused: () => boolean;
  playback: AnimationPlaybackStore;
  invalidate: (reason: string) => void;
  /**
   * 当前已接受视口与 surface（由 interaction controller 提供）。
   * 缺省时按无有效 surface 处理：只保留 interactive/pin，不预热整张文档。
   */
  getViewport?: () => { x: number; y: number; zoom: number };
  getSurface?: () => { width: number; height: number; pixelRatio: number };
  /** 当前交互/播放/聚焦/捕获目标（interactive 准入）。 */
  getInteractiveNodeIds?: () => readonly string[];
  /** 显式 pin（聚焦过渡/严格输出）；缺省空。 */
  getPinnedNodeIds?: () => readonly string[];
  /** 页面可见性；缺省读取 document.visibilityState。 */
  isPageVisible?: () => boolean;
  /**
   * 模型/片场内容身份版本（单调递增）。
   *
   * prepared model resource 异步就绪，画布对象不变也会把候选从「不可准入」变成「可准入」。
   * 缺省 0 表示调用方不提供该信号（旧测试行为），生产由宿主在 model-scene 通知时推进。
   */
  getModelContentVersion?: () => number;
  /** 测试/诊断注入策略覆盖；集中策略仍是唯一默认来源（design D3）。 */
  residencyPolicy?: Partial<import("./residency/index.js").ResidencyPolicy>;
}): AttachedMedia {
  const { runtime, options } = input;
  let mediaContentVersion = 0;
  const unsubscribeMediaContent = options.mediaContent?.subscribe(() => {
    mediaContentVersion += 1;
    input.invalidate("media-content");
  });
  const projectCanvas = (canvas: import("@woohaa3/contracts").ServerCanvas | null) => {
    const projected = options.projectHistoryCanvas?.(canvas) ?? canvas;
    return options.compositeAssets?.projectCanvas(projected) ?? projected;
  };
  const getCanvas = () => projectCanvas(woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas);
  // 诊断开关（仅 DEV，`?woohaaDevNoVideo=1` 或 storage 键）：见 dev-media-switches.ts，用于「有/无视频」帧率 A/B。
  const videosDisabled = isDevVideoDisabled();
  if (videosDisabled) {
    console.warn("[dev] woohaaDevNoVideo=1：已关闭画布视频会话与复合资产视频源（帧率 A/B 诊断用，不代表产品行为）。");
  } else if (hasMismatchedFlag()) {
    console.warn("[dev] woohaaDevNoVideo 的值不是 1（需要 `?woohaaDevNoVideo=1`），视频诊断开关未开启。");
  }
  const getVideoCanvas = () => {
    const canvas = getCanvas();
    return videosDisabled ? withoutVideoNodes(canvas) : canvas;
  };

  // 页面级需求 owner：一个 attach scope 一个实例（design D1）。所有媒体 owner 共享同一预算。
  const residency = new CanvasResourceCoordinator({
    ...(input.residencyPolicy ? { policy: input.residencyPolicy } : {}),
    onGpuClaimReleased: () => input.invalidate("overview-cache-budget")
  });
  // 模型准备的重型工作同样只读页面策略（design D3 / 任务 2.2、6.1）：并发与片段预算
  // 来自同一个 owner，各媒体 owner 不能各自放宽。
  {
    const policy = residency.getPolicy();
    runtime.setModelPrepareBudget?.({
      concurrency: policy.modelPrepareConcurrency,
      budgetMs: Math.max(1, Math.round(policy.modelPrepareBudgetMs))
    });
  }
  const contentKeyOfOf = createContentIdentity({
    nodeCapabilities: options.nodeCapabilities,
    assetForNode: nodeId => options.mediaContent?.state(nodeId)?.asset,
    // 模型内容身份用 prepared resource key（不含 nodeId）；缺资源视为无内容。
    modelResourceKey: (nodeId) => options.getModelResources?.().get(nodeId)?.resourceKey ?? null
  });
  // 内容身份版本：模型/片场的 prepared resource 是异步就绪的，画布对象不变也可能从「无内容」
  // 变成「有内容」。候选表与准入投影都必须据此失效，否则首次投影早于资源就绪时，模型永远不会
  // 进入需求集合（真实故障：片场模型与模型卡片不显示，只有 hover 提升 interactive 才出现）。
  // 版本由宿主在 model-scene 通知时单调推进：O(1)，静止帧不遍历资源表。
  const contentVersion = () => (input.getModelContentVersion?.() ?? 0) + mediaContentVersion + (options.nodeCapabilities?.getRevision() ?? 0);
  const candidatesFor = createResidencyCandidateCache(contentKeyOfOf, contentVersion, options.nodeCapabilities);
  const projectResidency = createResidencyProjector({
    coordinator: residency,
    getCanvas,
    candidatesFor,
    viewport: input.getViewport ?? (() => ({ x: 0, y: 0, zoom: 1 })),
    surface: input.getSurface ?? (() => ({ width: 0, height: 0, pixelRatio: 1 })),
    contentVersion,
    interactive: input.getInteractiveNodeIds ?? (() => []),
    pins: input.getPinnedNodeIds ?? (() => []),
    ...(input.isPageVisible ? { pageVisible: input.isPageVisible } : {}),
    // 准入集合的内容身份同时是模型 payload lease（design D5）：只有需求内的模型 payload 驻留。
    onAdmittedContent: (keys) => runtime.setModelPayloadLeases?.(keys),
    // 静止帧仍然推进有界的待准备队列（每帧至多策略允许的数量）。
    onFrame: () => runtime.advanceModelPreparation?.()
  });
  /** 节点准入信息（纹理 owner 用）；未投影时返回 null（不猜测为已准入）。 */
  const admissionOf = (nodeId: string) => {
    if (!residency.isAdmitted(nodeId)) return null;
    const tier = residency.tierOf(nodeId);
    const purpose = residency.purposeOf(nodeId);
    if (tier === null || purpose === null) return null;
    return { admitted: true as const, purpose, tier };
  };

  // 图片卡片按图片比例定尺寸：每个节点每次挂载只尝试一次；已调过尺寸的卡片由 planImageCardFit 跳过。
  const fittedNodes = new Set<string>();
  const fitImageCard = (nodeId: string, size: { width: number; height: number }) => {
    if (fittedNodes.has(nodeId)) return;
    const session = options.getSession();
    if (!session?.isWritable()) return;
    const command = planImageCardFit(woohaa3CanvasStore.getState().canvas, nodeId, size);
    if (!command) return;
    fittedNodes.add(nodeId);
    session.submitCommands([command], `web-image-card-fit-${nodeId}-${Date.now().toString(36)}`);
  };

  const textureSync = createTextureSync({
    runtime,
    getCanvas: () => projectCanvas(woohaa3CanvasStore.getState().canvas),
    getMediaAsset: nodeId => options.mediaContent?.state(nodeId)?.asset,
    getPreviewUrls: input.getPreviewUrls,
    getFocusTexture: input.getFocusTexture,
    getFocusDetails:input.getFocusDetails,
    residency,
    admissionOf,
    onChange: () => input.invalidate("image-resources"),
    onImageSize: fitImageCard
  });
  const videoSessions = options.createVideoSessions?.(runtime) ?? createVideoFrameSessions({
    runtime, getCanvas: getVideoCanvas,
    getMediaAsset: nodeId => options.mediaContent?.state(nodeId)?.asset,
    isReducedMotion: () => options.prefersReducedMotion?.() ?? false,
    isSuspended: input.isFocused,
    getFocusTextureNodeId: () => input.getFocusTexture?.()?.nodeId ?? null,
    residency,
    purposeOf: (nodeId) => residency.purposeOf(nodeId),
    onChange: () => input.invalidate("video-frames")
  });
  const compositeAssetMediaSessions = options.createCompositeAssetMediaSessions?.(runtime) ?? createCompositeAssetMediaSessions({
    runtime, getCanvas,
    getSources: () => {
      const sources = options.compositeAssets?.mediaSources(getCanvas(), input.playback.current()) ?? [];
      return videosDisabled ? withoutVideoMediaSources(sources) : sources;
    },
    residency,
    onChange: () => input.invalidate("film-set-media")
  });
  input.playback.setCompositeAssetMediaSessions(compositeAssetMediaSessions);
  input.playback.setTimeSink((value) => {
    if (value.nodeId !== null) compositeAssetMediaSessions.setMediaTime(value.nodeId, value.time, value.playing);
  });
  return {
    textureSync, videoSessions, compositeAssetMediaSessions, residency, projectResidency,
    dispose: () => unsubscribeMediaContent?.()
  };
}
