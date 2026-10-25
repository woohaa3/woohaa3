/** Shared card dimensions for rendering, API projections, placement and group bounds. */
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./domain/core/node-factory.js";
import { isCompositeAssetNodeType } from "./domain/core/composite-asset-identity.js";

export const RICH_CONTENT_NODE_SIZE = { width: 248, height: 232 } as const;
export const COMPACT_NODE_SIZE = { width: 196, height: 64 } as const;
export const MODEL_PREVIEW_MIN_HEIGHT = 160;
/** Composite assets use this base rectangle to fit their content and scope. */
export const COMPOSITE_ASSET_DEFAULT_SIZE = { width: 260, height: 195 };

/** Minimum applies to explicit writes and derived display sizes, never rewrites records. */
export function minimumNodeSizeFor(type: string): { width: number; height: number } {
  return isCompositeAssetNodeType(type) ? { width: 200, height: 150 } : { width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT };
}

type NodeDimensions = { width?: number; height?: number };
function dimension(
  value: number | undefined,
  fallback: number,
  minimum: number,
) {
  return Math.max(
    minimum,
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback,
  );
}

/** Canonical base rectangle; composite assets do not have preview cards. */
export function compositeAssetNodeBoxSize(node: NodeDimensions): {
  width: number;
  height: number;
} {
  return {
    width: dimension(
      node.width,
      COMPOSITE_ASSET_DEFAULT_SIZE.width,
      minimumNodeSizeFor("composite-asset").width,
    ),
    height: dimension(
      node.height,
      COMPOSITE_ASSET_DEFAULT_SIZE.height,
      minimumNodeSizeFor("composite-asset").height,
    ),
  };
}

/**
 * Visible card/base rectangle in canvas world units. Reading never rewrites stored geometry.
 * Old model3d cards expand to the preview default; explicit resize previews bypass that expansion.
 * Group rectangles retain their stored size. Transient controls outside the card are excluded.
 */
export function effectiveCanvasNodeSize(
  node: NodeDimensions & { type: string },
  override?: { width: number; height: number },
): { width: number; height: number } {
  const preview = node.type === "model3d";
  const rich =
    preview || ["text", "image", "audio", "video"].includes(node.type);
  const fallback = isCompositeAssetNodeType(node.type)
    ? COMPOSITE_ASSET_DEFAULT_SIZE
    : rich
      ? RICH_CONTENT_NODE_SIZE
      : COMPACT_NODE_SIZE;
  const legacyPreview =
    preview && (node.height ?? COMPACT_NODE_SIZE.height) <= 116;
  const base = override ?? (legacyPreview ? fallback : node);
  const group = node.type === "group";
  return {
    width: dimension(base.width, fallback.width, group ? 0 : minimumNodeSizeFor(node.type).width),
    height: dimension(
      base.height,
      fallback.height,
      group ? 0 : preview ? MODEL_PREVIEW_MIN_HEIGHT : minimumNodeSizeFor(node.type).height,
    ),
  };
}
