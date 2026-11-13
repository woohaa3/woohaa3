/**
 * 浏览器 2D 坐标换算与节点尺寸共享 helper
 * （change: replace-godot-canvas-runtime-with-bevy；
 *   change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
 *
 * 原 `hitTest` / `selectInRect` / `curvePoints` / `portPosition` / `hitRadius` 已迁至 Bevy WASM
 * interaction query（`BevyRuntime.queryPoint` / `queryMarquee` / `queryProbe`）：绘制与命中现在
 * 共用同一 Rust 实现，不再维护 48/64 段两套贝塞尔采样。本文件只保留与几何事实源无关的
 * 纯坐标换算、节点尺寸与语义 hit 类型别名（供测试与宿主复用）。
 */
import { bevyNodeSize, type BevyNodeKind } from "@woohaa3/contracts";
import type { PointHit } from "../canvas-runtime/bevy-runtime.js";

export type Point = { x: number; y: number };

/** 世界坐标矩形（拖入/合并候选与工作区包围盒共用）。 */
export type DropRect = { x: number; y: number; width: number; height: number };

/**
 * 2D 命中语义目标：与 Rust `PointHit` 同构
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
 */
export type HitTarget = PointHit;

/** 屏幕坐标 → 世界坐标（与 Bevy Camera2d 共用 viewport）。 */
export function screenToWorld(point: Point, viewport: { x: number; y: number; zoom: number }): Point {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

/** 世界坐标 → 屏幕坐标。 */
export function worldToScreen(point: Point, viewport: { x: number; y: number; zoom: number }): Point {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

/** 卡片级命中的节点身份：指针落在该节点本体上（`node`）。 */
export function cardHitNodeId(hit: HitTarget | null): string | null {
  if (!hit) return null;
  return hit.kind === "node" ? hit.nodeId : null;
}

/** 取节点实际尺寸（优先快照携带的 width/height）。 */
export function nodeSize(node: { type: BevyNodeKind; width?: number; height?: number }): { width: number; height: number } {
  const fallback = bevyNodeSize(node.type);
  return {
    width: node.width && node.width > 0 ? node.width : fallback.width,
    height: node.height && node.height > 0 ? node.height : fallback.height
  };
}
