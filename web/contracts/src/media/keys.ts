/**
 * Media 对象键与媒体类型契约（change: split-web-runtime-services，任务 1.3）。
 *
 * 键形态与允许类型是 Canvas、Task、Media 三方都要在**发协议之前**判定的事实，
 * 因此放在 contracts，而不是任一服务的实现里（design D7）。
 */
import { GENERATED_OUTPUT_KEY_PATTERN, MEDIA_STORAGE_KEY_PATTERN } from "../validation.js";

export { GENERATED_OUTPUT_KEY_PATTERN, MEDIA_STORAGE_KEY_PATTERN };

/** 内容寻址键前缀（用户上传/迁移的媒体）。 */
export const STORAGE_KEY_PREFIX = "sha256-" as const;

/** 任务生成结果的对象键前缀。 */
export const GENERATED_OUTPUT_KEY_PREFIX = "generation-outputs/" as const;

/** 单次上传上限（256 MiB）。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** 各媒体类别的默认输出上限。 */
export const DEFAULT_MAX_OUTPUT_BYTES = {
  image: 32 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
  video: 256 * 1024 * 1024
} as const;

/** 允许的媒体类型白名单。 */
export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/x-npz",
  "model/gltf-binary",
  "application/octet-stream"
] as const;

export function isAllowedMediaType(type: string, allowed: readonly string[] = ALLOWED_MEDIA_TYPES): boolean {
  return allowed.includes(type);
}

/** 去掉 `; charset=...` 参数并转小写。 */
export function normalizeMediaType(raw: string | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

/** 内容寻址键：只依赖内容哈希。 */
export function computeStorageKey(checksumHex: string): string {
  return `${STORAGE_KEY_PREFIX}${checksumHex}`;
}

/** 生成结果键：内容寻址 + 受控扩展名。 */
export function computeGeneratedStorageKey(checksumHex: string, extension: string): string {
  return `${GENERATED_OUTPUT_KEY_PREFIX}${checksumHex}.${extension}`;
}

/** 扩展名 → 内容类型（生成结果下载/展示用）。 */
export function extensionForMediaType(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "m4a";
    case "application/x-npz":
      return "npz";
    case "model/gltf-binary":
      return "glb";
    default:
      return "png";
  }
}

/** 媒体类别判定（用于上限与扩展名）。 */
export function mediaKindForType(contentType: string): "image" | "video" | "audio" | "text" | "other" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/json") return "text";
  return "other";
}
