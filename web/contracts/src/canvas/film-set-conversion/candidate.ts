/**
 * 片场候选的结构与领域校验
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.4 / design D5）。
 *
 * 生成层（LLM）只在持久画布之外产出候选；进入权威事务前必须完整通过：片场 codec、模型
 * 可执行/静态性、资产引用（稳定、ready、种类匹配）、对象 ID/镜头/片段 binding 与预算。
 * 任一失败整份拒绝，绝不部分写入、绝不遗留空片场或中间节点。
 */
import type { FilmSetContent, FilmSetLocalTransform } from "../film-set-content.js";
import { decodeFilmSetContent, FILM_SET_GROUND_DEFAULT_SIZE } from "../film-set-content.js";
import { decodeFilmSetAnimations, emptyFilmSetAnimations, staticShotCameraMotion, type FilmSetAnimations } from "../film-set-animations.js";
import { decodeInitialShotCamera, type InitialShotCamera } from "../canvas-node-model.js";
import { SHOT_CAMERA_MAX_ELEVATION, SHOT_CAMERA_MIN_ELEVATION } from "../model-cameras.js";
import { validateSelfContainedModel } from "../model-validity.js";
import { isJsonObject, isFiniteNumber } from "../../validation.js";
import type { ServerCanvas } from "../domain/types.js";

/** LLM 产出的片场候选（不完整；由服务端补齐 title/placement 后 commit）。 */
export type FilmSetConversionCandidate = {
  filmSetContent: unknown;
  filmSetAnimations?: unknown;
  sceneCamera?: unknown;
  /** 内容质量说明（如「已生成场景，部分动作未还原」）。 */
  note?: string;
};

/** 候选校验提交值：完整、自包含、可直接进入权威事务。 */
export type ValidatedFilmSetConversionCandidate = {
  filmSetContent: FilmSetContent;
  filmSetAnimations: FilmSetAnimations;
  sceneCamera: InitialShotCamera;
  note?: string;
};

export type FilmSetConversionCandidateResult =
  | { ok: true; value: ValidatedFilmSetConversionCandidate }
  | { ok: false; code: "candidate-invalid" | "budget-exceeded"; message: string };

/**
 * 地面取景建议值（世界单位，**诊断阈值，不是拒绝额度**）。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 7.1 / design D7：这里原本以固定
 * 32 世界单位为界**拒绝**结构合法但地面偏大的候选。现在改为世界尺度／取景**质量诊断**：
 * 地面远大于主体时仍完整交付（内容合法即保留），只在结果的 note 中说明主体预览可能偏小。
 * 默认地面为 `FILM_SET_GROUND_DEFAULT_SIZE`（8）。
 */
export const FILM_SET_CONVERSION_GROUND_ADVISORY_EXTENT = 32;

/**
 * 校验片场候选。
 *
 * `scenePlacement` 由调用方补齐（默认单位变换）；这里校验 items-only 内容、全部 model item
 * 的可执行性、媒体资产引用与片段/binding 完整性。`canvas` 用于核验媒体资产存在且 ready。
 */
export function validateFilmSetConversionCandidate(input: {
  candidate: unknown;
  canvas: ServerCanvas;
  scenePlacement: FilmSetLocalTransform;
  title: string;
}): FilmSetConversionCandidateResult {
  const candidate = input.candidate;
  if (!isJsonObject(candidate)) {
    return { ok: false, code: "candidate-invalid", message: "候选必须是对象" };
  }
  const contentDecoded = decodeFilmSetContent(candidate.filmSetContent);
  if (!contentDecoded.ok) return { ok: false, code: "candidate-invalid", message: contentDecoded.reason };
  const content = contentDecoded.value;
  if (content.items.length === 0) {
    return { ok: false, code: "candidate-invalid", message: "候选片场必须包含至少一个可编辑对象" };
  }

  // 必须真正**重建画面**：至少一个 model 对象。只把源图片/视频当平面素材放进片场不算成功结果
  // （spec：仅创建平面媒体对象 MUST NOT 作为本转换成功结果）。
  if (!content.items.some((item) => item.kind === "model")) {
    return {
      ok: false,
      code: "candidate-invalid",
      message: "候选片场必须包含至少一个模型对象来重建画面；只放入源素材不算成功结果"
    };
  }

  // 媒体资产引用必须是当前画布内稳定、ready 且种类匹配的资产（模型不得发明外部 URL）。
  for (const item of content.items) {
    if (item.kind !== "image" && item.kind !== "video") continue;
    const asset = input.canvas.assets.find((entry) => entry.id === item.assetId);
    if (!asset) return { ok: false, code: "candidate-invalid", message: `候选引用不存在的资产 ${item.assetId}` };
    if (asset.status !== "ready") {
      return { ok: false, code: "candidate-invalid", message: `候选资产 ${item.assetId} 尚未就绪` };
    }
    if (asset.mediaKind !== item.kind) {
      return { ok: false, code: "candidate-invalid", message: `候选资产 ${item.assetId} 类型不匹配` };
    }
  }

  // 全部 model item 必须可执行且为静态定义（复用权威写入同一校验）。
  for (const item of content.items) {
    if (item.kind !== "model") continue;
    const validity = validateSelfContainedModel(item.model.modelScript, item.model.modelScriptVersion);
    if (!validity.ok) return { ok: false, code: "candidate-invalid", message: validity.message };
  }

  // 地面几何参与节点矩形的等比适配基准（`filmSetLayoutBounds`），过大的地面会让主体在预览里
  // 偏小。change: 2026-10-22-remove-agent-execution-limits —— 这属于取景质量诊断，不拒绝结构
  // 合法的地面；诊断以结果 note 呈现，完整内容照常交付。
  const groundDiagnostics = content.items
    .filter((item): item is Extract<typeof item, { kind: "ground" }> => item.kind === "ground" && Math.max(item.size.width, item.size.depth) > FILM_SET_CONVERSION_GROUND_ADVISORY_EXTENT)
    .map((item) => `地面 ${item.id} 尺寸 ${Math.max(item.size.width, item.size.depth)} 偏大：地面以世界单位计、宜接近主体占地（约 ${FILM_SET_GROUND_DEFAULT_SIZE}），否则节点预览中主体会被缩得很小；无可见地面时可直接省略该对象`);

  const animationsInput = candidate.filmSetAnimations ?? emptyFilmSetAnimations();
  const animations = decodeFilmSetAnimations(animationsInput, content);
  if (!animations.ok) return { ok: false, code: "candidate-invalid", message: animations.reason };

  const sceneCameraInput = candidate.sceneCamera;
  let sceneCamera: InitialShotCamera;
  if (sceneCameraInput === undefined || sceneCameraInput === null) {
    sceneCamera = defaultConversionCamera();
  } else {
    const camera = decodeInitialShotCamera(sceneCameraInput);
    if (!camera.ok) return { ok: false, code: "candidate-invalid", message: `sceneCamera 非法：${camera.reason}` };
    const elevation = cameraElevationIssue(camera.value);
    if (elevation) return { ok: false, code: "candidate-invalid", message: `sceneCamera ${elevation}` };
    sceneCamera = camera.value;
  }

  // 片段镜头同样要求仰角落在规范半圆内（`decodeInitialShotCamera` 不做范围检查，见该函数说明）。
  for (const clip of animations.value.clips) {
    const elevation = cameraElevationIssue(clip.initialCamera);
    if (elevation) return { ok: false, code: "candidate-invalid", message: `片段 ${clip.id} 的 initialCamera ${elevation}` };
  }

  // 图片重建可以只返回共享对象；交付时补一个静态取景，让对象有可预览、可继续编辑的目标镜头。
  // 不凭空生成动作，也不改写模型已返回的拍摄镜头。
  if (animations.value.clips.length === 0) {
    animations.value.defaultClipId = "converted-shot";
    animations.value.clips.push({
      id: "converted-shot", name: "默认镜头", kind: "static",
      timeline: { duration: 0, loop: false }, initialCamera: sceneCamera,
      cameraMotion: staticShotCameraMotion(),
      bindings: content.items.filter(item => item.kind !== "ground").map(item => ({
        itemId: item.id, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false }
      }))
    });
    const complete = decodeFilmSetAnimations(animations.value, content);
    if (!complete.ok) return { ok: false, code: "candidate-invalid", message: complete.reason };
  }

  const baseNote = typeof candidate.note === "string" && candidate.note.trim() ? candidate.note.trim() : undefined;
  const note = [...(baseNote ? [baseNote] : []), ...groundDiagnostics].join(" ") || undefined;
  return {
    ok: true,
    value: {
      filmSetContent: content,
      filmSetAnimations: animations.value,
      sceneCamera,
      ...(note ? { note } : {})
    }
  };
}

/**
 * 转换候选的镜头仰角必须落在规范半圆 `[-π/2, +π/2]` 内。
 *
 * 上游常把 `elevation` 当成**角度**写（例如 `7`）：若按弧度解释 ≈ 401°，渲染时被 `clampShotElevation`
 * 静默钳到正上方 → 「镜头朝向错了」，而 `decodeInitialShotCamera` 不做范围检查（既有画布可能存有历史越界值），
 * 因此这里显式拒绝，让有界修复轮拿到**具体**原因。`decodeModelCameras` 早已按同一范围拒绝，此处补齐一致性。
 */
function cameraElevationIssue(camera: InitialShotCamera): string | undefined {
  const epsilon = 1e-6;
  if (!(camera.elevation >= SHOT_CAMERA_MIN_ELEVATION - epsilon) || !(camera.elevation <= SHOT_CAMERA_MAX_ELEVATION + epsilon)) {
    return `elevation ${camera.elevation} 非法：仰角必须以弧度给出且落在 [${SHOT_CAMERA_MIN_ELEVATION}, ${SHOT_CAMERA_MAX_ELEVATION}]（±π/2）内；azimuth 同样是弧度`;
  }
  return undefined;
}

function defaultConversionCamera(): InitialShotCamera {
  return {
    azimuth: 0,
    elevation: Math.PI / 4,
    distance: 4,
    aspect: "16:9",
    focusOffset: { x: 0, y: 0, z: 0 }
  };
}

/** 校验来源范围为正有限；供 adapter 复用。 */
export function isValidConversionRange(range: { startSeconds: number; endSeconds: number } | undefined): boolean {
  if (!range) return true;
  return isFiniteNumber(range.startSeconds) && range.startSeconds >= 0
    && isFiniteNumber(range.endSeconds) && range.endSeconds > range.startSeconds;
}
