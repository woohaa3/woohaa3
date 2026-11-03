import type { ServerCanvas } from "@woohaa3/contracts";

export class OfflineCanvasSourceError extends Error {
  code: string;
  canvasId: string | undefined;
  details: Record<string, unknown>;
}
/**
 * "当前 codec 从同一份 raw 会写出的 projection"。
 *
 * `canvas` 是离线 reader 从 raw 重建的规范聚合；无法派生时返回 null（调用方按不一致处理）。
 */
export type OfflineProjectionDerivation = (canvas: ServerCanvas, canvasId: string | undefined) => unknown;
export function readOfflineYjsCanvasSource(input: {
  document: unknown;
  updates: readonly unknown[];
  deriveProjection?: OfflineProjectionDerivation;
  repairProjection?: boolean;
}): unknown;
export function loadOfflineYjsCanvasSources(
  db: unknown,
  options?: { transaction?: boolean; deriveProjection?: OfflineProjectionDerivation; repairProjection?: boolean }
): unknown;
