import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./domain/core/node-factory.js";

/** Minimum applies to explicit writes and derived display sizes, never rewrites records. */
export function minimumNodeSizeFor(type: string): { width: number; height: number } {
  return type === COMPOSITE_ASSET_NODE_TYPE
    ? { width: 200, height: 150 }
    : { width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT };
}
