/**
 * 模型镜头契约：严格解码与读取
 * （自 `model-cameras.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R18）。
 */
import { isBoundedId, isFiniteNumber, isJsonObject, isNonEmptyString } from "../../validation.js";
import {
  MAX_MODEL_CAMERAS,
  MAX_MODEL_CAMERA_NAME_LENGTH,
  MODEL_CAMERA_ASPECTS,
  SHOT_CAMERA_MAX_ELEVATION,
  SHOT_CAMERA_MIN_ELEVATION,
  type ModelCamera,
  type ModelCameraAspect,
  type ModelCameraFocusOffset,
  type ModelCamerasDecodeResult
} from "./types.js";

/**
 * 校验并规范化不受信任的 `modelCameras` 输入。
 *
 * - 未知字段被丢弃（只保留 schema 内字段）。
 * - 重复 `id`、非法类型、非有限数值、非正 `distance`、空/超长 id 或 name、未知画幅、超数量
 *   上限 → 整条集合拒绝（绝不静默写入部分合法镜头）。
 * - 缺失 `aspect` 的既有记录按 `16:9` 读取（design D8 / spec 当前契约）；输出总是携带完整画幅。
 *   是否严格化依赖 C02 数据盘点，本 change 只做源码拆分，未强删该读取。
 * - 返回按 `order` 再 `id` 稳定排序的副本。
 */
export function decodeModelCameras(input: unknown): ModelCamerasDecodeResult {
  if (!Array.isArray(input)) return { ok: false, reason: "modelCameras 必须是数组" };
  if (input.length > MAX_MODEL_CAMERAS) return { ok: false, reason: `modelCameras 超过上限 ${MAX_MODEL_CAMERAS}` };
  const seen = new Set<string>();
  const cameras: ModelCamera[] = [];
  for (const raw of input) {
    if (!isJsonObject(raw)) return { ok: false, reason: "modelCameras 元素必须是对象" };
    const id = raw.id;
    if (!isNonEmptyString(id) || !isBoundedId(id)) return { ok: false, reason: "镜头 id 非法" };
    if (seen.has(id)) return { ok: false, reason: `镜头 id 重复：${id}` };
    const name = raw.name;
    if (!isNonEmptyString(name) || name.length > MAX_MODEL_CAMERA_NAME_LENGTH) {
      return { ok: false, reason: `镜头 ${id} 名称非法` };
    }
    if (!isFiniteNumber(raw.order) || raw.order < 0 || !Number.isInteger(raw.order)) {
      return { ok: false, reason: `镜头 ${id} order 必须是非负整数` };
    }
    if (!isFiniteNumber(raw.azimuth)) return { ok: false, reason: `镜头 ${id} azimuth 必须是有限数值` };
    if (!isFiniteNumber(raw.distance) || raw.distance <= 0) {
      return { ok: false, reason: `镜头 ${id} distance 必须是正有限数值` };
    }
    const aspect = readCameraAspect(raw.aspect, id);
    if (aspect === INVALID_ASPECT) {
      return { ok: false, reason: `镜头 ${id} aspect 必须是 ${MODEL_CAMERA_ASPECTS.join(" / ")} 之一` };
    }
    const elevation = readCameraElevation(raw.elevation);
    if (elevation === INVALID_ELEVATION) {
      return {
        ok: false,
        reason: `镜头 ${id} elevation 必须是位于 [-90°, +90°] 的有限弧度`
      };
    }
    const focusOffset = readFocusOffset(raw.focusOffset);
    if (focusOffset === INVALID_FOCUS_OFFSET) {
      return { ok: false, reason: `镜头 ${id} focusOffset 必须是三分量有限数值` };
    }
    seen.add(id);
    cameras.push({
      id,
      name,
      order: raw.order,
      azimuth: raw.azimuth,
      elevation,
      distance: raw.distance,
      aspect,
      ...(focusOffset ? { focusOffset } : {})
    });
  }
  cameras.sort(compareModelCameras);
  return { ok: true, value: cameras };
}

/** 非法 aspect 哨兵。 */
const INVALID_ASPECT = Symbol("invalid-aspect");

/**
 * 读取并校验 `aspect`：必须是受支持值；缺失/未知 → 哨兵（整条集合拒绝）。
 */
function readCameraAspect(raw: unknown, _id: string): ModelCameraAspect | typeof INVALID_ASPECT {
  return typeof raw === "string" && MODEL_CAMERA_ASPECTS.includes(raw as ModelCameraAspect)
    ? (raw as ModelCameraAspect)
    : INVALID_ASPECT;
}

/** elevation 非法哨兵（区分“缺省”与“非法”）。 */
const INVALID_ELEVATION = Symbol("invalid-elevation");

/**
 * 读取并校验 `elevation`：必须是位于 `[-90°, +90°]` 的有限弧度；缺失/非法 → 哨兵。
 */
function readCameraElevation(raw: unknown): number | typeof INVALID_ELEVATION {
  if (!isFiniteNumber(raw)) return INVALID_ELEVATION;
  if (raw < SHOT_CAMERA_MIN_ELEVATION || raw > SHOT_CAMERA_MAX_ELEVATION) return INVALID_ELEVATION;
  return raw;
}

/** focusOffset 非法哨兵（区分“缺省”与“非法”）。 */
const INVALID_FOCUS_OFFSET = Symbol("invalid-focus-offset");

/**
 * 读取并校验可选 `focusOffset`：缺省/`null` → `null`（不携带）；非法 → 哨兵。
 * 已知对象里出现未知字段时丢弃（只保留 x/y/z）。
 */
function readFocusOffset(raw: unknown): ModelCameraFocusOffset | null | typeof INVALID_FOCUS_OFFSET {
  if (raw === undefined || raw === null) return null;
  if (!isJsonObject(raw)) return INVALID_FOCUS_OFFSET;
  const { x, y, z } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return INVALID_FOCUS_OFFSET;
  return { x, y, z };
}

/** 稳定排序：`order` 再 `id`。 */
export function compareModelCameras(a: ModelCamera, b: ModelCamera): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 读取节点上的合法镜头集合；缺失/空/非法时返回空数组（用于工具栏渲染，不抛错）。 */
export function readModelCameras(nodeData: unknown): ModelCamera[] {
  if (!isJsonObject(nodeData)) return [];
  const raw = nodeData.modelCameras;
  if (raw === undefined || raw === null) return [];
  const decoded = decodeModelCameras(raw);
  return decoded.ok ? decoded.value : [];
}
