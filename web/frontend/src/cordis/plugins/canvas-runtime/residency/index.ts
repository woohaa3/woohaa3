/**
 * 页面级资源驻留模块的公共入口
 * （change: 2026-10-23-scale-canvas-media-residency，design D1–D4）。
 *
 * 只导出策略、通道队列、页级协调器与需求投影；不导出任何媒体实现，避免 owner 之间互相依赖。
 */
export {
  DEFAULT_RESIDENCY_POLICY,
  PURPOSE_RANK,
  THUMBNAIL_TIERS,
  byteBudget,
  concurrencyLimit,
  estimateRgbaBytes,
  imageDecodeBudget,
  imageDecodeReservation,
  imageFetchBudget,
  resolveResidencyPolicy,
  selectThumbnailTier,
  type ResidencyChannel,
  type ResidencyPolicy,
  type ResidencyPurpose,
  type ThumbnailTier
} from "./policy.js";
export {
  ResidencyChannelQueue,
  queueClockNow,
  type LeaseState,
  type ResidencyLease,
  type ResidencyOutcome,
  type ResidencyQueueOptions,
  type ResidencyRequest,
  type ResidencySnapshot
} from "./channel-queue.js";
export {
  CanvasResourceCoordinator,
  type NodeResidencyDemand,
  type ResidencyAdmitRequest,
  type ResidencyDiagnostics,
  type ResidencyProjectionInput,
  type ResidencySurface,
  type ResidencyViewport
} from "./coordinator.js";
export {
  assetContentKey,
  createContentIdentity,
  type ContentIdentityOptions,
  type ContentKeyOf
} from "./content-identity.js";
export {
  collectResidencyCandidates,
  createResidencyCandidateCache,
  createResidencyProjector,
  canvasStructureKey,
  type ResidencyCandidate,
  type ResidencyProjectorInput
} from "./projection.js";
