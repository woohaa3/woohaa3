/**
 * Materialize a trusted T10 world-capture binding as an ordinary task reference input.
 *
 * The capture pipeline proves the exact media identity (version key, storage key,
 * SHA-256 checksum, content type and byte size) before a binding can be claimed.
 * Generation acceptance must not stop at carrying that binding as metadata: the
 * provider has to receive the same bytes as a real reference image. This module is
 * the single pure mapping used by both the Canvas acceptance path and the Task
 * materialization path, so the identity is never re-derived or guessed in two places.
 *
 * A binding without the verified media envelope cannot be materialized; callers must
 * fail closed instead of falling back to the current camera framing or an older cache.
 */
import type { CanvasTaskInput } from "./dto.js";
import type { WorldCaptureGenerationBinding } from "../canvas/world-capture-pipeline-contract.js";

/** Role used for a static world framing consumed as image guidance. */
export const WORLD_CAPTURE_REFERENCE_ROLE = "reference_image" as const;
/** Role used for a dynamic world framing (frozen video asset). */
export const WORLD_CAPTURE_VIDEO_REFERENCE_ROLE = "reference_video" as const;

export type WorldCaptureReferenceInput =
  | { readonly ok: true; readonly input: CanvasTaskInput }
  | { readonly ok: false; readonly code: "capture-media-unavailable"; readonly message: string };

/**
 * Build the stable `CanvasTaskInput` for a claimed capture binding.
 *
 * `mediaId` is the content-addressed storage key produced by the trusted media save
 * port, and the v2 metadata carries the same key plus the exact MIME type. Nothing is
 * read from the canvas or from the current producer result.
 */
export function worldCaptureReferenceInput(
  binding: WorldCaptureGenerationBinding
): WorldCaptureReferenceInput {
  if (binding.video) {
    const video = binding.video;
    if (video.storageKey.trim() === "" || !video.contentType.startsWith("video/")) {
      return {
        ok: false,
        code: "capture-media-unavailable",
        message: "动态取景冻结结果缺少可信视频媒体元数据"
      };
    }
    if (video.checksum !== binding.input.checksum || video.mediaId !== binding.input.mediaId) {
      return {
        ok: false,
        code: "capture-media-unavailable",
        message: "动态取景冻结结果的媒体身份与版本不一致"
      };
    }
    return {
      ok: true,
      input: {
        assetId: binding.input.mediaId,
        role: WORLD_CAPTURE_VIDEO_REFERENCE_ROLE,
        storageKey: video.storageKey,
        mediaType: video.contentType,
        mediaKind: "video"
      }
    };
  }
  const media = binding.media;
  if (!media || media.storageKey.trim() === "" || !media.contentType.startsWith("image/")) {
    return {
      ok: false,
      code: "capture-media-unavailable",
      message: "取景冻结结果缺少可信媒体元数据"
    };
  }
  if (media.checksum !== binding.input.checksum || media.mediaId !== binding.input.mediaId) {
    return {
      ok: false,
      code: "capture-media-unavailable",
      message: "取景冻结结果的媒体身份与版本不一致"
    };
  }
  return {
    ok: true,
    input: {
      assetId: binding.input.mediaId,
      role: WORLD_CAPTURE_REFERENCE_ROLE,
      storageKey: media.storageKey,
      mediaType: media.contentType,
      mediaKind: "image"
    }
  };
}

/**
 * Append the capture reference once. Existing identical references (for example a
 * canvas input and a re-decoded HTTP payload) are preserved without duplication.
 */
export function withWorldCaptureTaskInput(
  inputs: readonly CanvasTaskInput[],
  binding: WorldCaptureGenerationBinding | undefined
): CanvasTaskInput[] {
  if (!binding) return [...inputs];
  const materialized = worldCaptureReferenceInput(binding);
  if (!materialized.ok) return [...inputs];
  const duplicate = inputs.some(
    (input) =>
      input.role === materialized.input.role &&
      input.storageKey === materialized.input.storageKey &&
      input.mediaType === materialized.input.mediaType
  );
  return duplicate ? [...inputs] : [...inputs, materialized.input];
}
