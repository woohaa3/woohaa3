import { builtinNodeCapabilitiesForType } from "./builtin-node-capabilities.js";
import type { NodeCapabilities } from "./node-capabilities.js";
/** Shared card dimensions for rendering, API projections, placement and group bounds. */
import { minimumNodeSizeFor } from "./node-minimum-size.js";

export { minimumNodeSizeFor } from "./node-minimum-size.js";

export const RICH_CONTENT_NODE_SIZE = { width: 248, height: 232 } as const;
export const COMPACT_NODE_SIZE = { width: 196, height: 64 } as const;
/** Composite assets use this base rectangle to fit their content and scope. */
export const COMPOSITE_ASSET_DEFAULT_SIZE = { width: 260, height: 195 };

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
 * Visible card/base rectangle in canvas world units for 2D cards. Reading never rewrites stored
 * geometry. Models have no card: their world position comes from `sharedWorldInstance`, so this
 * only returns the nominal minimum box and never the retired 248×232 / 196×64 card expansion.
 * Transient controls outside the card are excluded.
 */
export function effectiveCanvasNodeSize(
  node: NodeDimensions & { type: string },
  override?: { width: number; height: number },
  capabilities: NodeCapabilities = builtinNodeCapabilitiesForType(node.type),
): { width: number; height: number } {
  const fallback = capabilities.appearance?.defaultSize ?? COMPACT_NODE_SIZE;
  const base = override ?? node;
  return {
    width: dimension(base.width, fallback.width, minimumNodeSizeFor(node.type).width),
    height: dimension(base.height, fallback.height, minimumNodeSizeFor(node.type).height),
  };
}
