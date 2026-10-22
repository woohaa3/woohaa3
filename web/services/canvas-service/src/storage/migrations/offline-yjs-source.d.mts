export class OfflineCanvasSourceError extends Error {
  code: string;
  canvasId: string | undefined;
  details: Record<string, unknown>;
}
export function readOfflineYjsCanvasSource(input: unknown): unknown;
export function loadOfflineYjsCanvasSources(db: unknown, options?: { transaction?: boolean }): unknown;
