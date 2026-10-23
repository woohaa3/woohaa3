import { roundPixel } from "../shared/tool-parameters.js";

/** `type.create` 参数。 */
export function buildTextCreate(input: {
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  bold?: boolean;
  font?: "Noto Sans SC" | "Inter";
}): Record<string, unknown> {
  return {
    x: roundPixel(input.x),
    y: roundPixel(input.y),
    text: input.text,
    size: Math.max(1, input.size),
    color: input.color,
    align: input.align,
    fauxBold: input.bold ?? false,
    font: input.font ?? "Noto Sans SC"
  };
}
