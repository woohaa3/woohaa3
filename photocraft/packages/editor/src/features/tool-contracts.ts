import type { FeatureAvailability } from "./contracts.js";

export type FeatureTarget = "pixels" | "mask";
export type FeatureToolContext = {
  readonly: boolean;
  mode: "rgb-u8";
  rotationDegrees: 0;
  target: FeatureTarget;
};

/** The current RGB/U8, unrotated editing contract. Other modes need an explicit integration. */
export function canRunTool(context: FeatureToolContext, targets: readonly FeatureTarget[] = ["pixels", "mask"]): FeatureAvailability {
  if (context.readonly) return { enabled: false, reason: "当前编辑器为只读" };
  if (!targets.includes(context.target)) return { enabled: false, reason: "工具不支持当前编辑目标" };
  return { enabled: true };
}

export const canRunPixelTool = (context: FeatureToolContext): FeatureAvailability => canRunTool(context, ["pixels"]);
