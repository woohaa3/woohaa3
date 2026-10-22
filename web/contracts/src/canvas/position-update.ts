/** Absolute local previews; no canonical edit or resource registration. */
import type { Woohaa3CanvasViewport } from "./domain/core/document-schema.js";
import { CANVAS_VIEWPORT_MIN_ZOOM, CANVAS_VIEWPORT_MAX_ZOOM } from "./viewport-update.js";

export const CANVAS_POSITION_UPDATE_VERSION = "woohaa-canvas-position-v1" as const;
export const CANVAS_POSITION_MAX_UPDATES = 16_384;
export const CANVAS_POSITION_MAX_BYTES = 1024 * 1024;
export type CanvasNodePosition = { id: string; x: number; y: number };
export type CanvasPositionUpdate = {
  version: typeof CANVAS_POSITION_UPDATE_VERSION;
  baseSceneGeneration: number;
  /** Includes affected descendants as absolute positions, never relative deltas. */
  positions: readonly CanvasNodePosition[];
  viewport?: Woohaa3CanvasViewport;
};

export function canvasPositionUpdateRequest(input: Omit<CanvasPositionUpdate, "version">): string {
  if (!Number.isInteger(input.baseSceneGeneration) || input.baseSceneGeneration <= 0 || input.baseSceneGeneration > 0xffffffff) {
    throw new Error("Invalid position base generation");
  }
  if (!input.positions.length || input.positions.length > CANVAS_POSITION_MAX_UPDATES) throw new Error("Invalid position update count");
  const ids = new Set<string>();
  const positions = input.positions.map(p => {
    if (!p.id || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("Invalid position values");
    if (ids.has(p.id)) throw new Error("Duplicate position node");
    ids.add(p.id);
    return { id: p.id, x: p.x, y: p.y };
  });
  const viewport = input.viewport;
  if (viewport && (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite)
      || viewport.zoom < CANVAS_VIEWPORT_MIN_ZOOM || viewport.zoom > CANVAS_VIEWPORT_MAX_ZOOM)) {
    throw new Error("Invalid position viewport");
  }
  const request: CanvasPositionUpdate = {
    version: CANVAS_POSITION_UPDATE_VERSION, baseSceneGeneration: input.baseSceneGeneration, positions,
    ...(viewport ? { viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } } : {})
  };
  const json = JSON.stringify(request);
  if (new TextEncoder().encode(json).byteLength > CANVAS_POSITION_MAX_BYTES) throw new Error("Position payload too large");
  return json;
}
