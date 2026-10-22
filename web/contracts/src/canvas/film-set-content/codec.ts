/**
 * 片场内部内容：严格解码、读取与克隆
 * （自 `film-set-content.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R19）。
 *
 * 校验并规范化不受信任的 `filmSetContent`；纯函数、无副作用、JSON-only。前端、Canvas Service、
 * MCP 与测试共用同一份校验。
 */
import { decodeModelDefinition, type ModelDefinition } from "../model-definition.js";
import { decodeMotionDefinition } from "../motion-script.js";
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import {
  DEFAULT_FILM_SET_LOCAL_TRANSFORM,
  FILM_SET_CONTENT_FIELD,
  FILM_SET_ITEM_KINDS,
  MAX_FILM_SET_ITEMS,
  MAX_FILM_SET_NAME_LENGTH,
  MAX_FILM_SET_TOTAL_SOURCE_BYTES,
  emptyFilmSetContent,
  isFilmSetMediaItem,
  type FilmSetContent,
  type FilmSetContentVersion,
  type FilmSetItem,
  type FilmSetLocalTransform,
  type FilmSetMotion,
  type FilmSetOrigin,
  type FilmSetPlayback
} from "./types.js";
import { itemSourceBytes, validateItemBudget } from "./motion.js";

export type FilmSetContentDecodeResult =
  | { ok: true; value: FilmSetContent }
  | { ok: false; reason: string };

/** Strict schema 3 reader; legacy disk records are handled only by the offline migration. */
export function decodeFilmSetContent(input: unknown): FilmSetContentDecodeResult {
  if (input === undefined || input === null) return { ok: true, value: emptyFilmSetContent() };
  if (!isJsonObject(input)) return { ok: false, reason: "filmSetContent 必须是对象" };
  const rawVersion = input.schemaVersion;
  if (rawVersion !== 3) {
    return { ok: false, reason: `不支持的 filmSetContent schemaVersion ${String(input.schemaVersion)}` };
  }
  const schemaVersion = rawVersion as FilmSetContentVersion;
  const rawItems = input.items ?? [];
  if (!Array.isArray(rawItems)) return { ok: false, reason: "filmSetContent.items 必须是数组" };
  if (rawItems.length > MAX_FILM_SET_ITEMS) {
    return { ok: false, reason: `filmSetContent 超过上限 ${MAX_FILM_SET_ITEMS}` };
  }
  const seen = new Set<string>();
  const items: FilmSetItem[] = [];
  let totalSourceBytes = 0;
  for (const raw of rawItems) {
    if (!isJsonObject(raw)) return { ok: false, reason: "filmSetContent 元素必须是对象" };
    const id = raw.id;
    if (!isBoundedId(id) || id.length === 0) return { ok: false, reason: "片场对象 id 非法" };
    if (seen.has(id)) return { ok: false, reason: `片场对象 id 重复：${id}` };
    const kind = raw.kind;
    if (typeof kind !== "string" || !(FILM_SET_ITEM_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, reason: `片场对象 ${id} kind 非法` };
    }
    // schema 3 对象只存静态内容；动作与播放配置属于片段 binding。
    if ( (raw.motion !== undefined || raw.playback !== undefined)) {
      return { ok: false, reason: `schema ${schemaVersion} 片场对象 ${id} 不得包含对象动作；schema 3 请使用片段 binding` };
    }
    const name = readFilmSetName(raw.name);
    if (name === null) return { ok: false, reason: `片场对象 ${id} 名称非法` };
    const localTransform = decodeFilmSetLocalTransform(raw.localTransform);
    if (!localTransform.ok) return { ok: false, reason: `片场对象 ${id} ${localTransform.reason}` };
    const motion = decodeOptionalMotion(raw.motion, id);
    if (!motion.ok) return { ok: false, reason: motion.reason };
    const playback = decodeOptionalPlayback(raw.playback, id);
    if (!playback.ok) return { ok: false, reason: playback.reason };
    const budget = validateItemBudget(id, motion.value, playback.value);
    if (budget !== null) return { ok: false, reason: budget };
    totalSourceBytes += itemSourceBytes(motion.value);
    if (totalSourceBytes > MAX_FILM_SET_TOTAL_SOURCE_BYTES) {
      return { ok: false, reason: `片场对象源码总量超过上限 ${MAX_FILM_SET_TOTAL_SOURCE_BYTES}` };
    }
    const motionFields = motion.value ? { motion: motion.value } : {};
    const playbackFields = playback.value ? { playback: playback.value } : {};
    if (kind === "model") {
      const model = decodeFilmSetModelSnapshot(raw.model);
      if (!model.ok) return { ok: false, reason: `片场对象 ${id} 模型非法：${model.reason}` };
      const origin = decodeFilmSetOrigin(raw.origin);
      seen.add(id);
      items.push({
        id,
        kind: "model",
        name,
        localTransform: localTransform.value,
        model: model.value,
        ...motionFields,
        ...playbackFields,
        ...(origin ? { origin } : {})
      });
      continue;
    }
    if (kind === "image" || kind === "video") {
      const assetId = raw.assetId;
      if (!isBoundedId(assetId)) return { ok: false, reason: `片场对象 ${id} assetId 非法` };
      const aspectRatio = raw.aspectRatio ?? 1;
      if (!isFiniteNumber(aspectRatio) || aspectRatio <= 0) {
        return { ok: false, reason: `片场对象 ${id} aspectRatio 必须是正有限数值` };
      }
      const origin = decodeFilmSetOrigin(raw.origin);
      seen.add(id);
      items.push({
        id,
        kind,
        name,
        localTransform: localTransform.value,
        assetId,
        aspectRatio,
        ...motionFields,
        ...playbackFields,
        ...(origin ? { origin } : {})
      });
      continue;
    }
    // ground
    const size = readGroundSize(raw.size);
    if (!size.ok) return { ok: false, reason: `片场对象 ${id} ${size.reason}` };
    const color = readGroundColor(raw.color);
    if (color === INVALID_COLOR) return { ok: false, reason: `片场对象 ${id} color 非法` };
    seen.add(id);
    items.push({
      id,
      kind: "ground",
      name,
      localTransform: localTransform.value,
      size: size.value,
      ...motionFields,
      ...playbackFields,
      ...(color ? { color } : {})
    });
  }
  return { ok: true, value: { schemaVersion, items } };
}

/** 读取节点上的规范片场内容；缺失/非法返回空集合（供渲染与 UI 使用，不抛错）。 */
export function readFilmSetContent(nodeData: unknown): FilmSetContent {
  if (!isJsonObject(nodeData)) return emptyFilmSetContent();
  const decoded = decodeFilmSetContent(nodeData[FILM_SET_CONTENT_FIELD]);
  return decoded.ok ? decoded.value : emptyFilmSetContent();
}

/** 从 flat nodeData 读取片场内容（严格；非法时返回失败原因）。 */
export function decodeFilmSetContentFromNodeData(nodeData: unknown): FilmSetContentDecodeResult {
  if (!isJsonObject(nodeData)) return { ok: false, reason: "nodeData 必须是对象" };
  return decodeFilmSetContent(nodeData[FILM_SET_CONTENT_FIELD]);
}

/** 按稳定 id 查找对象（缺失返回 undefined）。 */
export function filmSetItemById(content: FilmSetContent, id: string): FilmSetItem | undefined {
  return content.items.find((item) => item.id === id);
}

/** 内容集合引用的全部稳定媒体资产 id（去重、稳定顺序）。 */
export function filmSetAssetReferences(content: FilmSetContent): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const item of content.items) {
    if (item.kind !== "image" && item.kind !== "video") continue;
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    refs.push(item.assetId);
  }
  return refs;
}

/** 深拷贝局部变换。 */
export function cloneFilmSetLocalTransform(transform: FilmSetLocalTransform): FilmSetLocalTransform {
  return { offset: { ...transform.offset }, scale: transform.scale, yaw: transform.yaw };
}

/** 深拷贝播放配置。 */
export function cloneFilmSetPlayback(playback: FilmSetPlayback): FilmSetPlayback {
  return {
    startTime: playback.startTime,
    duration: playback.duration,
    timeScale: playback.timeScale,
    loop: playback.loop
  };
}

/** 深拷贝对象运动定义。 */
export function cloneFilmSetMotion(motion: FilmSetMotion): FilmSetMotion {
  return { ...motion, basedOnModelVersion: { ...motion.basedOnModelVersion } };
}

/** 深拷贝片场内容（供调用方持有可变副本）。 */
export function cloneFilmSetContent(content: FilmSetContent): FilmSetContent {
  return {
    schemaVersion: content.schemaVersion,
    items: content.items.map((item) => cloneFilmSetItem(item))
  };
}

export function cloneFilmSetItem(item: FilmSetItem): FilmSetItem {
  const base = {
    id: item.id,
    name: item.name,
    localTransform: cloneFilmSetLocalTransform(item.localTransform),
    ...(item.motion ? { motion: cloneFilmSetMotion(item.motion) } : {}),
    ...(item.playback ? { playback: cloneFilmSetPlayback(item.playback) } : {})
  };
  if (item.kind === "model") {
    return {
      ...base,
      kind: "model",
      model: {
        ...item.model,
        contentVersion: { ...item.model.contentVersion },
        placement: { offset: { ...item.model.placement.offset }, scale: item.model.placement.scale, yaw: item.model.placement.yaw }
      },
      ...(item.origin ? { origin: { ...item.origin } } : {})
    };
  }
  if (isFilmSetMediaItem(item)) {
    return {
      ...base,
      kind: item.kind,
      assetId: item.assetId,
      aspectRatio: item.aspectRatio,
      ...(item.origin ? { origin: { ...item.origin } } : {})
    };
  }
  return { ...base, kind: "ground", size: { ...item.size }, ...(item.color ? { color: item.color } : {}) };
}

export type FilmSetModelSnapshotDecodeResult =
  | { ok: true; value: ModelDefinition }
  | { ok: false; reason: string };

/**
 * 校验片场内部模型快照。快照使用结构化字段（`contentVersion` / `placement`），
 * 映射到既有 flat `ModelDefinition` decoder 复用同一套校验。
 */
export function decodeFilmSetModelSnapshot(input: unknown): FilmSetModelSnapshotDecodeResult {
  if (!isJsonObject(input)) return { ok: false, reason: "模型快照必须是对象" };
  return decodeModelDefinition({
    modelScript: input.modelScript,
    modelScriptLanguage: input.modelScriptLanguage,
    modelScriptVersion: input.modelScriptVersion,
    modelContentVersion: input.contentVersion,
    modelPlacement: input.placement
  });
}

export type FilmSetLocalTransformDecodeResult =
  | { ok: true; value: FilmSetLocalTransform }
  | { ok: false; reason: string };

/** 校验局部变换；缺失按默认（单位）变换。 */
export function decodeFilmSetLocalTransform(input: unknown): FilmSetLocalTransformDecodeResult {
  if (input === undefined || input === null) {
    return { ok: true, value: cloneFilmSetLocalTransform(DEFAULT_FILM_SET_LOCAL_TRANSFORM) };
  }
  if (!isJsonObject(input)) return { ok: false, reason: "localTransform 必须是对象" };
  const rawOffset = input.offset;
  let offset = { x: 0, y: 0, z: 0 };
  if (rawOffset !== undefined && rawOffset !== null) {
    if (!isJsonObject(rawOffset)) return { ok: false, reason: "localTransform.offset 必须是对象" };
    const { x, y, z } = rawOffset;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { ok: false, reason: "localTransform.offset 必须是三分量有限数值" };
    }
    offset = { x, y, z };
  }
  const scale = input.scale === undefined || input.scale === null ? 1 : input.scale;
  if (!isFiniteNumber(scale) || scale <= 0) {
    return { ok: false, reason: "localTransform.scale 必须是正有限数值" };
  }
  const yaw = input.yaw === undefined || input.yaw === null ? 0 : input.yaw;
  if (!isFiniteNumber(yaw)) return { ok: false, reason: "localTransform.yaw 必须是有限数值" };
  return { ok: true, value: { offset, scale, yaw } };
}

export type FilmSetPlaybackDecodeResult =
  | { ok: true; value: FilmSetPlayback | undefined }
  | { ok: false; reason: string };

/**
 * 读取可选播放配置。缺失 → undefined（调用方按默认语义：startTime=0、timeScale=1、loop=false，
 * 视频沿用来源时长）。显式给出的字段必须正有限且受限。
 */
export function decodeFilmSetPlayback(input: unknown, itemId = ""): FilmSetPlaybackDecodeResult {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isJsonObject(input)) return { ok: false, reason: `片场对象 ${itemId} playback 必须是对象` };
  const startTime = input.startTime ?? 0;
  if (!isFiniteNumber(startTime) || startTime < 0) {
    return { ok: false, reason: `片场对象 ${itemId} playback.startTime 必须是非负有限数值` };
  }
  const duration = input.duration ?? 0;
  if (!isFiniteNumber(duration) || duration < 0) {
    return { ok: false, reason: `片场对象 ${itemId} playback.duration 必须是非负有限数值` };
  }
  const timeScale = input.timeScale ?? 1;
  if (!isFiniteNumber(timeScale) || timeScale <= 0) {
    return { ok: false, reason: `片场对象 ${itemId} playback.timeScale 必须是正有限数值` };
  }
  const loop = input.loop ?? false;
  if (typeof loop !== "boolean") return { ok: false, reason: `片场对象 ${itemId} playback.loop 必须是布尔值` };
  return { ok: true, value: { startTime, duration, timeScale, loop } };
}

export type FilmSetMotionDecodeResult =
  | { ok: true; value: FilmSetMotion | undefined }
  | { ok: false; reason: string };

/**
 * 读取可选对象运动定义（嵌套字段名：revision / sourceHash / basedOnModelVersion）。
 *
 * 复用 flat `MotionDefinition` decoder，保证与顶层动作同一套语言/版本/适配校验。
 */
export function decodeFilmSetMotion(input: unknown, itemId = ""): FilmSetMotionDecodeResult {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isJsonObject(input)) return { ok: false, reason: `片场对象 ${itemId} motion 必须是对象` };
  const decoded = decodeMotionDefinition({
    motionScript: input.motionScript,
    motionScriptLanguage: input.motionScriptLanguage,
    motionScriptVersion: input.motionScriptVersion,
    motionRevision: input.revision,
    motionSourceHash: input.sourceHash,
    motionBasedOnModelVersion: input.basedOnModelVersion
  });
  if (!decoded.ok) return { ok: false, reason: `片场对象 ${itemId} motion 非法：${decoded.reason}` };
  return { ok: true, value: decoded.value };
}

function decodeOptionalMotion(input: unknown, itemId: string): FilmSetMotionDecodeResult {
  return decodeFilmSetMotion(input, itemId);
}

function decodeOptionalPlayback(input: unknown, itemId: string): FilmSetPlaybackDecodeResult {
  return decodeFilmSetPlayback(input, itemId);
}

function readFilmSetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_FILM_SET_NAME_LENGTH) return null;
  return trimmed;
}

function readGroundSize(raw: unknown): { ok: true; value: { width: number; depth: number } } | { ok: false; reason: string } {
  if (!isJsonObject(raw)) return { ok: false, reason: "地面 size 必须是对象" };
  const width = raw.width;
  const depth = raw.depth;
  if (!isFiniteNumber(width) || width <= 0 || !isFiniteNumber(depth) || depth <= 0) {
    return { ok: false, reason: "地面 size 必须是正有限数值" };
  }
  return { ok: true, value: { width, depth } };
}

const INVALID_COLOR = Symbol("invalid-color");

function readGroundColor(raw: unknown): string | undefined | typeof INVALID_COLOR {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 32) return INVALID_COLOR;
  return raw;
}

function decodeFilmSetOrigin(input: unknown): FilmSetOrigin | undefined {
  if (!isJsonObject(input)) return undefined;
  const importedAt = input.importedAt;
  if (typeof importedAt !== "string" || importedAt.length === 0) return undefined;
  const origin: FilmSetOrigin = { importedAt };
  if (typeof input.sourceNodeId === "string" && input.sourceNodeId.length > 0) origin.sourceNodeId = input.sourceNodeId;
  if (typeof input.sourceCanvasId === "string" && input.sourceCanvasId.length > 0) {
    origin.sourceCanvasId = input.sourceCanvasId;
  }
  return origin;
}
