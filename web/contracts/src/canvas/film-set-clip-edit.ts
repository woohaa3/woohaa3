/**
 * 拍摄镜头的**类型化受保护编辑**（change:
 * 2026-10-15-add-film-set-shooting-shot-previews，任务 2.5 / design D3）。
 *
 * 受保护编辑日志必须能记录「源镜头定义 + 受影响预览的完整布局闭包」并可撤销/重做：
 * 创建/复制镜头、删除镜头（含撤销恢复原预览 ID/位置/尺寸）、重命名、时间线/构图/动作变化
 * 以及显式类型转换都在此按稳定 clipId 精确定位，绝不整份回写客户端旧集合。
 *
 * 与 `film-set-clip-ops.ts` 的 `clipPatch` 分工：`clipPatch` 是 UI/Agent 的**增量操作**
 * （每个字段一条 precondition，可能触发编译门禁）；本模块是**受保护编辑的操作原语**，
 * 只用严格结构解码校验定义，从而保证「源脚本已损坏」时仍能撤销/恢复，而不是把损坏状态
 * 变成不可回退。本模块纯函数、JSON-only，不访问 Store / Y.Doc / nodeData。
 */
import type { FilmSetNodeData } from "./canvas-node-model.js";
import {
  cloneFilmSetAnimations,
  decodeFilmSetAnimations,
  filmSetClipHash,
  type FilmSetAnimationClip,
  type FilmSetAnimations
} from "./film-set-animations.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { fnv1a64Hex } from "./content-hash.js";

/** 拍摄镜头编辑的失败原因（稳定、可读）。 */
export type FilmSetClipEditFailure = { ok: false; reason: string };

export type FilmSetClipEditResult =
  | { ok: true; value: FilmSetNodeData; changed: boolean }
  | FilmSetClipEditFailure;

/** 「镜头缺失」的规范哈希；与存在镜头的 `filmSetClipHash` 处于同一命名空间。 */
export function absentFilmSetClipHash(): string {
  return fnv1a64Hex(JSON.stringify(null));
}

/**
 * 指定拍摄镜头的当前定义哈希；缺失时返回 `absentFilmSetClipHash()`。
 *
 * 同时用于前向（编辑前状态）与逆向（编辑后状态）的并发前置条件，明确区分「不存在」与
 * 「存在但内容不同」。
 */
export function filmSetClipStateHash(animation: FilmSetNodeData, clipId: string): string {
  const clip = filmSetAnimationsOf(animation).clips.find((entry) => entry.id === clipId);
  return clip ? filmSetClipHash(clip) : absentFilmSetClipHash();
}

/**
 * 写入/替换一个拍摄镜头定义，并同步集合默认镜头（撤销新增、撤销删除恢复定义）。
 *
 * 定义整体经 `decodeFilmSetAnimations` 严格校验（含静态/动态不变式、binding 引用与预算），
 * 不做「自动裁剪」；非法定义整批拒绝而不是部分成功。
 */
export function applyFilmSetClipEditSet(input: {
  animation: FilmSetNodeData;
  clip: FilmSetAnimationClip;
  defaultClipId: string | null;
}): FilmSetClipEditResult {
  const original = filmSetAnimationsOf(input.animation);
  const next = cloneFilmSetAnimations(original);
  const index = next.clips.findIndex((entry) => entry.id === input.clip.id);
  const written = JSON.parse(JSON.stringify(input.clip)) as FilmSetAnimationClip;
  if (index >= 0) next.clips[index] = written;
  else next.clips.push(written);
  next.defaultClipId = input.defaultClipId;
  const decoded = decodeFilmSetAnimations(next, input.animation.filmSetContent);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return {
    ok: true,
    value: { ...input.animation, filmSetAnimations: decoded.value },
    changed: JSON.stringify(original) !== JSON.stringify(decoded.value)
  };
}

/** 移除一个拍摄镜头并同步集合默认镜头（前向删除；撤销新增）。 */
export function applyFilmSetClipEditRemove(input: {
  animation: FilmSetNodeData;
  clipId: string;
  defaultClipId: string | null;
}): FilmSetClipEditResult {
  const original = filmSetAnimationsOf(input.animation);
  if (!original.clips.some((entry) => entry.id === input.clipId)) return { ok: false, reason: `拍摄镜头 ${input.clipId} 不存在` };
  const next: FilmSetAnimations = cloneFilmSetAnimations(original);
  next.clips = next.clips.filter((entry) => entry.id !== input.clipId);
  next.defaultClipId = input.defaultClipId;
  const decoded = decodeFilmSetAnimations(next, input.animation.filmSetContent);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return {
    ok: true,
    value: { ...input.animation, filmSetAnimations: decoded.value },
    changed: JSON.stringify(original) !== JSON.stringify(decoded.value)
  };
}

/**
 * 除 bindings 外镜头内容是否完全一致（用于区分「镜头定义变化」与「对象绑定变化」）。
 *
 * 绑定只引用共享对象；对象增删的绑定差异由对象级 restore/remove 承担，不在这里重复记录。
 */
export function sameClipExceptBindings(left: FilmSetAnimationClip, right: FilmSetAnimationClip): boolean {
  return JSON.stringify(stripBindings(left)) === JSON.stringify(stripBindings(right));
}

function stripBindings(clip: FilmSetAnimationClip): Omit<FilmSetAnimationClip, "bindings"> {
  const { bindings: _bindings, ...rest } = clip;
  return rest;
}
