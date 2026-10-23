import { VECTOR_TOOLS } from "./vectors/vector-tools.js";

/** 工具按钮、默认键位和 Shift 循环共用的工具族。 */
export const TOOL_GROUPS: readonly (readonly string[])[] = [
  ["marquee"], ["lasso", "polygon-lasso", "magnetic-lasso"],
  ["wand", "quick"], ["brush", "pencil", "colorReplacement"],
  ["eraser", "backgroundEraser", "magicEraser"], ["gradient", "bucket"],
  ["heal", "retouch"], ["pen", "pen-freeform", "pen-curvature"],
  ...[...new Set(VECTOR_TOOLS.map(tool => tool.group))].filter(group => group !== "pen")
    .map(group => VECTOR_TOOLS.filter(tool => tool.group === group).map(tool => tool.id))
];

export function toolFamily(tool: string): readonly string[] {
  return TOOL_GROUPS.find(group => group.includes(tool)) ?? [tool];
}
