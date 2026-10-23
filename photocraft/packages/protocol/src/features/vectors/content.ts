import { HASH16, round } from "../shared/content.js";

/** 形状层摘要：路径几何身份 + 可选的持久外观（填充/描边/规范参数）。 */
export type ImageProjectShapeSummary = {
  contentHash: string;
  /** 填充/描边/规范参数的摘要；省略时只按几何比较（旧内容描述指纹不变）。 */
  appearanceHash?: string | null;
};


/** 矢量蒙版摘要：状态、几何身份与持久外观（密度/羽化），不含路径点。 */
export type ImageProjectVectorMaskSummary = {
  enabled: boolean;
  linked?: boolean;
  contentHash: string;
  /** 密度 `0..=1`；省略时与旧指纹一致。 */
  density?: number | null;
  /** 羽化半径 px，`0..=1000`；省略时与旧指纹一致。 */
  feather?: number | null;
};

/** 形状层：路径几何以内容摘要参与身份，外观摘要作为可选后缀。 */
export function canonicalizeShape(shape: ImageProjectShapeSummary | null | undefined): string | null {
  if (!shape || typeof shape !== "object") return null;
  if (typeof shape.contentHash !== "string" || !HASH16.test(shape.contentHash)) return null;
  if (shape.appearanceHash === undefined || shape.appearanceHash === null) return `shape:${shape.contentHash}`;
  if (typeof shape.appearanceHash !== "string" || !HASH16.test(shape.appearanceHash)) return null;
  return `shape:${shape.contentHash}:appearance:${shape.appearanceHash}`;
}

/**
 * 矢量蒙版：`""` 表示没有；`null` 表示非法。旧工程省略该字段，指纹保持兼容。
 *
 * 密度/羽化是持久字段（重开后逐字段还原），出现时按与内核相同的范围裁定并参与指纹。
 */
export function canonicalizeVectorMask(mask: ImageProjectVectorMaskSummary | null | undefined): string | null {
  if (mask == null) return "";
  if (typeof mask !== "object") return null;
  if (typeof mask.enabled !== "boolean") return null;
  if (mask.linked !== undefined && typeof mask.linked !== "boolean") return null;
  if (typeof mask.contentHash !== "string" || !HASH16.test(mask.contentHash)) return null;
  let extra = "";
  if (mask.density !== undefined && mask.density !== null) {
    if (!Number.isFinite(mask.density) || mask.density < 0 || mask.density > 1) return null;
    extra += `:density:${round(mask.density)}`;
  }
  if (mask.feather !== undefined && mask.feather !== null) {
    if (!Number.isFinite(mask.feather) || mask.feather < 0 || mask.feather > 1000) return null;
    extra += `:feather:${round(mask.feather)}`;
  }
  return `|vector:${mask.enabled ? 1 : 0}:${mask.contentHash}${mask.linked === false ? ":unlinked" : ""}${extra}`;
}

/** 已存命名路径摘要（与 Rust `document_paths_identity` 同形）。 */
export type ImageProjectNamedPathSummary = {
  name: string;
  contentHash: string;
};

/** 工作路径摘要：只有几何身份。 */
export type ImageProjectWorkPathSummary = { contentHash: string };

/** 裁切路径引用：指向已存命名路径，附导出平直度。 */
export type ImageProjectClippingPathSummary = { name: string; flatness: number };

/** 路径名必须是可见的非空短字符串（与核验器同一 200 字上限）。 */
function pathName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 200) return null;
  // 名字里的 NUL 会让 PSD 资源名截断，按非法处理而不是静默裁剪。
  if (value.includes("\0")) return null;
  return value;
}

/**
 * 已存命名路径：`paths:[<UTF-16 长度>:<名字>:<摘要>…]`。
 *
 * 省略或 `null` 返回空串（旧工程指纹不变）；结构非法返回 `null`。
 * 顺序不敏感：先按 `(名字, 摘要)` 的码点序排序。
 */
export function canonicalizeSavedPaths(paths: ImageProjectNamedPathSummary[] | null | undefined): string | null {
  if (paths === undefined || paths === null) return "";
  if (!Array.isArray(paths)) return null;
  // 空列表与省略等价：没有已存路径的工程不该因为「空数组 vs 缺字段」而被判成有净变化。
  if (paths.length === 0) return "";
  const entries: [string, string][] = [];
  for (const entry of paths) {
    if (!entry || typeof entry !== "object") return null;
    const name = pathName(entry.name);
    if (name === null) return null;
    if (typeof entry.contentHash !== "string" || !HASH16.test(entry.contentHash)) return null;
    entries.push([name, entry.contentHash]);
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  const body = entries.map(([name, hash]) => `${name.length}:${name}:${hash}`).join("");
  return `paths:[${body}]`;
}

/** 工作路径：只有几何摘要。 */
export function canonicalizeWorkPath(path: ImageProjectWorkPathSummary | null | undefined): string | null {
  if (path === undefined || path === null) return "";
  if (typeof path !== "object") return null;
  if (typeof path.contentHash !== "string" || !HASH16.test(path.contentHash)) return null;
  return `work:${path.contentHash}`;
}

/** 裁切路径引用：名字 + 平直度（与核验器同一 `0..=100` 范围）。 */
export function canonicalizeClippingPath(path: ImageProjectClippingPathSummary | null | undefined): string | null {
  if (path === undefined || path === null) return "";
  if (typeof path !== "object") return null;
  const name = pathName(path.name);
  if (name === null) return null;
  const flatness = path.flatness;
  if (typeof flatness !== "number" || !Number.isFinite(flatness) || flatness < 0 || flatness > 100) return null;
  return `clip:${name.length}:${name}:${round(flatness)}`;
}
