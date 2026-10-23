/**
 * 拍摄镜头 schema 2 → 3 的**离线**纯迁移计划
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 3.1 / design D9）。
 *
 * 只由显式运维迁移命令与隔离离线 reader 调用；生产读取、Room.load、codec、history restore、
 * MCP 与浏览器导入 MUST NOT 引用本模块。它不是兼容读取层：不把旧 schema 带进运行态。
 *
 * 规则（D9）：
 * - `duration > 0` → `dynamic`（保留时长/循环/镜头动作/对象动作/媒体时序）；
 * - `duration === 0` 且无镜头动作、无对象动作、无正时长媒体 → `static`（零时长、非循环）；
 * - `duration === 0` 但带动作或正时序媒体 → **冲突**：明确报告该镜头并停止该画布迁移，
 *   绝不裁剪动作或猜测时长。
 *
 * 纯函数、JSON-only：不写 Store / Y.Doc / 数据库。
 */
import {
  FILM_SET_CONTENT_PREVIOUS_VERSION,
  FILM_SET_CONTENT_VERSION,
  decodeFilmSetAnimations,
  decodeFilmSetNodeData,
  type FilmSetAnimationClip,
  type FilmSetAnimations,
  type FilmSetContent,
  type FilmSetNodeData,
  type FilmSetShotKind
} from "@woohaa3/contracts";

/** 单镜头转换结果：新定义或明确的冲突原因（含稳定 clipId）。 */
export type FilmSetClipV3Outcome =
  | { ok: true; clip: FilmSetAnimationClip; changed: boolean }
  | { ok: false; clipId: string; reason: string };

/** 单个镜头集合的迁移结果。 */
export type FilmSetAnimationsV3Outcome =
  | { ok: true; value: FilmSetAnimations; changed: boolean }
  | { ok: false; reason: string };

/** 迁移输入镜头：schema 2 无 kind，或已是 schema 3（有 kind）。 */
export type FilmSetClipMigrationInput = Omit<FilmSetAnimationClip, "kind"> & { kind?: FilmSetShotKind };

/** 已含显式 `kind` 的镜头无需迁移。 */
function hasKind(clip: FilmSetClipMigrationInput): clip is FilmSetAnimationClip {
  return clip.kind === "static" || clip.kind === "dynamic";
}

/** 镜头是否带任何镜头动作、对象动作或正时长媒体时序。 */
function clipHasMotionOrTiming(clip: FilmSetClipMigrationInput): boolean {
  if (clip.cameraMotion.motionScript.trim()) return true;
  return clip.bindings.some((binding) => (binding.motion?.motionScript.trim() ?? "") !== "" || binding.playback.duration > 0);
}

/**
 * 把一个 schema 2（无 kind）镜头转换为 schema 3 镜头。
 *
 * - 正时长 → `dynamic`，原样保留时长/循环/动作/媒体；
 * - 零时长且无动作/时序 → `static`（零时长、非循环）；
 * - 零时长但带动作或时序媒体 → **冲突**，返回明确原因，调用方停止该画布迁移（不裁剪、不猜时长）。
 */
export function planFilmSetClipV3(clip: FilmSetClipMigrationInput): FilmSetClipV3Outcome {
  if (hasKind(clip)) return { ok: true, clip, changed: false };
  if (clip.timeline.duration > 0) return { ok: true, clip: { ...clip, kind: "dynamic" }, changed: true };
  if (clip.timeline.duration === 0 && clipHasMotionOrTiming(clip)) {
    return {
      ok: false,
      clipId: clip.id,
      reason: "零时长镜头带有镜头动作、对象动作或正时长媒体，无法在无信息丢失下迁移为静态镜头"
    };
  }
  // 零时长且无动作/时序：合法静态。显式收敛零时长/非循环，保留 id/name/构图/binding 身份。
  return {
    ok: true,
    clip: {
      id: clip.id,
      name: clip.name,
      kind: "static",
      timeline: { duration: 0, loop: false },
      initialCamera: clip.initialCamera,
      cameraMotion: clip.cameraMotion,
      bindings: clip.bindings
    },
    changed: true
  };
}

/**
 * 迁移整个 `filmSetAnimations`：逐个镜头转换，任一冲突即整份拒绝并报告该镜头。
 *
 * 只接受 schema 2 或 schema 3（已是 schema 3 时原样返回，`changed:false` 保证重跑无净变化）；
 * 其它版本明确拒绝。
 */
export function planFilmSetAnimationsV3(input: unknown, content: FilmSetContent): FilmSetAnimationsV3Outcome {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "filmSetAnimations 必须是对象" };
  const raw = input as Record<string, unknown>;
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== 2 && schemaVersion !== 3) {
    return { ok: false, reason: `不支持的 filmSetAnimations 版本（要求 2 或 3，实际 ${String(schemaVersion)}）` };
  }
  const rawClips = Array.isArray(raw.clips) ? raw.clips : [];
  const clips: FilmSetAnimationClip[] = [];
  let changed = schemaVersion !== 3;
  for (const entry of rawClips) {
    const outcome = planFilmSetClipV3(entry as FilmSetClipMigrationInput);
    if (!outcome.ok) return { ok: false, reason: `零时长镜头 ${outcome.clipId} 带动作或时序媒体，无法在无信息丢失下迁移：${outcome.reason}` };
    clips.push(outcome.clip);
    changed = changed || outcome.changed;
  }
  const candidate = { schemaVersion: 3 as const, defaultClipId: (raw.defaultClipId ?? null) as string | null, clips };
  // 用生产严格解码复核：迁移产物必须是合法 schema 3（含静态/动态不变式与预算）。
  const decoded = decodeFilmSetAnimations(candidate, content);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, value: decoded.value, changed: changed || JSON.stringify(decoded.value) !== JSON.stringify(raw) };
}

/** 画布内单个片场节点的迁移结果。 */
export type FilmSetNodeV3Outcome =
  | { ok: true; value: FilmSetNodeData; changed: boolean }
  | { ok: false; reason: string };

/**
 * 迁移单个片场节点数据：只处理 schema 2 动画集合；已是 schema 3 且内容合法时返回 `changed:false`。
 *
 * 非片场节点或非法结构明确拒绝（调用方应只对已识别的片场节点调用）。
 */
export function planFilmSetNodeV3(
  nodeData: unknown,
  options: { acceptedContentVersions?: readonly number[] } = {}
): FilmSetNodeV3Outcome {
  if (!nodeData || typeof nodeData !== "object" || Array.isArray(nodeData)) return { ok: false, reason: "片场 nodeData 必须是对象" };
  const raw = nodeData as Record<string, unknown>;
  // 本迁移是**离线**入口：允许读取上一代内容版本（场景坐标迁移紧随其后执行，见
  // `film-set-scene-space-migration.ts`）；生产读取绝不放宽。
  const acceptedContentVersions = options.acceptedContentVersions ?? [FILM_SET_CONTENT_PREVIOUS_VERSION, FILM_SET_CONTENT_VERSION];
  const animations = raw.filmSetAnimations;
  if (animations === undefined) {
    // 无镜头集合：按新空片场解释，交由生产解码器补齐。
    const decoded = decodeFilmSetNodeData(raw, { acceptedContentVersions });
    return decoded.ok ? { ok: true, value: decoded.value, changed: false } : { ok: false, reason: decoded.reason };
  }
  // 先取内容以判定集合版本（内容必须是 items-only）。
  const contentProbe = decodeFilmSetNodeData(
    { ...raw, filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] } },
    { acceptedContentVersions }
  );
  if (!contentProbe.ok) return { ok: false, reason: contentProbe.reason };
  const planned = planFilmSetAnimationsV3(animations, contentProbe.value.filmSetContent);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const candidate = { ...raw, filmSetAnimations: planned.value };
  const decoded = decodeFilmSetNodeData(candidate, { acceptedContentVersions });
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, value: decoded.value, changed: planned.changed };
}
