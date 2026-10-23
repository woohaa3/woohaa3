/** Offline-only migration helper. */
import { cloneFilmSetAnimations, deriveFilmSetShotKind, type MotionDefinition, type InitialShotCamera, type AnimationTimeline, type FilmSetContent, type FilmSetAnimations, type FilmSetAnimationBinding, type FilmSetAnimationClip } from "@woohaa3/contracts";
export function legacyFilmSetAnimations(input: {
  motion: MotionDefinition; camera: InitialShotCamera; timeline: AnimationTimeline; filmSetContent: FilmSetContent;
}): { content: FilmSetContent; animations: FilmSetAnimations } {
  const bindings: FilmSetAnimationBinding[] = [];
  const items = input.filmSetContent.items.map(item => {
    const { motion, playback, ...shared } = item;
    if (motion || playback) bindings.push({ itemId: item.id, ...(motion ? { motion } : {}), playback: playback ?? { startTime: 0, duration: 0, timeScale: 1, loop: false } });
    return shared;
  });
  const draft: Omit<FilmSetAnimationClip, "kind"> = {
    id: "legacy-default", name: "默认动画", cameraMotion: input.motion, initialCamera: input.camera, timeline: input.timeline, bindings
  };
  // 旧记录没有显式 kind：按正时长/动作/时序媒体派生（D1），与离线 reader 同一规则。
  const kind = deriveFilmSetShotKind(draft);
  const clip: FilmSetAnimationClip = kind === "dynamic"
    ? { ...draft, kind }
    : { ...draft, kind: "static", timeline: { duration: 0, loop: false }, cameraMotion: { ...input.motion, motionScript: "" } };
  return {
    content: { schemaVersion: 4, items },
    animations: cloneFilmSetAnimations({ schemaVersion: 3, defaultClipId: "legacy-default", clips: [clip] })
  };
}
