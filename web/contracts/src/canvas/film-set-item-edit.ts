/**
 * 片场对象的**类型化受保护编辑**（change:
 * 2026-10-10-improve-film-set-editing-and-inspector，任务 3.1–3.3 / design D6）。
 *
 * 对象 transform/delete/restore 通过 `edit.apply` 的类型化操作与条件表达，而不是把整份
 * `filmSetContent` / `filmSetAnimations` 数组回写。规划器从共享 reducer 的实际净效果捕获
 * forward/inverse，绝不使用客户端旧完整数组覆盖其他项。
 *
 * 本模块纯函数、JSON-only：只做集合变换、条件匹配与稳定哈希，不写 Store / Y.Doc / nodeData。
 * 精确定位用稳定 itemId / clipId，不用数组序号。
 */
import type { FilmSetNodeData } from "./canvas-node-model.js";
import {
  cloneFilmSetAnimations,
  filmSetBindingHash,
  type FilmSetAnimations,
  type FilmSetAnimationBinding
} from "./film-set-animations.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import {
  cloneFilmSetItem,
  decodeFilmSetLocalTransform,
  filmSetItemById,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetLocalTransform
} from "./film-set-content.js";
import { filmSetContentHash } from "./film-set-content.js";

/** 片场对象编辑的失败原因（稳定、可读）。 */
export type FilmSetItemEditFailure = { ok: false; reason: string };

/** 对象删除的顺序锚点：优先插在仍存在的后邻之前，否则前邻之后，否则追加。 */
export type FilmSetItemOrderAnchor = {
  /** 原集合中紧随其后的 itemId（仍存在时优先以它为锚）。 */
  after?: string;
  /** 原集合中紧挨其前的 itemId（后邻缺失时的回退锚）。 */
  before?: string;
};

/** restore 携带的单个片段绑定闭包。 */
export type FilmSetItemBindingRestore = { clipId: string; binding: FilmSetAnimationBinding };

/** 对象完整内容哈希：结构化、与顺序无关的单对象身份。 */
export function filmSetItemEditHash(item: FilmSetItem): string {
  return filmSetContentHash({ schemaVersion: 3, items: [item] });
}

/** 相关绑定的身份哈希（缺失即 `null` 的哈希）。 */
export function filmSetItemBindingEditHash(binding: FilmSetAnimationBinding | undefined): string {
  return filmSetBindingHash(binding);
}

/** 读取单个 item 当前内容哈希（不存在返回 null）。 */
export function filmSetItemHashOf(animation: FilmSetNodeData, itemId: string): string | null {
  const item = filmSetItemById(animation.filmSetContent, itemId);
  return item ? filmSetItemEditHash(item) : null;
}

/** 读取某个 item 在指定片段的绑定哈希（片段不存在或绑定缺失返回 null 的哈希）。 */
export function filmSetItemBindingHashOf(
  animation: FilmSetNodeData,
  clipId: string,
  itemId: string
): string {
  const clip = filmSetAnimationsOf(animation).clips.find((entry) => entry.id === clipId);
  return filmSetItemBindingEditHash(clip?.bindings.find((binding) => binding.itemId === itemId));
}

/** 片段是否存在。 */
export function filmSetClipExists(animation: FilmSetNodeData, clipId: string): boolean {
  return filmSetAnimationsOf(animation).clips.some((clip) => clip.id === clipId);
}

/**
 * 更新对象局部基础变换（仅 localTransform）。
 *
 * 复用合法变换校验与稳定对象身份；`expectedLocalTransform` 提供时要求当前变换一致（并发冲突）。
 */
export function applyFilmSetItemEditTransform(input: {
  animation: FilmSetNodeData;
  itemId: string;
  localTransform: FilmSetLocalTransform;
  expectedLocalTransform?: FilmSetLocalTransform;
}): { ok: true; value: FilmSetNodeData; changed: boolean } | FilmSetItemEditFailure {
  const item = filmSetItemById(input.animation.filmSetContent, input.itemId);
  if (!item) return { ok: false, reason: `片场对象 ${input.itemId} 不存在` };
  const transform = decodeFilmSetLocalTransform(input.localTransform);
  if (!transform.ok) return { ok: false, reason: transform.reason };
  if (input.expectedLocalTransform && !sameTransform(item.localTransform, input.expectedLocalTransform)) {
    return { ok: false, reason: `片场对象 ${input.itemId} 摆放已被并发修改` };
  }
  const changed = !sameTransform(item.localTransform, transform.value);
  const items = input.animation.filmSetContent.items.map((entry) =>
    entry.id === item.id ? { ...entry, localTransform: { offset: { ...transform.value.offset }, scale: transform.value.scale, yaw: transform.value.yaw } } : entry
  );
  return { ok: true, value: withContent(input.animation, items), changed };
}

/**
 * 删除对象并原子清理所有片段中指向它的绑定。
 *
 * 不重建片段、不动其他对象/绑定、不改 defaultClipId 与片场根。
 */
export function applyFilmSetItemEditRemove(input: {
  animation: FilmSetNodeData;
  itemId: string;
}): { ok: true; value: FilmSetNodeData; changed: boolean } | FilmSetItemEditFailure {
  const item = filmSetItemById(input.animation.filmSetContent, input.itemId);
  if (!item) return { ok: false, reason: `片场对象 ${input.itemId} 不存在` };
  const items = input.animation.filmSetContent.items.filter((entry) => entry.id !== item.id);
  const animations = filmSetAnimationsOf(input.animation);
  const nextAnimations = cloneFilmSetAnimations(animations);
  for (const clip of nextAnimations.clips) {
    clip.bindings = clip.bindings.filter((binding) => binding.itemId !== item.id);
  }
  return { ok: true, value: withContent(withAnimations(input.animation, nextAnimations), items), changed: true };
}

/**
 * 原子恢复对象、顺序锚点与全部相关绑定。
 *
 * 前提（由条件层在编辑前校验）：itemId 仍缺失、目标片段仍存在、相关绑定未冲突。
 * 任一相关片段缺失时拒绝整批，不自动重建片段。顺序按稳定相邻 ID 锚点合并。
 */
export function applyFilmSetItemEditRestore(input: {
  animation: FilmSetNodeData;
  item: FilmSetItem;
  orderAnchor: FilmSetItemOrderAnchor;
  bindings: readonly FilmSetItemBindingRestore[];
}): { ok: true; value: FilmSetNodeData; changed: boolean } | FilmSetItemEditFailure {
  if (filmSetItemById(input.animation.filmSetContent, input.item.id)) {
    return { ok: false, reason: `片场对象 ${input.item.id} 的 ID 已被占用，无法恢复` };
  }
  const animations = cloneFilmSetAnimations(filmSetAnimationsOf(input.animation));
  for (const restore of input.bindings) {
    const clip = animations.clips.find((entry) => entry.id === restore.clipId);
    if (!clip) return { ok: false, reason: `片段 ${restore.clipId} 不存在，无法恢复对象绑定` };
    if (clip.bindings.some((binding) => binding.itemId === input.item.id)) {
      return { ok: false, reason: `片段 ${restore.clipId} 已存在对象 ${input.item.id} 的绑定` };
    }
    if (restore.binding.itemId !== input.item.id) {
      return { ok: false, reason: "恢复绑定的 itemId 与对象不一致" };
    }
    clip.bindings.push(cloneBinding(restore.binding));
    const playback = restore.binding.playback;
    clip.timeline.duration = Math.max(clip.timeline.duration, playback.startTime + playback.duration / playback.timeScale);
  }
  const items = insertItemAtAnchor(input.animation.filmSetContent.items, cloneFilmSetItem(input.item), input.orderAnchor);
  return { ok: true, value: withContent(withAnimations(input.animation, animations), items), changed: true };
}

/** 按稳定相邻 ID 锚点把 item 插入集合；保留无关新增项的相对顺序。 */
export function insertItemAtAnchor(
  items: readonly FilmSetItem[],
  item: FilmSetItem,
  anchor: FilmSetItemOrderAnchor
): FilmSetItem[] {
  const next = [...items];
  const afterIndex = anchor.after ? next.findIndex((entry) => entry.id === anchor.after) : -1;
  if (afterIndex >= 0) {
    next.splice(afterIndex, 0, item);
    return next;
  }
  const beforeIndex = anchor.before ? next.findIndex((entry) => entry.id === anchor.before) : -1;
  if (beforeIndex >= 0) {
    next.splice(beforeIndex + 1, 0, item);
    return next;
  }
  next.push(item);
  return next;
}

/** 计算删除时用于恢复的顺序锚点（下一次调用前捕获）。 */
export function captureItemOrderAnchor(items: readonly FilmSetItem[], itemId: string): FilmSetItemOrderAnchor {
  const index = items.findIndex((entry) => entry.id === itemId);
  if (index < 0) return {};
  return {
    ...(items[index + 1] ? { after: items[index + 1].id } : {}),
    ...(items[index - 1] ? { before: items[index - 1].id } : {})
  };
}

/** 读取 item 在全部片段的绑定闭包（删除时捕获）。 */
export function captureItemBindingClosure(
  animation: FilmSetNodeData,
  itemId: string
): FilmSetItemBindingRestore[] {
  const result: FilmSetItemBindingRestore[] = [];
  for (const clip of filmSetAnimationsOf(animation).clips) {
    const binding = clip.bindings.find((entry) => entry.itemId === itemId);
    if (binding) result.push({ clipId: clip.id, binding: cloneBinding(binding) });
  }
  return result;
}

function withContent(animation: FilmSetNodeData, items: FilmSetItem[]): FilmSetNodeData {
  return { ...animation, filmSetContent: { schemaVersion: 3, items } as FilmSetContent };
}

function withAnimations(animation: FilmSetNodeData, animations: FilmSetAnimations): FilmSetNodeData {
  return { ...animation, filmSetAnimations: animations };
}

function cloneBinding(binding: FilmSetAnimationBinding): FilmSetAnimationBinding {
  return JSON.parse(JSON.stringify(binding)) as FilmSetAnimationBinding;
}

function sameTransform(left: FilmSetLocalTransform, right: FilmSetLocalTransform): boolean {
  return (
    left.offset.x === right.offset.x &&
    left.offset.y === right.offset.y &&
    left.offset.z === right.offset.z &&
    left.scale === right.scale &&
    left.yaw === right.yaw
  );
}
