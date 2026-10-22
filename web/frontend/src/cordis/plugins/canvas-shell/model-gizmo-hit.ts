/**
 * 模型/镜头/焦点 gizmo 命中测试
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 model-gesture-family 拆出；
 *   change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.3/5.4 迁至 Rust）。
 *
 * 命中与轴拖动约束由 Bevy WASM `query_gizmo_hit` 用同一相机、bounds 与 gizmo 表示计算
 * （design D5）。本模块只组装请求、解释稳定 handle，不再构造 Bevy projector；相机选择与
 * 手柄语义（主观察相机透视投影、注视点中心拖动）与主画面一致。
 */
import type { BevyModelEditor, ModelFocusProjection } from "@woohaa3/contracts";
import type { GizmoHitResult } from "../canvas-runtime/bevy-runtime.js";

export type Surface = { width: number; height: number };

/** gizmo 运行时查询入口（由 canvas controller 注入）。 */
export type GizmoQueryInput = {
  /** 查询种类：`model` / `object` / `shot` / `focus`。 */
  kind: "model" | "object" | "shot" | "focus";
  editor: BevyModelEditor | null;
  projection: Pick<ModelFocusProjection, "target" | "yaw" | "pitch" | "distance"> | null;
  surface: Surface;
  point: { x: number; y: number };
};
export type GizmoQuery = (input: GizmoQueryInput) => GizmoHitResult | null;

/**
 * 命中镜头 shot gizmo 时返回 handle（orbit-ring / elevation-ring / distance）。
 * 使用主观察相机的透视投影，与主画面 gizmo 一致。
 */
export function hitShotGizmoHandle(input: {
  editor: BevyModelEditor | null;
  projection: ModelFocusProjection | null;
  point: { x: number; y: number };
  surface: { width: number; height: number };
  query: GizmoQuery;
}): "orbit-ring" | "elevation-ring" | "distance" | null {
  const editor = input.editor;
  if (!editor || editor.toolMode !== "camera" || !editor.shot) return null;
  if (!input.projection) return null;
  const result = input.query({
    kind: "shot",
    editor,
    projection: input.projection,
    surface: input.surface,
    point: input.point
  });
  if (!result || !result.available || !result.handle) return null;
  // 拖水平环改变方位；拖竖直半圆改变仰角；拖相机本体或径向连线改变距离。
  if (result.handle === "orbit-ring") return "orbit-ring";
  if (result.handle === "elevation-ring") return "elevation-ring";
  return "distance";
}

/** 使用主观察相机投影命中注视点三轴与中心；线条变细不缩小鼠标抓取范围。 */
export function hitFocusGizmoAxis(input: {
  editor: BevyModelEditor | null;
  projection: ModelFocusProjection | null;
  surface: { width: number; height: number };
  point: { x: number; y: number };
  query: GizmoQuery;
}): "x" | "y" | "z" | "center" | null {
  const editor = input.editor;
  if (!editor || editor.toolMode !== "camera" || !editor.shot) return null;
  if (!input.projection) return null;
  const result = input.query({
    kind: "focus",
    editor,
    projection: input.projection,
    surface: input.surface,
    point: input.point
  });
  if (!result || !result.available || !result.handle) return null;
  const handle = result.handle;
  return handle === "x" || handle === "y" || handle === "z" || handle === "center" ? handle : null;
}
