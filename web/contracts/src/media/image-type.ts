/**
 * 按字节签名识别图片真实格式。
 *
 * 生成链路的 provider 声明不可信：URL 产出下载后只剩字节，部分适配器只写 `mimeType`，
 * 其余情况会退回 `image/png` 默认值。字节是唯一权威事实，落库前与读取前都应以这里的结果为准。
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 识别受支持的图片家族；未知或过短的输入返回 `null`（不猜、不回落）。 */
export function readImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  // ISO-BMFF：`ftyp` 之后的 brand 决定 avif。
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && (ascii(bytes, 8, 4) === "avif" || ascii(bytes, 8, 4) === "avis")) return "image/avif";
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]!);
  return text;
}
