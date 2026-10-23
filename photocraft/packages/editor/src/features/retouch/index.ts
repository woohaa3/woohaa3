import { canRunPixelTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { Stamp, Bandage, Sparkles } from "lucide-react";
import { RetouchPanel } from "./panels.js";

/**
 * 修饰域的工具/面板贡献（change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 画布工具仍是 `clone` / `heal` / `retouch` 三个笔迹工具：新增命令（图案图章、历史画笔、移除）
 * 由「修饰」下拉选择，区域命令（修补／内容识别移动／红眼）与五槽仿制源在参数面板内部切换。
 * 这样共享工具清单、手势仲裁与菜单分组都保持不变（`features/boundaries.test.ts` 逐项断言），
 * 新能力只增加本域自己的参数、面板与命令。
 *
 * 共享单写文件接线所需的域内端口都在本文件导出，避免集成时复制一套规则：
 * - `RETOUCH_ADDED_TOOLS`：上下文栏「修饰」下拉要补的三项；
 * - `region-gesture`：拖动/单击 → 区域命令几何（零偏移、红眼不是拖动、64 处上限）；
 * - `clone-overlay`：仿制源取样框（与落笔同一份映射）；
 * - `workspace.editRetouchSession` 侧入口：`beginRetouchRegionDrag` / `markRedEye` /
 *   `beginRedEye` / `cloneOverlayFrame`（见 `EditorWorkspaceController.features.retouch`）。
 */
export const feature = {
  id: "retouch",
  tools: [{ id: "clone", gesture: "stroke", targets: ["pixels"], canRun: canRunPixelTool, label: "仿制图章", Icon: Stamp, order: 8 }, { id: "heal", gesture: "stroke", targets: ["pixels"], canRun: canRunPixelTool, label: "修复画笔", Icon: Bandage, order: 9 }, { id: "retouch", gesture: "stroke", targets: ["pixels"], canRun: canRunPixelTool, label: "修饰画笔", Icon: Sparkles, order: 10 }],
  sections,
  panels: { RetouchPanel }
} as const;

export {
  RETOUCH_ADDED_TOOLS,
  RETOUCH_ALL_TOOLS,
  RETOUCH_MENU_TOOLS,
  RETOUCH_PANEL_TOOLS,
  RETOUCH_TOOLS,
  RetouchPanel
} from "./panels.js";
export {
  CLONE_SOURCE_SLOTS,
  REGION_RETOUCH_COMMANDS,
  RETOUCH_COMMANDS,
  type RetouchCommand
} from "./tool-parameters.js";
export { createSession, type RetouchSession } from "./workspace.js";
export {
  MAX_RED_EYE_POINTS,
  addRedEyePoint,
  dragOffset,
  isRegionDrag,
  redEyePointsInRect,
  regionGestureFromDrag,
  regionGestureKind,
  type RedEyeMarks,
  type RegionDrag
} from "./region-gesture.js";
export { CloneSourceOverlay } from "./overlay.js";
export {
  activeCloneSlot,
  boundsOf,
  cloneOverlayCorners,
  cloneOverlayOpacity,
  cloneOverlayPolygon,
  cloneOverlayScreenCorners,
  cloneOverlayVisible,
  cloneSourcePoint,
  cloneStrokeSource,
  cloneTransformMatrix,
  type ScreenPoint,
  type ScreenRect
} from "./clone-overlay.js";
