/**
 * 片场运行时片段视图与 canonical flat 字段写入口
 * （change: 2026-10-11-extract-film-set-extension，D7/D8/D10）。
 *
 * `FilmSetClipView` 是把某个片段（clip）与共享 items 组合出的**运行时**视图：它把 binding 的
 * motion/playback 投影到对应 item、暴露该片段独立的 `cameraMotion`/初始镜头/时间线。该视图
 * **绝不**序列化；规范存储始终是 items-only + 片段集合。
 */
import type { FilmSetNodeData, AnimationTimeline, InitialShotCamera } from "./canvas-node-model.js";
import {
  emptyFilmSetAnimations,
  type FilmSetAnimationClip,
  type FilmSetAnimations
} from "./film-set-animations.js";
import type { FilmSetContent } from "./film-set-content.js";
import { FILM_SET_CONTENT_VERSION } from "./film-set-content.js";
import type { MotionDefinition } from "./motion-script.js";
import { FILM_SET_EXTENSION_ID } from "./domain/core/composite-asset-identity.js";

/** 运行时片段视图（只读投影；不写回 canonical nodeData）。 */
export type FilmSetClipView = {
  animation: FilmSetNodeData;
  clip: FilmSetAnimationClip;
  /** items + 该片段 binding 的 motion/playback（运行时解释，schema 2 视图）。 */
  content: FilmSetContent;
  initialCamera: InitialShotCamera;
  timeline: AnimationTimeline;
  /** 该片段独立、仅允许镜头的运动定义（D10）。 */
  cameraMotion: MotionDefinition;
};

/** 读取片场片段集合；缺失按空集合解释（旧节点也只会是空集合，不含顶层动作）。 */
export function filmSetAnimationsOf(animation: { filmSetAnimations?: FilmSetAnimations }): FilmSetAnimations {
  return animation.filmSetAnimations ?? emptyFilmSetAnimations();
}

/**
 * 解析默认/指定片段为运行时视图；无匹配片段返回 null（调用方诊断，不猜测）。
 */
export function resolveFilmSetClip(animation: FilmSetNodeData, clipId?: string | null): FilmSetClipView | null {
  const collection = filmSetAnimationsOf(animation);
  const clip = collection.clips.find(value => value.id === (clipId ?? collection.defaultClipId));
  if (!clip) return null;
  const bindings = new Map(clip.bindings.map(binding => [binding.itemId, binding]));
  const content: FilmSetContent = {
    schemaVersion: FILM_SET_CONTENT_VERSION,
    items: animation.filmSetContent.items.map(item => {
      const { motion: _motion, playback: _playback, ...shared } = item;
      const binding = bindings.get(item.id);
      return { ...shared, ...(binding?.motion ? { motion: binding.motion } : {}), ...(binding ? { playback: binding.playback } : {}) };
    })
  };
  return {
    animation,
    clip,
    content,
    initialCamera: clip.initialCamera,
    timeline: clip.timeline,
    cameraMotion: clip.cameraMotion
  };
}

/**
 * 片场规范 flat 字段（items-only，D7/D8/D10）。
 *
 * 写入口：`extensionId` 严格业务身份 + title + `scenePlacement` 独立根 + items-only 内容 +
 * 规范静态镜头 `sceneCamera`（D10）+ 片段集合 + 可选来源说明。**不写**任何顶层模型/动作/镜头/时间线字段。
 */
export function canonicalFilmSetFields(animation: FilmSetNodeData): Record<string, unknown> {
  return {
    extensionId: FILM_SET_EXTENSION_ID,
    title: animation.title,
    scenePlacement: animation.scenePlacement,
    sceneCamera: animation.sceneCamera,
    filmSetContent: animation.filmSetContent,
    filmSetAnimations: filmSetAnimationsOf(animation),
    ...(animation.groupAppearance !== undefined ? { groupAppearance: animation.groupAppearance } : {}),
    ...(animation.origin ? { origin: animation.origin } : {})
  };
}

/** 旧节点级动作/镜头/时间线字段：canonical 写入后必须清除。 */
export const LEGACY_FILM_SET_ANIMATION_FIELDS = [
  "motionScript",
  "motionScriptLanguage",
  "motionScriptVersion",
  "motionRevision",
  "motionSourceHash",
  "motionBasedOnModelVersion",
  "initialCamera",
  "timeline"
] as const;

/** 旧片场顶层 authored 模型五字段：canonical 写入后必须清除（items-only）。 */
export const LEGACY_FILM_SET_TOP_MODEL_FIELDS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "modelContentVersion",
  "modelPlacement"
] as const;
