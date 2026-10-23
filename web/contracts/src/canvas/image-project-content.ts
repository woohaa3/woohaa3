/**
 * 图片工程文档内容身份（宿主入口）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.2 / design D3/D4；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 2.1 / design D2）。
 *
 * 实现已下沉到 `@woohaa3/photocraft-protocol`。本模块只做重导出，保留原导入路径与符号，
 * 让 Canvas Service、Media Service 与既有测试继续按原位置消费**逐字节相同**的指纹。
 * 逐条列举的原因见 `image-edit.ts`（esbuild 对 external `export *` 的处理）。
 */
export {
  IMAGE_PROJECT_ADJUSTMENT_KINDS,
  IMAGE_PROJECT_BLEND_MODES,
  IMAGE_PROJECT_LAYER_KINDS,
  canonicalizeImageProjectContent,
  imageProjectContentHash,
  isImageProjectAdjustmentKind,
  isImageProjectBlendMode,
  isImageProjectLayerKind,
  isSupportedImageProjectEffects,
  isSupportedImageProjectPatterns
} from "@woohaa3/photocraft-protocol";

export type {
  AnimationContent as ImageProjectAnimationContent,
  AnimationContentFrame as ImageProjectAnimationFrame,
  AnimationContentLayer as ImageProjectAnimationLayer,
  AnimationContentTimeline as ImageProjectAnimationTimeline,
  AnimationContentVideo as ImageProjectAnimationVideo,
  ImageProjectAdjustmentContent,
  ImageProjectAdjustmentKind,
  ImageProjectAdjustmentParameters,
  ImageProjectBlendMode,
  ImageProjectContent,
  ImageProjectLayer,
  ImageProjectLayerKind,
  ImageProjectMaskSummary,
  ImageProjectPixelSummary,
  ImageProjectSmartSummary,
  ImageProjectTextContent,
  ImageProjectTransform
} from "@woohaa3/photocraft-protocol";
