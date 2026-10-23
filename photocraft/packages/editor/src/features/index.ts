import { feature as files } from "./files/index.js";
import { feature as io } from "./io/index.js";
import { feature as vectors } from "./vectors/index.js";
import { feature as selections } from "./selections/index.js";
import { feature as channels } from "./channels/index.js";
import { feature as painting } from "./painting/index.js";
import { feature as retouch } from "./retouch/index.js";
import { feature as adjustments } from "./adjustments/index.js";
import { feature as modes } from "./modes/index.js";
import { feature as filters } from "./filters/index.js";
import { feature as composition } from "./composition/index.js";
import { feature as layers } from "./layers/index.js";
import { feature as smart } from "./smart/index.js";
import { feature as type } from "./type/index.js";
import { feature as views } from "./views/index.js";
import { feature as customization } from "./customization/index.js";
import { feature as history } from "./history/index.js";
import { feature as animation } from "./animation/index.js";

export const EDITOR_FEATURES = [files, io, vectors, selections, channels, painting, retouch, adjustments, modes, filters, composition, layers, smart, type, views, customization, history, animation] as const;
export type EditorFeatureId = (typeof EDITOR_FEATURES)[number]["id"];
export type FeatureToolId = (typeof EDITOR_FEATURES)[number]["tools"][number]["id"];
export const FEATURE_TOOLS = EDITOR_FEATURES.flatMap(feature => [...feature.tools]).sort((a, b) => a.order - b.order);
export const FEATURE_PANELS = { ...files.panels, ...io.panels, ...vectors.panels, ...selections.panels, ...channels.panels, ...painting.panels, ...retouch.panels, ...adjustments.panels, ...modes.panels, ...filters.panels, ...composition.panels, ...layers.panels, ...smart.panels, ...type.panels, ...views.panels, ...customization.panels, ...history.panels, ...animation.panels };

export const FEATURE_SECTIONS = EDITOR_FEATURES.flatMap(feature => [...feature.sections]).sort((a, b) => a.order - b.order);
export type EditorFeaturePanel = (typeof FEATURE_SECTIONS)[number]["id"];
export const featureMenuSections = (menu: string) => FEATURE_SECTIONS.filter(section => section.menu === menu).sort((a, b) => a.menuOrder - b.menuOrder);

export function featureTool(id: string) { return FEATURE_TOOLS.find(tool => tool.id === id); }
/** 工具的画布手势（`undefined` 表示未登记）。共享画布据此把工具分到拖动/单击/采样分支。 */
export function featureGesture(id: string): "selection" | "sample" | "stroke" | "point" | "move" | "text" | undefined {
  return featureTool(id)?.gesture as "selection" | "sample" | "stroke" | "point" | "move" | "text" | undefined;
}
export function isFeatureGestureTool(id: string): boolean {
  const gesture = featureTool(id)?.gesture;
  return gesture === "selection" || gesture === "sample" || gesture === "stroke" || gesture === "point";
}
export function isFeatureStrokeTool(id: string): boolean { return featureTool(id)?.gesture === "stroke"; }
/** 单击类工具（油漆桶、魔术橡皮）：一次点按一个事务，不产生拖动预览。 */
export function isFeaturePointTool(id: string): boolean { return featureTool(id)?.gesture === "point"; }
/**
 * 矢量组手势（`shape` 拖绘 / `pen` 落锚 / `path` 锚点编辑）的工具。
 *
 * 画布据此把指针事件交给 `features/vectors/vector-tools.ts` 的归约器，而不是落到平移或笔迹
 * 分支——未登记手势若被当成笔迹处理，会误写像素。语义与参数都在域内，画布只做路由。
 */
export function isFeatureVectorTool(id: string): boolean {
  const gesture = featureTool(id)?.gesture;
  return gesture === "shape" || gesture === "pen" || gesture === "path";
}
