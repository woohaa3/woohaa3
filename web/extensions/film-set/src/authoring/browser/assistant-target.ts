import { filmSetClipHash, type FilmSetAnimationClip, type ModelCamera } from "@woohaa3/contracts";

/** Capture the task page, not just the container node type. Never broaden a missing selection. */
export function resolveFilmSetAssistantTarget(input: {
  tab: "object" | "animation" | "camera";
  clip: FilmSetAnimationClip | undefined;
  selectedItemId: string | null;
  selectedCameraId: string | null;
  cameras: readonly ModelCamera[];
}) {
  if (input.tab === "camera") {
    // 镜头属于片场 clip 的 initialCamera，不再作为独立的 camera 目标模式。
    // 保留 camera 列表参数只用于校验旧调用方传入的选择；新的 entry 只冻结 clip。
    const cameraId = input.selectedCameraId;
    const valid = cameraId ? input.cameras.some(camera => camera.id === cameraId) : input.cameras.length === 0;
    return { mode: "film-set" as const, clipId: input.clip?.id ?? null, itemId: null,
      selectedCameraId: null, expectedContentHash: input.clip ? filmSetClipHash(input.clip) : undefined,
      blockedReason: valid ? null : "所选镜头已失效，请明确选择镜头后再调整。" };
  }
  const itemId = input.tab === "object" ? input.selectedItemId : null;
  return { mode: "film-set" as const, clipId: input.clip?.id ?? null, itemId, selectedCameraId: null,
    ...(input.clip ? { expectedContentHash: filmSetClipHash(input.clip) } : {}),
    blockedReason: !input.clip ? "该片场节点还没有可写入的动画片段，请先创建动画片段。"
      : itemId && !input.clip.bindings.some(binding => binding.itemId === itemId)
        ? "所选对象未绑定在当前动画片段，无法直接修改其动作。" : null };
}
