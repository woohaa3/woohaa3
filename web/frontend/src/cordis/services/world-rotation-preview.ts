import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";

/** Page-local optimistic rotation. The authority and the working document remain untouched. */
let preview: { canvasId: string; data: ReadonlyMap<string, CanvasNodeData> } | null = null;

export function setWorldRotationPreview(value: typeof preview): void { preview = value; }

export function projectWorldRotationPreview(canvas: ServerCanvas | null): ServerCanvas | null {
  if (!canvas || preview?.canvasId !== canvas.id) return canvas;
  return { ...canvas, nodeData: { ...canvas.nodeData, ...Object.fromEntries(preview.data) } };
}
