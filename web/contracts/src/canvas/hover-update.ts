export const CANVAS_HOVER_UPDATE_VERSION = "woohaa-canvas-hover-v1" as const;
export type CanvasHoverUpdate = {
  version: typeof CANVAS_HOVER_UPDATE_VERSION;
  baseSceneGeneration: number;
  hover: { nodeId?: string | null; port?: "input" | "output" | null; edgeId?: string | null; cursor?: { x: number; y: number } | null } | null;
};
export function canvasHoverUpdateRequest(input: Omit<CanvasHoverUpdate, "version">): string {
  return JSON.stringify({ version: CANVAS_HOVER_UPDATE_VERSION, baseSceneGeneration: Math.max(0, Math.trunc(input.baseSceneGeneration)), hover: input.hover } satisfies CanvasHoverUpdate);
}
