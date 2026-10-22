/**
 * 片场对象级权威操作（change: 2026-10-09-add-film-set-object-motion-and-editing，
 * 任务 2.3 / design D6）。
 *
 * 提供共享的 item transform/delete/model/motion/playback 纯函数操作。调用方（Canvas Service、
 * MCP 与前端）从**最新权威集合**读取对应 item 后调用本模块，再原子写回整份内容；不按数组序号
 * 定位，也不用客户端旧完整数组覆盖其他项。
 *
 * 本模块无副作用、JSON-only：只做集合变换与校验，不写 Store / Y.Doc / nodeData。
 */
import {
  cloneFilmSetLocalTransform,
  decodeFilmSetContent,
  filmSetItemById,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetLocalTransform,
  type FilmSetMotion,
  type FilmSetPlayback,
  decodeFilmSetLocalTransform
} from "./film-set-content.js";

export type FilmSetItemOpResult =
  | { ok: true; value: FilmSetContent; changed: boolean; itemId: string }
  | { ok: false; reason: string; code: FilmSetItemOpCode };

export type FilmSetItemOpCode =
  | "unknown-item"
  | "kind-mismatch"
  | "invalid-payload"
  | "precondition"
  | "invalid-content";

const OK_ITEM: FilmSetItemOpCode = "unknown-item";

/** 解析并规范化一份内容；非法返回稳定失败。 */
function decodeContent(content: FilmSetContent | unknown): { ok: true; value: FilmSetContent } | { ok: false; reason: string; code: FilmSetItemOpCode } {
  const decoded = decodeFilmSetContent(content);
  if (!decoded.ok) return { ok: false, reason: decoded.reason, code: "invalid-content" };
  return { ok: true, value: decoded.value };
}

function replaceItem(content: FilmSetContent, next: FilmSetItem): FilmSetContent {
  return {
    schemaVersion: content.schemaVersion,
    items: content.items.map((item) => (item.id === next.id ? next : item))
  };
}

/**
 * 更新对象局部基础变换（offset / 等比 scale / 绕局部 Y yaw）。
 *
 * `expectedLocalTransform` 为可选 precondition：提供时要求当前变换完全一致，否则拒绝（并发冲突）。
 */
export function applyFilmSetItemTransform(input: {
  content: FilmSetContent;
  itemId: string;
  localTransform: FilmSetLocalTransform;
  expectedLocalTransform?: FilmSetLocalTransform;
}): FilmSetItemOpResult {
  const normalized = decodeContent(input.content);
  if (!normalized.ok) return normalized;
  const item = filmSetItemById(normalized.value, input.itemId);
  if (!item) return { ok: false, reason: `片场对象 ${input.itemId} 不存在`, code: OK_ITEM };
  const transform = decodeFilmSetLocalTransform(input.localTransform);
  if (!transform.ok) return { ok: false, reason: transform.reason, code: "invalid-payload" };
  if (input.expectedLocalTransform && !sameTransform(item.localTransform, input.expectedLocalTransform)) {
    return { ok: false, reason: `片场对象 ${input.itemId} 摆放已被并发修改`, code: "precondition" };
  }
  const next: FilmSetItem = { ...item, localTransform: cloneFilmSetLocalTransform(transform.value) };
  const changed = !sameTransform(item.localTransform, next.localTransform);
  return { ok: true, value: replaceItem(normalized.value, next), changed, itemId: item.id };
}

/** 删除对象；缺失 id 视为 precondition 失败（不静默 no-op，避免误删）。 */
export function deleteFilmSetItem(input: {
  content: FilmSetContent;
  itemId: string;
}): FilmSetItemOpResult {
  const normalized = decodeContent(input.content);
  if (!normalized.ok) return normalized;
  const item = filmSetItemById(normalized.value, input.itemId);
  if (!item) return { ok: false, reason: `片场对象 ${input.itemId} 不存在`, code: OK_ITEM };
  return {
    ok: true,
    value: { schemaVersion: normalized.value.schemaVersion, items: normalized.value.items.filter((entry) => entry.id !== item.id) },
    changed: true,
    itemId: item.id
  };
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

export type { FilmSetMotion, FilmSetPlayback };
