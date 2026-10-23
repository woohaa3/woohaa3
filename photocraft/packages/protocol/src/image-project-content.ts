/** Compatibility facade; domain implementations live in features/. */
export { IMAGE_PROJECT_LAYER_KINDS, type ImageProjectLayerKind, type ImageProjectContent, type ImageProjectLayer, type ImageProjectPixelSummary, type ImageProjectLevelsChannel, imageProjectContentHash, canonicalizeImageProjectContent, isImageProjectLayerKind } from "./features/shared/content.js";
export { IMAGE_PROJECT_BLEND_MODES, type ImageProjectBlendMode, isImageProjectBlendMode, isSupportedImageProjectEffects, isSupportedImageProjectPatterns } from "./features/layers/content.js";
export { IMAGE_PROJECT_ADJUSTMENT_KINDS, type ImageProjectAdjustmentKind, type ImageProjectAdjustmentContent, type ImageProjectAdjustmentParameters, isImageProjectAdjustmentKind } from "./features/adjustments/content.js";
export { type ImageProjectShapeSummary, type ImageProjectVectorMaskSummary, type ImageProjectNamedPathSummary, type ImageProjectWorkPathSummary, type ImageProjectClippingPathSummary, canonicalizeSavedPaths, canonicalizeWorkPath, canonicalizeClippingPath } from "./features/vectors/content.js";
export { type ImageProjectFillContent, type ImageProjectGradientStyle, type ImageProjectGradientStop, type ImageProjectGradientOpacityStop } from "./features/layers/fill-content.js";
export { type ImageProjectSmartSummary } from "./features/smart/content.js";
export { type ImageProjectTransform } from "./features/composition/content.js";
export { type ImageProjectMaskSummary } from "./features/selections/content.js";
export { type ImageProjectTextContent } from "./features/type/content.js";
