/** Compatibility facade; domain implementations live in features/. */
export { supports } from "./features/shared/panels.js";
export { type HistogramState, decodeHistogram, HistogramGraph, HistogramPanel, AdvancedAdjustmentPanel } from "./features/adjustments/panels.js";
export { type SelectionModifyKind, SelectionModifyPanel, ColorRangePanel, RefineEdgePanel } from "./features/selections/panels.js";
export { RETOUCH_ALL_TOOLS, RETOUCH_MENU_TOOLS, RETOUCH_TOOLS, RetouchPanel } from "./features/retouch/panels.js";
export { FILTER_TOOLS, FilterPanel } from "./features/filters/panels.js";
export { ComposePanel } from "./features/composition/panels.js";
export { ViewAidsPanel } from "./features/views/panels.js";
export { TypographyPanel } from "./features/type/panels.js";
export { PathOverlay, usePathDraft } from "./features/vectors/panels.js";
export { LayerFilterPanel } from "./features/layers/panels.js";
