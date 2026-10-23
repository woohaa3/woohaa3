import { isFiniteNumberValue, round } from "../shared/content.js";

/** 归一化图层变换；角度与缩放保留固定精度。 */
export type ImageProjectTransform = {
  translateX: number;
  translateY: number;
  scale: number;
  rotationDegrees: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
};

export function canonicalizeTransform(transform: ImageProjectTransform): string | null {
  if (!transform || typeof transform !== "object") return null;
  if (!isFiniteNumberValue(transform.translateX) || !isFiniteNumberValue(transform.translateY)) return null;
  if (!isFiniteNumberValue(transform.scale) || transform.scale <= 0) return null;
  if (!isFiniteNumberValue(transform.rotationDegrees)) return null;
  if (typeof transform.flipHorizontal !== "boolean" || typeof transform.flipVertical !== "boolean") return null;
  return [
    String(round(transform.translateX)),
    String(round(transform.translateY)),
    String(round(transform.scale)),
    String(round(transform.rotationDegrees)),
    transform.flipHorizontal ? "1" : "0",
    transform.flipVertical ? "1" : "0"
  ].join(",");
}
