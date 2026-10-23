/**
 * Bevy WASM interaction 查询适配
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D3/D8）。
 *
 * 只做 JSON 编码/解码与 generation 守卫：把坐标/模式跨边界交给 Rust，返回小型语义结果。
 * 从 `bevy-runtime.ts` 拆出以遵守文件体积守卫。
 */
import type { BevyModelEditor } from "@woohaa3/contracts";
import type { GizmoQueryInput } from "../canvas-shell/model-gizmo-hit.js";
import type {
  CompositeAssetScopeGeometryEntry,
  GizmoHitResult,
  PointHit,
  ProbeCandidate,
  QueryResult
} from "./bevy-runtime.js";
import { sceneDiagnostics } from "./scene-diagnostics.js";

/** Rust 查询结果的原始 JSON 包络（与 Rust serde 输出同构）。 */
export type QueryEnvelope<T> = {
  available: boolean;
  reason?: string | null;
  generation?: number;
  hit?: T | null;
  nodeIds?: string[];
  candidates?: T;
  nodeId?: string;
  itemId?: string;
  target?: [number, number, number];
  radius?: number;
  /** 通用 drop target 查询结果（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。 */
  targetNodeId?: string | null;
  /** 复合资产范围几何读取结果。 */
  scopes?: CompositeAssetScopeGeometryEntry[];
};

export type QueryBridge = {
  runQuery<T>(invoke: () => string, project: (payload: QueryEnvelope<T>) => T): QueryResult<T>;
  guardGeneration<T>(generation: number, invoke: () => QueryResult<T>): QueryResult<T>;
  currentGeneration(): number;
};

/** 构造查询桥：`currentGeneration` 返回当前已接受的 interaction generation。 */
export function createQueryBridge(currentGeneration: () => number): QueryBridge {
  const runQuery = <T>(invoke: () => string, project: (payload: QueryEnvelope<T>) => T): QueryResult<T> => {
    sceneDiagnostics.interactionQueries += 1;
    let raw: string;
    try {
      raw = invoke();
    } catch {
      sceneDiagnostics.interactionUnavailable += 1;
      return { ok: false, reason: "unavailable" };
    }
    let payload: QueryEnvelope<T>;
    try {
      payload = JSON.parse(raw) as QueryEnvelope<T>;
    } catch {
      sceneDiagnostics.interactionUnavailable += 1;
      return { ok: false, reason: "unavailable" };
    }
    if (!payload || payload.available !== true) {
      sceneDiagnostics.interactionUnavailable += 1;
      const reason =
        payload?.reason === "stale" ? "stale" : payload?.reason === "unsupported" ? "unsupported" : "unavailable";
      return { ok: false, reason };
    }
    return { ok: true, generation: payload.generation ?? currentGeneration(), value: project(payload) };
  };

  const guardGeneration = <T>(generation: number, invoke: () => QueryResult<T>): QueryResult<T> => {
    if (generation !== currentGeneration()) {
      sceneDiagnostics.interactionUnavailable += 1;
      return { ok: false, reason: "stale" };
    }
    return invoke();
  };

  return { runQuery, guardGeneration, currentGeneration };
}

/** gizmo 命中请求编码（与 Rust `gizmo_query_json` 契约同构）。 */
export function encodeGizmoRequest(input: GizmoQueryInput, generation = 0): string {
  const editor: BevyModelEditor | null = input.editor;
  return JSON.stringify({
    kind: input.kind,
    generation,
    editor,
    x: input.point.x,
    y: input.point.y,
    width: input.surface.width,
    height: input.surface.height,
    projection: input.projection ? {
      target: input.projection.target,
      yaw: input.projection.yaw,
      pitch: input.projection.pitch,
      distance: input.projection.distance
    } : null
  });
}

/** 点查询编码。 */
export function encodePointRequest(input: {
  generation: number;
  x: number;
  y: number;
  zoom: number;
  hoveredEdgeId?: string | null;
}): string {
  return JSON.stringify({
    generation: input.generation,
    x: input.x,
    y: input.y,
    zoom: input.zoom,
    ...(input.hoveredEdgeId ? { hoveredEdge: input.hoveredEdgeId } : {})
  });
}

/** 框选查询编码。 */
export function encodeMarqueeRequest(input: {
  generation: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return JSON.stringify(input);
}

/** probe 查询编码。 */
export function encodeProbeRequest(input: { generation: number; source: string; direction: string }): string {
  return JSON.stringify(input);
}

/** 通用 drop target 查询编码。 */
export function encodeDropTargetRequest(input: {
  generation: number;
  x: number;
  y: number;
  excludedIds?: readonly string[];
}): string {
  return JSON.stringify({
    generation: input.generation,
    x: input.x,
    y: input.y,
    excluded: [...(input.excludedIds ?? [])]
  });
}

/** 复合资产范围几何查询编码。 */
export function encodeCompositeAssetScopesRequest(input: { generation: number }): string {
  return JSON.stringify(input);
}

/** 通用 drop target 结果投影（success 且无目标 → null）。 */
export const projectDropTarget = (payload: QueryEnvelope<unknown>): string | null =>
  typeof payload.targetNodeId === "string" ? payload.targetNodeId : null;

/** 复合资产范围几何结果投影。 */
export const projectCompositeAssetScopes = (
  payload: QueryEnvelope<unknown>
): CompositeAssetScopeGeometryEntry[] => payload.scopes ?? [];

/** 模型 picking 查询编码。 */
export function encodeModelPickRequest(input: {
  generation: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return JSON.stringify(input);
}

/** 片场对象 picking 查询编码（change: 2026-10-09-add-film-set-object-motion-and-editing）。 */
export function encodeFilmSetItemPickRequest(input: {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number };
}): string {
  return JSON.stringify({
    nodeId: input.nodeId,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    projection: input.projection
  });
}

/** 点查询结果投影。 */
export const projectPoint = (payload: QueryEnvelope<PointHit | null>): PointHit | null => payload.hit ?? null;
/** 框选结果投影。 */
export const projectMarquee = (payload: QueryEnvelope<string[]>): string[] => payload.nodeIds ?? [];
/** probe 结果投影。 */
export const projectProbe = (payload: QueryEnvelope<ProbeCandidate[]>): ProbeCandidate[] => payload.candidates ?? [];
/** 模型 pick 结果投影。 */
export const projectModelPick = (
  payload: QueryEnvelope<unknown>
): { nodeId: string; target: [number, number, number]; radius: number } | null =>
  payload.nodeId && payload.target && payload.radius !== undefined
    ? { nodeId: payload.nodeId, target: payload.target, radius: payload.radius }
    : null;

/** 片场对象 pick 结果投影（change: 2026-10-09-add-film-set-object-motion-and-editing）。 */
export const projectFilmSetItemPick = (
  payload: QueryEnvelope<unknown>
): { nodeId: string; itemId: string } | null =>
  typeof payload.nodeId === "string" && typeof payload.itemId === "string"
    ? { nodeId: payload.nodeId, itemId: payload.itemId }
    : null;

/** 片场对象包围盒查询编码。 */
export function encodeFilmSetItemBoundsRequest(nodeId: string): string {
  return JSON.stringify({ nodeId });
}

/** 片场对象包围盒结果投影。 */
export const projectFilmSetItemBounds = (
  payload: { items?: Array<{ itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number; worldToLocal?: number[] }> }
): Array<{ itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number; worldToLocal?: number[] }> => payload.items ?? [];

/** 片场对象 picking 原始 JSON 调用（供 bevy-runtime 复用，减少体积）。 */
export function queryCompositeAssetItemPickRaw(
  module: {
    query_composite_asset_item_pick?: (json: string) => string;
  },
  input: {
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number };
  }
): string {
  return (module.query_composite_asset_item_pick ?? (() => ""))(encodeFilmSetItemPickRequest(input));
}

/** 片场对象包围盒原始调用（解析失败返回空数组）。 */
export function queryCompositeAssetItemBoundsRaw(
  module: {
    query_composite_asset_item_bounds?: (json: string) => string;
  },
  nodeId: string
): Array<{ itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number; worldToLocal?: number[] }> {
  if (!module.query_composite_asset_item_bounds) return [];
  try {
    return projectFilmSetItemBounds(
      JSON.parse(module.query_composite_asset_item_bounds(encodeFilmSetItemBoundsRequest(nodeId))) as never
    );
  } catch {
    return [];
  }
}

/** 解析 gizmo 命中结果（失败返回 null）。 */
export function parseGizmoResult(result: string | null | undefined): GizmoHitResult | null {
  if (!result) return null;
  try {
    return JSON.parse(result) as GizmoHitResult;
  } catch {
    return null;
  }
}
