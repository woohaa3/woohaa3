/** Compatibility facade; domain implementations live in features/. */
export { type EditorToolId, type PixelRect, type DocumentPoint, type CanvasViewport, screenToDocument, brushSettingsPatch } from "./features/shared/tool-parameters.js";
export { RETOUCH_TOOL_IDS, isRetouchTool } from "./features/retouch/tool-parameters.js";
export { type SelectionMode, pointInSelection, clampFeather, normalizeMarquee, buildRectSelection, buildFeather, buildLasso } from "./features/selections/tool-parameters.js";
export { type BrushSettings, DEFAULT_BRUSH, clampBrushSize, strokePoints, buildStroke, toHexColor, isHexColor } from "./features/painting/tool-parameters.js";
export { buildTextCreate } from "./features/type/tool-parameters.js";
export { buildBrightnessContrast, buildHueSaturation } from "./features/adjustments/tool-parameters.js";
