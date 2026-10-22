/** Independent animation clips reference shared items; geometry never belongs to a clip. */
import { isBoundedId, isJsonObject } from "../validation.js";
import { decodeAnimationTimeline, decodeInitialShotCamera, type AnimationTimeline, type InitialShotCamera } from "./canvas-node-model.js";
import { decodeFilmSetMotion, decodeFilmSetPlayback, type FilmSetContent, type FilmSetPlayback } from "./film-set-content.js";
import { MOTION_SCRIPT_LANGUAGE, MOTION_SCRIPT_VERSION, hashMotionScript, type MotionDefinition } from "./motion-script.js";
import { fnv1a64Hex } from "./content-hash.js";

/**
 * 拍摄镜头集合 schema 3
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，D1）。
 *
 * schema 1 的 `clip.motion` 作用于顶层 authored 模型，与 items-only 内容模型冲突，已删除。
 * schema 2 的片段保存**独立且仅允许镜头**的运动定义 `cameraMotion`（与 bindings 共用唯一 T）；
 * 全部对象动作只存在于 `bindings[].motion`。schema 3 把片段统一为「拍摄镜头」，新增必需
 * `kind`（`static` | `dynamic`）与严格静态/动态不变式。旧 schema 1/2 记录只由隔离离线
 * reader 转换。
 *
 * 机器协议名 `clip`（id/clipId/clipPatch）是历史标识，产品统一称「拍摄镜头」；唯一业务
 * 类型名 `FilmSetShootingShot`。
 */
export const FILM_SET_ANIMATIONS_VERSION = 3 as const;
/** 最近一代旧片段动画版本（schema 2，cameraMotion 独立但无 kind）；只由隔离离线 reader 转换。 */
export const FILM_SET_ANIMATIONS_LEGACY_VERSION = 2 as const;
/** 最早一代旧片段动画版本（schema 1，含 clip.motion）；只由隔离离线 reader 转换。 */
export const FILM_SET_ANIMATIONS_LEGACY_V1_VERSION = 1 as const;
export const MAX_FILM_SET_CLIPS = 32;
export const MAX_FILM_SET_ANIMATION_SOURCE_BYTES = 1 << 20;
export const MAX_FILM_SET_ANIMATION_BYTES = 2 << 20;

/** 拍摄镜头类型；是否动态由 kind 明确表达，禁止仅凭 cameraMotion 是否非空推断。 */
export const FILM_SET_SHOT_KINDS = ["static", "dynamic"] as const;
export type FilmSetShotKind = (typeof FILM_SET_SHOT_KINDS)[number];

export type FilmSetAnimationBinding = { itemId: string; motion?: MotionDefinition; playback: FilmSetPlayback };
/**
 * 拍摄镜头背景（change: 2026-10-19-extend-film-set-for-motion-graphics，D6）。
 *
 * `theme` 表示跟随主题（镜头预览清屏色）；自定义值必须是六位 `#rrggbb`。背景只作用于该镜头的
 * 预览、拍摄与导出画面，编辑片场的工作区视图不受影响。
 */
export const FILM_SET_BACKDROP_THEME = "theme" as const;
export type FilmSetBackdrop = typeof FILM_SET_BACKDROP_THEME | string;
/** 严格六位十六进制（大写统一为小写；与渲染侧 `parse_hex` 一致）。 */
const BACKDROP_HEX = /^#[0-9a-f]{6}$/;

export type FilmSetAnimationClip = {
  id: string;
  name: string;
  /** D1：必需类型判别。static = 零时长静态取景；dynamic = 正时长可播放镜头。 */
  kind: FilmSetShotKind;
  timeline: AnimationTimeline;
  initialCamera: InitialShotCamera;
  /** D10：本镜头独立、严格版本化且仅允许镜头的运动定义（空脚本表示静态镜头）。 */
  cameraMotion: MotionDefinition;
  bindings: FilmSetAnimationBinding[];
  /**
   * D6：可选背景。缺失等价于 `theme`（因此旧镜头解码后逐字节不变、身份不失效）；
   * 只有自定义颜色才写入。
   */
  backdrop?: string;
};
/** 唯一业务类型名：拍摄镜头（机器协议沿用 `clip`）。 */
export type FilmSetShootingShot = FilmSetAnimationClip;
export type FilmSetAnimations = { schemaVersion: 3; defaultClipId: string | null; clips: FilmSetAnimationClip[] };
export type FilmSetAnimationsResult = { ok: true; value: FilmSetAnimations } | { ok: false; reason: string };

/** 空（静态）镜头运动定义：完整 `MotionDefinition`，但脚本为空。 */
export function staticShotCameraMotion(): MotionDefinition {
  return {
    motionScript: "",
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: 1,
    sourceHash: hashMotionScript(""),
    basedOnModelVersion: { revision: 1, contentHash: "camera" }
  };
}

/** 是否受支持的拍摄镜头类型。 */
export function isFilmSetShotKind(value: unknown): value is FilmSetShotKind {
  return typeof value === "string" && (FILM_SET_SHOT_KINDS as readonly string[]).includes(value);
}

/**
 * 校验并规范化镜头背景（D6）。
 *
 * 缺失 / `theme` → `undefined`（不写入规范数据，旧镜头身份不变）；自定义色只接受六位
 * `#rrggbb`（统一小写）。其它值（`#0008`、颜色名、3 位短写）一律拒绝，不静默回退。
 */
export function readFilmSetBackdrop(input: unknown): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== "string") return { ok: false, reason: "backdrop 必须是字符串" };
  if (input === FILM_SET_BACKDROP_THEME) return { ok: true, value: undefined };
  const normalized = input.trim().toLowerCase();
  if (!BACKDROP_HEX.test(normalized)) {
    return { ok: false, reason: "backdrop 必须是 theme 或六位十六进制颜色（如 #000000）" };
  }
  return { ok: true, value: normalized };
}

/** 镜头背景是否已显式设为自定义颜色。 */
export function filmSetBackdropIsCustom(clip: { backdrop?: string }): boolean {
  return typeof clip.backdrop === "string" && clip.backdrop !== FILM_SET_BACKDROP_THEME;
}

/** 是否静态拍摄镜头（零时长、非循环、空镜头动作）。 */
export function isStaticShot(clip: { kind: FilmSetShotKind }): boolean {
  return clip.kind === "static";
}

/**
 * 复制拍摄镜头为另一身份（D6：背景随镜头一起继承）。
 *
 * 深拷贝全部字段，只替换 `id` 与 `name`；新建/复制镜头都经过它，避免两处各写一份字段表。
 */
export function cloneFilmSetShotForNewId(clip: FilmSetAnimationClip, id: string, name: string): FilmSetAnimationClip {
  return { ...(JSON.parse(JSON.stringify(clip)) as FilmSetAnimationClip), id, name };
}

/**
 * 为旧记录（schema 1/2、转换候选或复制来源）派生显式 `kind`（D1）。
 *
 * 规则：存在正时长、非空镜头动作、任一对象动作或正时长媒体播放即 `dynamic`；否则 `static`。
 * 迁移与候选归一都必须经过它，禁止各写入口自行推断，也不允许在**已声明的** static 上暗中延长时长。
 */
export function deriveFilmSetShotKind(clip: {
  timeline: { duration: number; loop?: boolean };
  cameraMotion?: { motionScript: string };
  bindings: readonly { motion?: { motionScript: string }; playback: { duration: number } }[];
}): FilmSetShotKind {
  if (clip.timeline.duration > 0) return "dynamic";
  if (clip.cameraMotion?.motionScript.trim()) return "dynamic";
  for (const binding of clip.bindings) {
    if (binding.motion?.motionScript.trim()) return "dynamic";
    if (binding.playback.duration > 0) return "dynamic";
  }
  return "static";
}

export function emptyFilmSetAnimations(): FilmSetAnimations {
  return { schemaVersion: 3, defaultClipId: null, clips: [] };
}
export function cloneFilmSetAnimations(value: FilmSetAnimations): FilmSetAnimations {
  return JSON.parse(JSON.stringify(value)) as FilmSetAnimations;
}
export function filmSetClipHash(clip: FilmSetAnimationClip): string {
  return fnv1a64Hex(JSON.stringify(clip));
}
export function filmSetBindingHash(binding: FilmSetAnimationBinding | undefined): string {
  return fnv1a64Hex(JSON.stringify(binding ?? null));
}
export function filmSetAnimationsHash(value: FilmSetAnimations): string {
  return fnv1a64Hex(JSON.stringify(value));
}
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

/**
 * Strict structure decoder for schema 3. Executable motion diagnostics are validated separately
 * before writes; this decoder does not run scripts.
 *
 * `cameraMotion` 必需且为完整 `MotionDefinition`；模型动作只允许出现在 `bindings[].motion`。
 * `kind` 必需，且静态/动态不变式在此严格判定（不依赖 `cameraMotion` 推断）。
 */
export function decodeFilmSetAnimations(input: unknown, content: FilmSetContent): FilmSetAnimationsResult {
  const fail = (reason: string): FilmSetAnimationsResult => ({ ok: false, reason });
  if (!isJsonObject(input) || input.schemaVersion !== FILM_SET_ANIMATIONS_VERSION) {
    return fail("不支持的 filmSetAnimations 版本（要求 3，旧 schema 1/2 只由隔离离线 reader 转换）");
  }
  if (!Array.isArray(input.clips) || input.clips.length > MAX_FILM_SET_CLIPS) return fail("clips 必须为数组且不超过 32 个");
  if (input.defaultClipId !== null && !isBoundedId(input.defaultClipId)) return fail("defaultClipId 非法");
  const itemIds = new Set(content.items.map(item => item.id));
  const ids = new Set<string>();
  const clips: FilmSetAnimationClip[] = [];
  let sourceBytes = 0;
  for (const item of content.items) if (item.kind === "model") sourceBytes += utf8Bytes(item.model.modelScript);
  for (const raw of input.clips) {
    if (!isJsonObject(raw) || !isBoundedId(raw.id) || ids.has(raw.id)) return fail("拍摄镜头 id 非法或重复");
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 80) return fail(`拍摄镜头 ${raw.id} 名称非法`);
    if (raw.motion !== undefined) return fail(`拍摄镜头 ${raw.id} 不得保留旧 clip.motion，镜头动作请写入 cameraMotion`);
    if (!isFilmSetShotKind(raw.kind)) return fail(`拍摄镜头 ${raw.id} kind 必须是 static 或 dynamic`);
    const backdrop = readFilmSetBackdrop(raw.backdrop);
    if (!backdrop.ok) return fail(`拍摄镜头 ${raw.id} ${backdrop.reason}`);
    const timeline = decodeAnimationTimeline(raw.timeline);
    const camera = decodeInitialShotCamera(raw.initialCamera);
    const cameraMotion = decodeFilmSetMotion(raw.cameraMotion, raw.id);
    if (!timeline.ok) return timeline;
    if (!camera.ok) return camera;
    if (!cameraMotion.ok) return cameraMotion;
    if (!cameraMotion.value) return fail(`拍摄镜头 ${raw.id} cameraMotion 缺失`);
    if (raw.kind === "static") {
      if (timeline.value.duration !== 0) return fail(`静态拍摄镜头 ${raw.id} 必须零时长`);
      if (timeline.value.loop) return fail(`静态拍摄镜头 ${raw.id} 必须非循环`);
      if (cameraMotion.value.motionScript.trim()) return fail(`静态拍摄镜头 ${raw.id} 不得有镜头动作`);
    } else if (!(timeline.value.duration > 0)) {
      return fail(`动态拍摄镜头 ${raw.id} 必须正时长（至多 3600 秒）`);
    }
    if (!Array.isArray(raw.bindings) || raw.bindings.length > 128) return fail(`拍摄镜头 ${raw.id} bindings 非法`);
    sourceBytes += utf8Bytes(cameraMotion.value.motionScript);
    const seen = new Set<string>();
    const bindings: FilmSetAnimationBinding[] = [];
    for (const binding of raw.bindings) {
      if (!isJsonObject(binding) || !isBoundedId(binding.itemId) || !itemIds.has(binding.itemId) || seen.has(binding.itemId)) return fail(`拍摄镜头 ${raw.id} binding 引用非法或重复`);
      const childMotion = decodeFilmSetMotion(binding.motion, binding.itemId);
      const playback = decodeFilmSetPlayback(binding.playback, binding.itemId);
      if (!childMotion.ok) return childMotion;
      if (!playback.ok) return playback;
      if (!playback.value || playback.value.duration > 3600 || playback.value.startTime > 3600) return fail(`对象 ${binding.itemId} playback 缺失或超限`);
      if (raw.kind === "static") {
        if (childMotion.value?.motionScript.trim()) return fail(`静态拍摄镜头 ${raw.id} 的对象 ${binding.itemId} 不得有对象动作`);
        if (playback.value.duration !== 0) return fail(`静态拍摄镜头 ${raw.id} 的对象 ${binding.itemId} 不得有随时间播放的媒体（playback.duration 必须为 0）`);
      } else if (childMotion.value?.motionScript.trim() && playback.value.duration === 0) {
        return fail(`对象 ${binding.itemId} 动作需要正时长`);
      }
      sourceBytes += utf8Bytes(childMotion.value?.motionScript ?? "");
      seen.add(binding.itemId);
      bindings.push({ itemId: binding.itemId, playback: playback.value, ...(childMotion.value ? { motion: childMotion.value } : {}) });
    }
    ids.add(raw.id);
    clips.push({ id: raw.id, name: raw.name.trim(), kind: raw.kind, timeline: timeline.value, initialCamera: camera.value, cameraMotion: cameraMotion.value, bindings, ...(backdrop.value ? { backdrop: backdrop.value } : {}) });
  }
  if ((clips.length === 0) !== (input.defaultClipId === null) || (input.defaultClipId !== null && !ids.has(input.defaultClipId as string))) return fail("defaultClipId 必须引用存在的拍摄镜头");
  const value: FilmSetAnimations = { schemaVersion: FILM_SET_ANIMATIONS_VERSION, defaultClipId: input.defaultClipId as string | null, clips };
  if (sourceBytes > MAX_FILM_SET_ANIMATION_SOURCE_BYTES) return fail("共享模型与全部镜头源码超过 1 MiB UTF-8 预算");
  if (utf8Bytes(JSON.stringify({ filmSetContent: content, filmSetAnimations: value })) > MAX_FILM_SET_ANIMATION_BYTES) return fail("共享内容与镜头超过 2 MiB 预算");
  return { ok: true, value };
}
