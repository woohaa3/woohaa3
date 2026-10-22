import { isBoundedId, isJsonObject } from "../validation.js";
import type { FilmSetNodeData, AnimationTimeline, InitialShotCamera } from "./canvas-node-model.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { cloneFilmSetAnimations, decodeFilmSetAnimations, filmSetBindingHash, filmSetClipHash, isFilmSetShotKind, staticShotCameraMotion, type FilmSetAnimationBinding, type FilmSetAnimationClip, type FilmSetAnimations, type FilmSetShotKind } from "./film-set-animations.js";
import { filmSetItemAdapterHash, establishItemMotionAdapter, decodeFilmSetPlayback } from "./film-set-content.js";
import { hashMotionScript, type MotionDefinition } from "./motion-script.js";
import { fnv1a64Hex } from "./content-hash.js";

export type FilmSetClipPatchOp =
  | { kind: "create"; clip: FilmSetAnimationClip }
  | { kind: "duplicate"; newClipId: string; name: string }
  | { kind: "delete" }
  | { kind: "rename"; name: string }
  | { kind: "set-default" }
  | { kind: "timeline"; timeline: AnimationTimeline }
  | { kind: "camera"; initialCamera: InitialShotCamera }
  /** D10：片段独立、仅允许镜头的运动定义。 */
  | { kind: "camera-motion"; cameraMotion: MotionDefinition }
  /**
   * 显式类型转换（change D1）。`toKind` 为 `dynamic` 时必须携带合法正时长
   * （`confirmClearContent` 用于 dynamic→static 且有动作/时序时，明确表示用户已确认清除）。
   */
  | { kind: "set-kind"; toKind: FilmSetShotKind; duration?: number; loop?: boolean; confirmClearContent?: boolean }
  | { kind: "binding"; itemId: string; binding: FilmSetAnimationBinding | null; expectedAdapterHash: string }
  | { kind: "confirm-adaptation"; itemId: string; expectedAdapterHash: string }
  | { kind: "replace"; clip: FilmSetAnimationClip };

export function isFilmSetClipPatchOp(value: unknown): value is FilmSetClipPatchOp {
  if (!isJsonObject(value)) return false;
  switch (value.kind) {
    case "create": case "replace": return isJsonObject(value.clip);
    case "duplicate": return isBoundedId(value.newClipId) && typeof value.name === "string";
    case "delete": case "set-default": return true;
    case "rename": return typeof value.name === "string";
    case "timeline": return isJsonObject(value.timeline);
    case "camera": return isJsonObject(value.initialCamera);
    case "camera-motion": return isJsonObject(value.cameraMotion);
    case "set-kind":
      return isFilmSetShotKind(value.toKind)
        && (value.duration === undefined || typeof value.duration === "number")
        && (value.loop === undefined || typeof value.loop === "boolean")
        && (value.confirmClearContent === undefined || typeof value.confirmClearContent === "boolean");
    case "binding": return isBoundedId(value.itemId) && typeof value.expectedAdapterHash === "string" && (value.binding === null || isJsonObject(value.binding));
    case "confirm-adaptation": return isBoundedId(value.itemId) && typeof value.expectedAdapterHash === "string";
    default: return false;
  }
}

/**
 * 动态镜头是否携带任何动作或时序（用于 dynamic→static 影响提示与确认门禁）。
 *
 * 含非空镜头动作、非空对象动作或正时长媒体播放即为 true。
 */
export function clipHasMotionOrTiming(clip: FilmSetAnimationClip): boolean {
  if (clip.cameraMotion.motionScript.trim()) return true;
  if (clip.timeline.duration > 0) return true;
  return clip.bindings.some((binding) => (binding.motion?.motionScript.trim() ?? "") !== "" || binding.playback.duration > 0);
}

/** 转换为静态时将被清除的内容摘要（供界面明确展示影响；纯函数）。 */
export function clipConversionImpact(clip: FilmSetAnimationClip): string[] {
  const impact: string[] = [];
  if (clip.cameraMotion.motionScript.trim()) impact.push("镜头运动");
  if (clip.bindings.some((binding) => (binding.motion?.motionScript.trim() ?? "") !== "")) impact.push("对象动作");
  if (clip.timeline.duration > 0) impact.push("镜头时长与循环");
  if (clip.bindings.some((binding) => binding.playback.duration > 0)) impact.push("媒体时序播放");
  return impact;
}

/** Identity scoped to the mutated field; unrelated edits may safely merge. */
export function filmSetClipPrecondition(collection: FilmSetAnimations, clipId: string, op: FilmSetClipPatchOp): string {
  const clip = collection.clips.find(value => value.id === clipId);
  if (op.kind === "create") return fnv1a64Hex(JSON.stringify(clip ?? null));
  if (op.kind === "set-default") return fnv1a64Hex(JSON.stringify(collection.defaultClipId));
  if (!clip) return fnv1a64Hex("null");
  if (op.kind === "binding" || op.kind === "confirm-adaptation") return filmSetBindingHash(clip.bindings.find(binding => binding.itemId === op.itemId));
  if (op.kind === "rename") return fnv1a64Hex(JSON.stringify(clip.name));
  if (op.kind === "timeline") return fnv1a64Hex(JSON.stringify(clip.timeline));
  if (op.kind === "camera") return fnv1a64Hex(JSON.stringify(clip.initialCamera));
  if (op.kind === "camera-motion") return fnv1a64Hex(JSON.stringify(clip.cameraMotion));
  return filmSetClipHash(clip);
}

/** 静态→动态：保留身份与构图，设置合法正时长。 */
function applyStaticToDynamic(clip: FilmSetAnimationClip, op: { duration?: number; loop?: boolean }): string | null {
  const duration = op.duration ?? (clip.timeline.duration > 0 ? clip.timeline.duration : 5);
  if (!(duration > 0) || duration > 3600) return "静态转动态必须设置 (0, 3600] 秒的正时长";
  clip.kind = "dynamic";
  clip.timeline = { duration, loop: op.loop ?? false };
  return null;
}

/**
 * 动态→静态：原子清除运镜、对象动作与时序播放，设零时长且非循环；保留构图与共享 items。
 *
 * 含动作/时序且未显式确认时拒绝，不静默丢内容。
 */
function applyDynamicToStatic(clip: FilmSetAnimationClip, confirmClearContent: boolean): string | null {
  if (clipHasMotionOrTiming(clip) && !confirmClearContent) {
    return `动态转静态将清除：${clipConversionImpact(clip).join("、") || "动作与时序"}；请显式确认后再转换`;
  }
  clip.kind = "static";
  clip.timeline = { duration: 0, loop: false };
  clip.cameraMotion = staticShotCameraMotion();
  clip.bindings = clip.bindings.map((binding) => ({ itemId: binding.itemId, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } }));
  return null;
}

export function applyFilmSetClipPatch(input: {
  animation: FilmSetNodeData; clipId: string; op: FilmSetClipPatchOp; expectedHash: string;
}): { ok: true; value: FilmSetAnimations; changed: boolean } | { ok: false; code: string; reason: string } {
  const fail = (code: string, reason: string) => ({ ok: false as const, code, reason });
  if (!isBoundedId(input.clipId) || !isFilmSetClipPatchOp(input.op)) return fail("invalid-payload", "拍摄镜头操作非法");
  const original = filmSetAnimationsOf(input.animation);
  if (filmSetClipPrecondition(original, input.clipId, input.op) !== input.expectedHash) return fail("stale-clip", "目标拍摄镜头字段已被修改，请重新读取后重试");
  const value = cloneFilmSetAnimations(original);
  const clip = value.clips.find(candidate => candidate.id === input.clipId);
  const op = input.op;
  if (op.kind === "create") {
    if (clip || op.clip.id !== input.clipId) return fail("clip-conflict", "拍摄镜头 ID 已存在或不匹配");
    value.clips.push(JSON.parse(JSON.stringify(op.clip)) as FilmSetAnimationClip);
    if (value.defaultClipId === null) value.defaultClipId = input.clipId;
  } else {
    if (!clip) return fail("unknown-clip", `拍摄镜头 ${input.clipId} 不存在`);
    switch (op.kind) {
      case "duplicate":
        if (value.clips.some(candidate => candidate.id === op.newClipId)) return fail("clip-conflict", "复制拍摄镜头 ID 已存在");
        value.clips.push({ ...JSON.parse(JSON.stringify(clip)) as FilmSetAnimationClip, id: op.newClipId, name: op.name });
        break;
      case "delete":
        value.clips = value.clips.filter(candidate => candidate.id !== input.clipId);
        if (value.defaultClipId === input.clipId) value.defaultClipId = value.clips[0]?.id ?? null;
        break;
      case "set-default": value.defaultClipId = clip.id; break;
      case "rename": clip.name = op.name; break;
      case "timeline":
        if (clip.kind === "static") return fail("invalid-payload", "静态拍摄镜头必须保持零时长；请先转为动态镜头");
        if (clip.bindings.some(binding => binding.playback.startTime + binding.playback.duration / binding.playback.timeScale > op.timeline.duration)) return fail("binding-outside-timeline", "时间线缩短会截断对象动作，请先调整绑定");
        clip.timeline = op.timeline;
        break;
      case "camera": clip.initialCamera = op.initialCamera; break;
      case "camera-motion":
        if (clip.kind === "static" && op.cameraMotion.motionScript.trim()) return fail("invalid-payload", "静态拍摄镜头不得有镜头动作；请先转为动态镜头");
        clip.cameraMotion = JSON.parse(JSON.stringify(op.cameraMotion)) as MotionDefinition;
        break;
      case "set-kind": {
        if (op.toKind === clip.kind) break;
        const conversionError = op.toKind === "dynamic"
          ? applyStaticToDynamic(clip, op)
          : applyDynamicToStatic(clip, op.confirmClearContent === true);
        if (conversionError) return fail("invalid-kind", conversionError);
        break;
      }
      case "replace":
        if (op.clip.id !== clip.id) return fail("clip-conflict", "替换拍摄镜头 ID 不匹配");
        value.clips[value.clips.indexOf(clip)] = JSON.parse(JSON.stringify(op.clip)) as FilmSetAnimationClip;
        break;
      case "binding": {
        const item = input.animation.filmSetContent.items.find(candidate => candidate.id === op.itemId);
        if (!item) return fail("unknown-item", "绑定对象不存在");
        if (filmSetItemAdapterHash(item) !== op.expectedAdapterHash) return fail("stale-item", "绑定对象内容已修改");
        if (op.binding && op.binding.itemId !== op.itemId) return fail("invalid-payload", "binding.itemId 不匹配");
        const checkedPlayback = decodeFilmSetPlayback(op.binding?.playback, op.itemId);
        if (op.binding && (!checkedPlayback.ok || !checkedPlayback.value)) return fail("invalid-payload", "binding.playback 缺失或非法");
        if (clip.kind === "static") {
          if (op.binding && (op.binding.motion?.motionScript.trim() ?? "") !== "") {
            return fail("static-binding-dynamic-motion", "静态拍摄镜头不得有对象动作；请先转为动态镜头");
          }
          if (op.binding && op.binding.playback.duration > 0) {
            return fail("static-binding-dynamic-media", "静态拍摄镜头不得有随时间播放的媒体；请先转为动态镜头");
          }
        }
        clip.bindings = clip.bindings.filter(binding => binding.itemId !== op.itemId);
        if (op.binding) {
          clip.bindings.push(JSON.parse(JSON.stringify(op.binding)) as FilmSetAnimationBinding);
          const p = op.binding.playback;
          // 静态镜头不得因绑定被暗中延长：只有动态镜头才扩展时间线。
          if (clip.kind === "dynamic") clip.timeline.duration = Math.max(clip.timeline.duration, p.startTime + p.duration / p.timeScale);
        }
        break;
      }
      case "confirm-adaptation": {
        const item = input.animation.filmSetContent.items.find(candidate => candidate.id === op.itemId);
        const binding = clip.bindings.find(candidate => candidate.itemId === op.itemId);
        if (!item || !binding?.motion) return fail("unknown-item", "绑定动作不存在");
        if (filmSetItemAdapterHash(item) !== op.expectedAdapterHash) return fail("stale-item", "绑定对象内容已修改");
        binding.motion.basedOnModelVersion = establishItemMotionAdapter(item);
        break;
      }
    }
  }
  if (["create", "camera-motion", "replace", "binding", "set-kind"].includes(op.kind)) {
    const changedClip = value.clips.find(clip => clip.id === input.clipId);
    const motions = changedClip ? [changedClip.cameraMotion, ...(Array.isArray(changedClip.bindings) ? changedClip.bindings : []).flatMap(binding => binding?.motion ? [binding.motion] : [])] : [];
    for (const motion of motions) if (motion && typeof motion.motionScript === "string") motion.sourceHash = hashMotionScript(motion.motionScript);
  }
  const content = input.animation.filmSetContent;
  const decoded = decodeFilmSetAnimations(value, content);
  if (!decoded.ok) return fail("invalid-content", decoded.reason);
  return { ok: true, value: decoded.value, changed: JSON.stringify(original) !== JSON.stringify(decoded.value) };
}
