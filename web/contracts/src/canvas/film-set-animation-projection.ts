/** Read-only playback/capture view derived from group-owned bindings and live cards. */
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { isFilmSetNode } from "./film-set-legacy-identity.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";
import { staticShotCameraMotion } from "./film-set-animations.js";
import { DEFAULT_FILM_SET_LOCAL_TRANSFORM } from "./film-set-content.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import { readFilmSetContentForSession, type FilmSetProjectionCanvas } from "./film-set-group-projection.js";

/** 从权威画布读取某节点的完整动画定义；不存在/非法返回 null。 */
export function readFilmSetAnimationProjection(
  canvas: FilmSetProjectionCanvas | null,
  nodeId: string
): FilmSetNodeData | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  const group = node?.type === "group" ? readFilmSetGroupMarker(canvas.nodeData[nodeId]) : null;
  if (group) {
    const sessionContent = readFilmSetContentForSession(canvas, nodeId);
    const content = { ...sessionContent, items: sessionContent.items.filter(item => group.sceneBindings.find(binding => binding.bindingId === item.id)?.visibility !== false).map(item => {
      const { motion: _motion, playback: _playback, ...geometry } = item;
      return geometry;
    }) };
    const sourceIds = new Set(content.items.map(item => item.id));
    const clips = (group.clips ?? []).map(clip => {
      const camera = group.cameras?.find(entry => entry.id === clip.cameraId);
      const duration = clip.duration ?? 0;
      return {
        id: clip.id, name: clip.name ?? clip.id, kind: (duration > 0 ? "dynamic" : "static") as "dynamic" | "static",
        timeline: { duration, loop: clip.loop ?? false }, ...(clip.backdrop ? { backdrop: clip.backdrop } : {}),
        initialCamera: {
          azimuth: camera?.azimuth ?? 0, elevation: camera?.elevation ?? 0.35, distance: camera?.distance ?? 4,
          aspect: camera?.aspect ?? "16:9", focusOffset: camera?.focusOffset ?? { x: 0, y: 0, z: 0 }
        }, cameraMotion: clip.cameraMotion ?? staticShotCameraMotion(), bindings: clip.bindings ? clip.bindings.filter(binding => sourceIds.has(binding.itemId)) : duration > 0 ? group.sceneBindings.flatMap(binding => binding.animation && sourceIds.has(binding.bindingId)
          ? [{ itemId: binding.bindingId, motion: binding.animation.motion, playback: binding.animation.playback }] : []) : []
      };
    });
    const data = canvas.nodeData[nodeId] as { title?: string } | undefined;
    const decoded = decodeFilmSetNodeData({
      ...(typeof data?.title === "string" ? { title: data.title } : {}),
      scenePlacement: group.sceneTransform ? { offset: { x: group.sceneTransform.x, y: group.sceneTransform.y, z: group.sceneTransform.z }, yaw: group.sceneTransform.yaw, scale: group.sceneTransform.scale } : DEFAULT_FILM_SET_LOCAL_TRANSFORM,
      filmSetContent: content,
      filmSetAnimations: { schemaVersion: 3, defaultClipId: group.activeClip ?? clips[0]?.id ?? null, clips },
      sceneCamera: group.cameras?.find(camera => camera.id === "scene-camera") ?? group.cameras?.[0] ?? clips[0]?.initialCamera
    });
    return decoded.ok ? decoded.value : null;
  }
  if (!node || !isFilmSetNode(node.type, canvas.nodeData[nodeId])) return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[nodeId]);
  return decoded.ok ? decoded.value : null;
}

