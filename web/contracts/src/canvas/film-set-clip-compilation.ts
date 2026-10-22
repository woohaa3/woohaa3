/**
 * 片场片段一次性编译（change: 2026-10-11-extract-film-set-extension，D10）。
 *
 * 片段镜头来自片段独立 `cameraMotion`（已校验为仅镜头）；对象动作来自片段 bindings。
 * 编译一次得到 Bevy 播放投影，tick 只更新时间。集合级预算不能被分摊到多片段绕过。
 */
import { buildAnimationPlayback } from "./canvas-node-model.js";
import { buildFilmSetObjectMotions } from "./film-set-composition.js";
import { executeMotionScript } from "./motion-executor.js";
import type { FilmSetAnimations } from "./film-set-animations.js";
import { filmSetAnimationsOf, type FilmSetClipView } from "./film-set-clip-view.js";
import type { BevyAnimationPlayback } from "./render-scene.js";

export type CompiledFilmSetClip = { ok: true; projection: BevyAnimationPlayback; diagnostics: string[] }
  | { ok: false; reason: string };

/** One-time compile, target validation and scope mapping; ticks update time only. */
export function compileFilmSetClip(nodeId: string, view: FilmSetClipView): CompiledFilmSetClip {
  const script = view.cameraMotion.motionScript;
  const execution = executeMotionScript(script, { duration: view.timeline.duration });
  if (!execution.ok) return { ok: false, reason: execution.message };
  if (execution.ir.modelMotion.length > 0) return { ok: false, reason: "片段镜头定义不得作用于模型部件" };
  const objects = buildFilmSetObjectMotions({ filmSetContent: view.content, bindings: view.clip.bindings });
  let tracks = execution.ir.cameraMotion.length + execution.ir.modelMotion.length;
  let frames = 0;
  for (const track of execution.ir.modelMotion) if (track.motion.kind === "keyframes") frames += track.motion.frames.length;
  for (const object of objects.motions) {
    tracks += object.modelMotion.length;
    for (const track of object.modelMotion) if (track.motion.kind === "keyframes") frames += track.motion.frames.length;
  }
  if (tracks > 1024 || frames > 16384) return { ok: false, reason: "片段累计轨道超过 1024 或关键帧超过 16384" };
  const projection = buildAnimationPlayback({
    nodeId,
    camera: view.initialCamera,
    timeline: view.timeline,
    ir: execution.ir,
    time: 0,
    playing: false,
    compiledObjects: objects,
    // 镜头背景随投影下发：预览与浏览器导出清屏使用同一具体色（D6）。
    ...(view.clip.backdrop ? { backdrop: view.clip.backdrop } : {})
  });
  return { ok: true, projection, diagnostics: objects.diagnostics };
}

/** Collection-wide budgets cannot be bypassed by distributing tracks among clips. */
export function filmSetCompiledBudget(animation: { filmSetAnimations?: FilmSetAnimations }): string | null {
  let tracks = 0, frames = 0;
  for (const clip of filmSetAnimationsOf(animation as never).clips) {
    const sources = [{ script: clip.cameraMotion.motionScript, duration: clip.timeline.duration }, ...clip.bindings.filter(binding => binding.motion).map(binding => ({ script: binding.motion!.motionScript, duration: binding.playback.duration }))];
    for (const source of sources) {
      const execution = executeMotionScript(source.script, { duration: source.duration });
      if (!execution.ok) continue; // Existing broken scripts remain inspectable and editable.
      tracks += execution.ir.cameraMotion.length + execution.ir.modelMotion.length;
      for (const track of execution.ir.modelMotion) if (track.motion.kind === "keyframes") frames += track.motion.frames.length;
      if (tracks > 1024 || frames > 16384) return "全部片段累计轨道超过 1024 或关键帧超过 16384";
    }
  }
  return null;
}
