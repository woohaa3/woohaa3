/**
 * 普通 overview 纯视口增量 wire 协议
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
 *
 * 仅 pan/zoom 变化且世界几何不变时，Frontend 用**固定大小**的 `set_viewport` 请求替代完整
 * `set_scene`：携带明确 wire 版本、最近 full scene 的 `baseSceneGeneration` 与 `{x,y,zoom}`。
 * 本模块只定义版本常量、请求类型与编码；有限值/zoom/overview 校验与原子接受在 Rust 接受点。
 *
 * 固定大小意味着 payload 不随节点、边或模型规模增长（design D3 / spec「payload SHALL 独立于
 * 全场规模」）。版本与 Rust `bevy/src/protocol/viewport.rs` 的 `CANVAS_VIEWPORT_UPDATE_VERSION`
 * 必须逐字节一致；结构变化必须升版本，旧 WASM 由 loader 明确拒绝。
 */
import { clampWoohaa3CanvasZoom, WOOHAA3_CANVAS_MAX_ZOOM, WOOHAA3_CANVAS_MIN_ZOOM } from "./domain/core/viewport-zoom.js";
import type { Woohaa3CanvasViewport } from "./domain/core/document-schema.js";

/** 视口增量 wire 版本；与 Rust `CANVAS_VIEWPORT_UPDATE_VERSION` 一致。 */
export const CANVAS_VIEWPORT_UPDATE_VERSION = "woohaa-canvas-viewport-v1" as const;

/** 视口增量请求（与 Rust `ViewportUpdateRequest` 同构；camelCase wire 键）。 */
export type CanvasViewportUpdate = {
  version: typeof CANVAS_VIEWPORT_UPDATE_VERSION;
  /** 最近 full scene 的 generation（base 身份）；不匹配时 Rust 原子拒绝。 */
  baseSceneGeneration: number;
  viewport: Woohaa3CanvasViewport;
};

/** 与 Rust `ViewportUpdateRequest::validate` 一致的 zoom 区间。 */
export const CANVAS_VIEWPORT_MIN_ZOOM = WOOHAA3_CANVAS_MIN_ZOOM;
export const CANVAS_VIEWPORT_MAX_ZOOM = WOOHAA3_CANVAS_MAX_ZOOM;

/** 规范化视口为有限值并 clamp 到共享 zoom 区间（编码前防御；Rust 仍会独立校验）。 */
export function normalizeViewportUpdate(viewport: Woohaa3CanvasViewport): Woohaa3CanvasViewport {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  return {
    x: finite(viewport.x),
    y: finite(viewport.y),
    zoom: clampWoohaa3CanvasZoom(viewport.zoom)
  };
}

/**
 * 编码 `set_viewport` 请求 JSON。只接收 base 身份与视口；不携带节点/边/模型。
 * 输入先规范化为有限值并 clamp zoom，保证与 Rust 校验一致。
 */
export function canvasViewportUpdateRequest(input: {
  baseSceneGeneration: number;
  viewport: Woohaa3CanvasViewport;
}): string {
  const viewport = normalizeViewportUpdate(input.viewport);
  const request: CanvasViewportUpdate = {
    version: CANVAS_VIEWPORT_UPDATE_VERSION,
    baseSceneGeneration: Math.max(0, Math.trunc(input.baseSceneGeneration)),
    viewport
  };
  return JSON.stringify(request);
}
