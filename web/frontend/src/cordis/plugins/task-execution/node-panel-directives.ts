/**
 * 执行面板 presentation / close 指令解析
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 1.2/1.3 / design D5/D7）。
 *
 * 纯函数：把「当前 presentation + 最内层局部状态」解析为一次 panel presentation intent，
 * 再由宿主把它翻译成 Canvas Navigation route / close intent。本模块不读 store、不发命令、
 * 不写 canonical。
 *
 * 约束：单次调用最多产生一个 transition（design D7「单次 Escape 最多执行一个 transition」）。
 */
import type {
  CanvasPanelRoute,
  CanvasPanelType,
  ExecutionPanelPresentation
} from "../../navigation/contracts.js";

export type ExecutionPanelNodeType = "node-execution" | "model-node-editor";

/** panel-local 浮层是否打开（picker / 参数菜单 / 快捷改写菜单等）。 */
export type PanelLocalSurface = {
  /** 参考 picker 打开。 */
  picker: boolean;
  /** 面板内其它浮层（菜单）打开。 */
  overlay: boolean;
};

/**
 * 面板 presentation intent：
 * - `expand` / `collapse`：同 identity 替换 presentation；
 * - `close`：清除匹配 panel route；
 * - `none`：不产生 transition（由更内层处理）。
 */
export type PanelPresentationIntent =
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "close" }
  | { kind: "none" };

/** 展开：仅执行面板有 expanded presentation。 */
export function planExpandIntent(type: ExecutionPanelNodeType): PanelPresentationIntent {
  return type === "node-execution" ? { kind: "expand" } : { kind: "none" };
}

/** 收起：expanded → compact 的同 identity 替换。 */
export function planCollapseIntent(type: ExecutionPanelNodeType): PanelPresentationIntent {
  return type === "node-execution" ? { kind: "collapse" } : { kind: "none" };
}

/** 把 presentation intent 翻译为 open-panel route（`close`/`none` 返回 null）。 */
export function panelRouteForIntent(
  type: ExecutionPanelNodeType,
  nodeId: string,
  intent: PanelPresentationIntent
): CanvasPanelRoute | null {
  if (intent.kind === "expand" && type === "node-execution") {
    return { type: "node-execution", nodeId, presentation: "expanded" };
  }
  if (intent.kind === "collapse" && type === "node-execution") {
    return { type: "node-execution", nodeId, presentation: "compact" };
  }
  return null;
}

/** 关闭时用于匹配 identity 的 panel 类型。 */
export function panelTypeForNodeType(type: ExecutionPanelNodeType): CanvasPanelType {
  return type;
}

/**
 * Escape intent：按最内层状态向外，一次只前进一步。
 *
 * 1) 参考 picker 打开 → 关闭 picker（由 picker 表面消费，返回 `none`）；
 * 2) panel-local 菜单打开 → 关闭菜单（由菜单表面消费，返回 `none`）；
 * 3) expanded → 收起；
 * 4) compact → 关闭。
 */
export function planEscapeIntent(input: {
  type: ExecutionPanelNodeType;
  presentation: ExecutionPanelPresentation;
  localSurface: PanelLocalSurface;
}): PanelPresentationIntent {
  if (input.localSurface.picker || input.localSurface.overlay) return { kind: "none" };
  if (input.type === "node-execution" && input.presentation === "expanded") {
    return { kind: "collapse" };
  }
  return { kind: "close" };
}
