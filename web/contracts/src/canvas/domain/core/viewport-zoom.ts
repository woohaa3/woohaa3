import { getWoohaa3CanvasSelectionBounds } from "./group-ops";
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import type { Woohaa3CanvasPosition, Woohaa3CanvasViewport } from "./document-schema";

export const WOOHAA3_CANVAS_MIN_ZOOM = 0.1;
export const WOOHAA3_CANVAS_MAX_ZOOM = 12;
export const WOOHAA3_CANVAS_ZOOM_STEP = 1.2;

export function clampWoohaa3CanvasZoom(zoom: number): number {
  return Math.min(WOOHAA3_CANVAS_MAX_ZOOM, Math.max(WOOHAA3_CANVAS_MIN_ZOOM, zoom));
}

export function zoomViewportAroundScreenPoint(
  viewport: Woohaa3CanvasViewport,
  nextZoom: number,
  screenPoint: Woohaa3CanvasPosition
): Woohaa3CanvasViewport {
  const zoom = clampWoohaa3CanvasZoom(nextZoom);
  if (viewport.zoom <= 0 || Math.abs(zoom - viewport.zoom) < 1e-9) return { ...viewport, zoom };
  const scale = zoom / viewport.zoom;
  return {
    x: screenPoint.x - (screenPoint.x - viewport.x) * scale,
    y: screenPoint.y - (screenPoint.y - viewport.y) * scale,
    zoom
  };
}

export function canvasPointToScreen(point: Woohaa3CanvasPosition, viewport: Woohaa3CanvasViewport): Woohaa3CanvasPosition {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

export function screenPointToCanvas(point: Woohaa3CanvasPosition, viewport: Woohaa3CanvasViewport): Woohaa3CanvasPosition {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

export function getSelectedNodesCanvasCenter(
  nodes: Woohaa3CanvasNode[],
  selectedNodeIds: readonly string[]
): Woohaa3CanvasPosition | null {
  if (selectedNodeIds.length === 0) return null;
  const selectedIds = new Set(selectedNodeIds);
  const bounds = getWoohaa3CanvasSelectionBounds(nodes.filter((node) => selectedIds.has(node.id)), nodes);
  return bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : null;
}

export function resolveZoomScreenAnchor(options: {
  nodes: Woohaa3CanvasNode[];
  selectedNodeIds: readonly string[];
  viewport: Woohaa3CanvasViewport;
  hostSize: { width: number; height: number } | null;
  fallbackScreenPoint?: Woohaa3CanvasPosition;
}): Woohaa3CanvasPosition {
  const selectedCenter = getSelectedNodesCanvasCenter(options.nodes, options.selectedNodeIds);
  if (selectedCenter) return canvasPointToScreen(selectedCenter, options.viewport);
  if (options.fallbackScreenPoint) return options.fallbackScreenPoint;
  return { x: (options.hostSize?.width ?? 0) / 2, y: (options.hostSize?.height ?? 0) / 2 };
}

export function zoomViewportToLevel(options: {
  viewport: Woohaa3CanvasViewport;
  nextZoom: number;
  nodes: Woohaa3CanvasNode[];
  selectedNodeIds: readonly string[];
  hostSize: { width: number; height: number } | null;
  fallbackScreenPoint?: Woohaa3CanvasPosition;
}): Woohaa3CanvasViewport {
  return zoomViewportAroundScreenPoint(
    options.viewport,
    options.nextZoom,
    resolveZoomScreenAnchor(options)
  );
}
