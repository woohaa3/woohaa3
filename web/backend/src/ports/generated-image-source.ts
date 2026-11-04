/**
 * Codex 内建生图产物的路径与文件校验
 * （change: 2026-11-03-add-codex-image-import，D5）。
 *
 * `savedPath` 虽由宿主从 app-server 的 `imageGeneration` 事件读取，仍按不可信输入处理：
 * 1. 解析后必须位于 `<CODEX_HOME>/generated_images/` 之下（防 `../` 与绝对路径逃逸）；
 * 2. 必须是普通文件，拒绝符号链接；
 * 3. 魔数必须是 PNG 或 JPEG，不信任扩展名；
 * 4. 大小不超过上限。
 */
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** 单张产物的读取上限；超出需改为流式写入，本期不支持。 */
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

const MAGIC_BYTES = 8;

export type GeneratedImageRejection =
  | { ok: false; code: "path-outside-generated-images"; message: string }
  | { ok: false; code: "not-found"; message: string }
  | { ok: false; code: "not-regular-file"; message: string }
  | { ok: false; code: "not-an-image"; message: string; magic: string }
  | { ok: false; code: "too-large"; message: string }
  | { ok: false; code: "unreadable"; message: string };

export type GeneratedImageResolution =
  | { ok: true; path: string; contentType: "image/png" | "image/jpeg"; size: number }
  | GeneratedImageRejection;

type Input = { codexHome: string };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function contentTypeForMagic(magic: Buffer): "image/png" | "image/jpeg" | null {
  if (magic.length >= PNG_MAGIC.length && magic.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "image/png";
  if (magic.length >= JPEG_MAGIC.length && magic.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return "image/jpeg";
  return null;
}

/** 仅校验路径前缀；单独导出便于工具层在读取前快速拒绝。 */
export function isInsideGeneratedImages(candidate: string, input: Input): boolean {
  const imagesRoot = path.resolve(input.codexHome, "generated_images");
  const resolved = path.resolve(candidate);
  const relative = path.relative(imagesRoot, resolved);
  if (relative === "") return false;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 校验并解析一个生图产物；成功时返回可直接读取的绝对路径与内容类型。 */
export function resolveGeneratedImage(candidate: string, input: Input): GeneratedImageResolution {
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  if (trimmed.length === 0) {
    return { ok: false, code: "not-found", message: "缺少生图产物路径" };
  }
  if (!isInsideGeneratedImages(trimmed, input)) {
    return { ok: false, code: "path-outside-generated-images", message: `生图产物必须位于 ${path.resolve(input.codexHome, "generated_images")} 之下` };
  }
  const resolved = path.resolve(trimmed);

  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") return { ok: false, code: "not-found", message: "生图产物不存在" };
    return { ok: false, code: "unreadable", message: `读取生图产物失败：${(error as Error).message}` };
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { ok: false, code: "not-regular-file", message: "生图产物必须是普通文件（不接受符号链接或目录）" };
  }
  if (stats.size > MAX_GENERATED_IMAGE_BYTES) {
    return { ok: false, code: "too-large", message: `生图产物超过上限 ${MAX_GENERATED_IMAGE_BYTES} 字节` };
  }

  let magic: Buffer;
  try {
    const fd = openSync(resolved, "r");
    try {
      magic = Buffer.alloc(MAGIC_BYTES);
      const read = readSync(fd, magic, 0, MAGIC_BYTES, 0);
      magic = magic.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { ok: false, code: "unreadable", message: `读取生图产物失败：${(error as Error).message}` };
  }

  const contentType = contentTypeForMagic(magic);
  if (!contentType) {
    return { ok: false, code: "not-an-image", message: "生图产物不是 PNG 或 JPEG", magic: magic.toString("hex") };
  }
  return { ok: true, path: resolved, contentType, size: stats.size };
}
