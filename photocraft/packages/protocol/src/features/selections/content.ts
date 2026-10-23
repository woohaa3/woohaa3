import { HASH16 } from "../shared/content.js";

/** 蒙版摘要：只描述状态与来源像素摘要，不含蒙版像素。 */
export type ImageProjectMaskSummary = {
  linked?: boolean;
  enabled: boolean;
  /** 蒙版来源：选区转换/手工绘制。 */
  origin: "selection" | "paint";
  /** 蒙版内容指纹（编辑器上报；宿主只比较）。 */
  contentHash: string;
};

/** 返回 `"none"` 表示无蒙版；`null` 表示非法。 */
export function canonicalizeMask(mask: ImageProjectMaskSummary | null): string | null {
  if (mask === null) return "none";
  if (typeof mask !== "object") return null;
  if (typeof mask.enabled !== "boolean") return null;
  if (mask.linked !== undefined && typeof mask.linked !== "boolean") return null;
  if (mask.origin !== "selection" && mask.origin !== "paint") return null;
  if (typeof mask.contentHash !== "string" || !HASH16.test(mask.contentHash)) return null;
  return `mask:${mask.enabled ? "1" : "0"}:${mask.origin}:${mask.contentHash}${mask.linked === false ? ":unlinked" : ""}`;
}
