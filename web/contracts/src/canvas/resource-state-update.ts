/** Presentation-only image state. Does not change geometry, content or query generations. */
export const CANVAS_RESOURCE_STATE_VERSION = "woohaa-canvas-resource-state-v1" as const;
export type CanvasNodeResourceState = { id: string; texture: boolean; mediaLoading: boolean };
export type CanvasResourceStateUpdate = {
  version: typeof CANVAS_RESOURCE_STATE_VERSION;
  baseSceneGeneration: number;
  nodes: readonly CanvasNodeResourceState[];
};
export function canvasResourceStateRequest(input: Omit<CanvasResourceStateUpdate, "version">): string {
  if (!Number.isInteger(input.baseSceneGeneration) || input.baseSceneGeneration <= 0 || input.baseSceneGeneration > 0xffffffff)
    throw new Error("Invalid resource state base");
  if (!input.nodes.length || input.nodes.length > 16384) throw new Error("Invalid resource state count");
  const ids = new Set<string>();
  const nodes = input.nodes.map(node => {
    if (!node.id || ids.has(node.id) || typeof node.texture !== "boolean" || typeof node.mediaLoading !== "boolean")
      throw new Error("Invalid resource state node");
    ids.add(node.id);
    return { id: node.id, texture: node.texture, mediaLoading: node.mediaLoading };
  });
  const json = JSON.stringify({ version: CANVAS_RESOURCE_STATE_VERSION, baseSceneGeneration: input.baseSceneGeneration, nodes });
  if (new TextEncoder().encode(json).byteLength > 1024 * 1024) throw new Error("Resource state payload too large");
  return json;
}
