/**
 * File Info 已知字段与按格式的元数据保留矩阵（本域纯数据）
 * （change: 2026-10-22-add-photocraft-file-workflows，U04 / design D3）。
 *
 * 字段集合与上限与内核 `file.fileInfo` 一致：超出即拒绝，不静默截断。矩阵只声明**上游真实**
 * 行为（`photocraft/rust` 固定提交的编码器实现），供界面在保存/导出前如实提示损失，
 * 不声称所有格式都保留元数据。
 */

/** 可写的 File Info 字段（顺序即界面顺序）。 */
export const FILE_INFO_FIELDS = [
  "title",
  "author",
  "authorTitle",
  "description",
  "keywords",
  "copyright",
  "copyrightStatus",
  "copyrightUrl"
] as const;

export type FileInfoField = (typeof FILE_INFO_FIELDS)[number];

/** 版权状态取值（与内核一致）。 */
export const FILE_INFO_COPYRIGHT_STATES = ["unknown", "copyrighted", "publicDomain"] as const;

/** 元数据上限（与内核 `features/files/tools.rs` 同值）。 */
export const FILE_INFO_LIMITS = {
  maxFieldChars: 4096,
  maxKeywords: 256,
  maxKeywordChars: 256,
  maxTotalChars: 64 * 1024
} as const;

/** 只读的相机信息（来自来源文件 EXIF，本域不写）。 */
export type FileInfoCamera = {
  make?: string;
  model?: string;
  dateTaken?: string;
  exposure?: string;
  fNumber?: string;
  iso?: string;
  focalLength?: string;
  focalLength35mm?: string;
  lens?: string;
};

/** 一次 File Info 读取结果：已知字段 + 只读相机块。缺省字段省略。 */
export type FileInfo = Partial<Record<FileInfoField, string | readonly string[]>> & { camera?: FileInfoCamera };

export type FileInfoPatchResult =
  | { ok: true; value: Partial<Record<FileInfoField, string | readonly string[]>> }
  | { ok: false; error: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 校验一次 File Info 写入。
 *
 * 只接受已知字段、拒绝未知键（拼写错误不能静默变成只读）；空白字符串表示清空该字段。
 */
export function validateFileInfoPatch(input: unknown): FileInfoPatchResult {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "File Info 参数必须是对象" };
  const patch: Partial<Record<FileInfoField, string | readonly string[]>> = {};
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!(FILE_INFO_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `未知的 File Info 字段 \`${key}\`` };
    }
    const field = key as FileInfoField;
    if (field === "keywords") {
      if (!isStringArray(value)) return { ok: false, error: "`keywords` 必须是字符串数组" };
      if (value.length > FILE_INFO_LIMITS.maxKeywords) {
        return { ok: false, error: `关键字最多 ${FILE_INFO_LIMITS.maxKeywords} 条` };
      }
      for (const keyword of value) {
        if (keyword.length > FILE_INFO_LIMITS.maxKeywordChars || keyword.includes("\0")) {
          return { ok: false, error: `单个关键字不能超过 ${FILE_INFO_LIMITS.maxKeywordChars} 个字符` };
        }
        total += keyword.length;
      }
      patch.keywords = [...value];
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: `\`${field}\` 必须是字符串` };
    if (value.length > FILE_INFO_LIMITS.maxFieldChars || value.includes("\0")) {
      return { ok: false, error: `\`${field}\` 不能超过 ${FILE_INFO_LIMITS.maxFieldChars} 个字符` };
    }
    if (field === "copyrightStatus" && !(FILE_INFO_COPYRIGHT_STATES as readonly string[]).includes(value)) {
      return { ok: false, error: "`copyrightStatus` 只能是 unknown、copyrighted 或 publicDomain" };
    }
    total += value.length;
    patch[field] = value;
  }
  if (total > FILE_INFO_LIMITS.maxTotalChars) {
    return { ok: false, error: `File Info 元数据累计不能超过 ${FILE_INFO_LIMITS.maxTotalChars} 个字符` };
  }
  return { ok: true, value: patch };
}

/** 保存/导出目标格式（只列本集成实际交付的写盘格式）。 */
export const FILE_INFO_FORMATS = ["pcraft", "psd", "png", "jpeg", "webp", "tiff", "ora", "other"] as const;

export type FileInfoFormat = (typeof FILE_INFO_FORMATS)[number];

type Support = {
  /** 已知 File Info 字段（XMP 包）。 */
  xmp: boolean;
  /** 来源 EXIF（含相机块）是否原样写回。 */
  exif: boolean;
  /** 自由文本元数据（PNG tEXt、TIFF ASCII）。 */
  text: boolean;
  note: string;
};

/**
 * 逐格式支持矩阵。
 *
 * 依据固定上游编码器：`.pcraft` 保留 XMP/EXIF/文本；PSD 保留 XMP 与 EXIF，自由文本被丢弃并
 * 在导出警告中说明；PNG（iTXt/eXIf/tEXt）、JPEG（APP1）、WebP、TIFF 保留；OpenRaster 明确
 * 不保存任何元数据；其余扁平格式没有元数据通道。
 */
export const FILE_INFO_FORMAT_SUPPORT: Record<FileInfoFormat, Support> = {
  pcraft: { xmp: true, exif: true, text: true, note: "工程文件保留 File Info、相机信息与自由文本" },
  psd: { xmp: true, exif: true, text: false, note: "PSD 保留 File Info 与相机信息；自由文本元数据会被丢弃" },
  png: { xmp: true, exif: true, text: true, note: "PNG 以 iTXt/eXIf/tEXt 保留 File Info、相机信息与自由文本" },
  jpeg: { xmp: true, exif: true, text: false, note: "JPEG 以 APP1 保留 File Info 与相机信息" },
  webp: { xmp: true, exif: true, text: false, note: "WebP 保留 File Info 与相机信息" },
  tiff: { xmp: true, exif: true, text: true, note: "TIFF 以标签保留 File Info、相机信息与自由文本" },
  ora: { xmp: false, exif: false, text: false, note: "OpenRaster 不保存元数据；需要保留请另存工程副本" },
  other: { xmp: false, exif: false, text: false, note: "该格式没有元数据通道，导出后 File Info 会丢失" }
};

export type FileInfoLoss = {
  /** 会被丢弃的内容（面向用户的短标签）。 */
  lost: readonly string[];
  /** 是否没有任何损失。 */
  complete: boolean;
  note: string;
};

/** 从文件名/扩展名得到矩阵条目；未知扩展名按 `other`。 */
export function fileInfoFormatOf(nameOrExtension: string): FileInfoFormat {
  const extension = nameOrExtension.trim().toLowerCase().replace(/^.*\./, "");
  switch (extension) {
    case "pcraft":
    case "psd":
    case "psb":
      return extension === "psb" ? "other" : (extension as FileInfoFormat);
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "tif":
    case "tiff":
    case "ora":
      return extension === "jpg" ? "jpeg" : extension === "tif" ? "tiff" : (extension as FileInfoFormat);
    default:
      return "other";
  }
}

/** 计算本次保存/导出会丢失的元数据；界面据此在写出前提示，而不是事后声称已保留。 */
export function describeFileInfoLoss(format: FileInfoFormat, hasFileInfo: boolean): FileInfoLoss {
  const support = FILE_INFO_FORMAT_SUPPORT[format];
  const lost: string[] = [];
  if (hasFileInfo && !support.xmp) lost.push("File Info（标题/作者/版权等）");
  if (!support.exif) lost.push("相机信息（EXIF）");
  if (!support.text) lost.push("自由文本元数据");
  return { lost, complete: lost.length === 0, note: support.note };
}
