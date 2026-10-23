/**
 * 从**权威画布**派生镜头参考录制的观察结果
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.3 / design D9）。
 *
 * 只读画布、计算视觉内容身份；不录制、不写画布。把「画布 + 当前聚焦片场」翻译成
 * `ShotReferenceRecordingQueue.observe` 需要的观察集合，使 dirty 判定与内容身份
 * （`shotReferenceContentIdentity`）**共用同一份**算法，重命名/布局/缩放/hover 播放头都不进入
 * 身份，因此不会触发录制。
 */
import { decodeFilmSetNodeData, filmSetAnimationsOf, isFilmSetNode, shotReferenceContentIdentity, shotReferenceProfileKey, DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, type FilmSetNodeData } from "@woohaa3/contracts";
import type { ShotReferenceClipObservation, ShotReferenceFilmSetObservation, ShotReferenceRecordingJob } from "./shot-reference-recording-queue.js";

/** 观察所需的画布最小形状（运行时画布与序列化画布都满足）。 */
export type ShotReferenceCanvasLike = {
  document: { nodes: readonly { id: string; type: string }[] };
  nodeData: Record<string, unknown>;
};

/** 从画布读取某个片场的解码定义；非片场/解码失败返回 null。 */
export function readFilmSetForObservation(
  canvas: ShotReferenceCanvasLike | null | undefined,
  filmSetNodeId: string
): FilmSetNodeData | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === filmSetNodeId);
  if (!node || !isFilmSetNode(node.type, canvas.nodeData[filmSetNodeId])) return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[filmSetNodeId]);
  return decoded.ok ? decoded.value : null;
}

/** 单个镜头的观察结果；定义缺失/片段缺失时 `contentIdentity` 为 `null`。 */
export function observeFilmSetClips(
  canvas: ShotReferenceCanvasLike | null | undefined,
  filmSetNodeId: string
): ShotReferenceClipObservation[] {
  const animation = readFilmSetForObservation(canvas, filmSetNodeId);
  if (!animation) return [];
  const profileKey = shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE);
  return filmSetAnimationsOf(animation).clips.map((clip) => ({
    clipId: clip.id,
    contentIdentity: clip.kind === "dynamic" ? shotReferenceContentIdentity({ animation, clipId: clip.id }) : null,
    profileKey
  }));
}

/**
 * 观察整个画布：所有片场及其镜头。`focusedFilmSetId` 为当前聚焦编辑的片场节点 id（未聚焦为
 * `null`）——只有该片场在队列中标记为聚焦、其镜头被压住不录。
 */
export function observeFilmSets(
  canvas: ShotReferenceCanvasLike | null | undefined,
  focusedFilmSetId: string | null
): ShotReferenceFilmSetObservation[] {
  if (!canvas) return [];
  const observations: ShotReferenceFilmSetObservation[] = [];
  for (const node of canvas.document.nodes) {
    if (!isFilmSetNode(node.type, canvas.nodeData[node.id])) continue;
    observations.push({
      filmSetNodeId: node.id,
      focused: node.id === focusedFilmSetId,
      clips: observeFilmSetClips(canvas, node.id)
    });
  }
  return observations;
}

/**
 * 下游请求补排：为某镜头的**当前**版本构造 job；非可录镜头（静态/缺失/非法/画布缺失）返回
 * `null`，由调用方明确拒绝，不猜时长。
 */
export function shotReferenceJobForClip(
  canvasId: string,
  canvas: ShotReferenceCanvasLike | null | undefined,
  filmSetNodeId: string,
  clipId: string
): ShotReferenceRecordingJob | null {
  const observation = observeFilmSetClips(canvas, filmSetNodeId).find((clip) => clip.clipId === clipId);
  if (!observation || observation.contentIdentity === null) return null;
  return {
    canvasId,
    filmSetNodeId,
    clipId,
    contentIdentity: observation.contentIdentity,
    profileKey: observation.profileKey
  };
}
