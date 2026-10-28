/**
 * 模型镜头契约：mutation 与默认值/身份
 * （自 `model-cameras.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R18）。
 */
import { isFiniteNumber } from "../../validation.js";
import {
  DEFAULT_MODEL_CAMERA_ASPECT,
  MAX_MODEL_CAMERAS,
  MAX_MODEL_CAMERA_MUTATIONS,
  MAX_MODEL_CAMERA_NAME_LENGTH,
  MODEL_CAMERA_DEFAULT_NAME_PREFIX,
  SHOT_CAMERA_DEFAULT_ELEVATION,
  SHOT_CAMERA_MAX_ELEVATION,
  SHOT_CAMERA_MIN_ELEVATION,
  type ModelCamera,
  type ModelCameraAspect,
  type ModelCameraFocusOffset,
  type ModelCameraMutation,
  type ModelCameraMutationResult,
  type ModelCameraMutationResultBatch
} from "./types.js";
import { decodeModelCameras } from "./codec.js";

/** 生成稳定的镜头 id（不依赖时钟；由 nodeId + 序号 + 随机熵派生，保证同节点唯一）。 */
export function createModelCameraId(input?: { nodeId?: string; seed?: string }): string {
  const entropy = input?.seed ?? randomEntropy();
  const base = `${input?.nodeId ?? "camera"}\u0000${entropy}`;
  return `cam-${hashText(base)}`;
}

/**
 * 基于**最新 working 列表**重放一次 camera-ID 变更，避免并发编辑互相覆盖。
 */
export function applyModelCameraMutation(
  current: readonly ModelCamera[],
  mutation:
    | { kind: "upsert"; camera: ModelCamera }
    | { kind: "remove"; id: string }
): ModelCamera[] {
  const base = [...current];
  let next: ModelCamera[];
  if (mutation.kind === "remove") {
    next = base.filter((camera) => camera.id !== mutation.id);
  } else {
    const index = base.findIndex((camera) => camera.id === mutation.camera.id);
    if (index >= 0) {
      next = base.map((camera, i) => (i === index ? mutation.camera : camera));
    } else {
      if (base.length >= MAX_MODEL_CAMERAS) return base;
      next = [...base, mutation.camera];
    }
  }
  return renumberModelCameras(next);
}

/** 按当前顺序重新分配连续 `order`（0..n-1），保持其它字段与输入顺序不变。 */
export function renumberModelCameras(cameras: readonly ModelCamera[]): ModelCamera[] {
  return cameras.map((camera, index) => ({ ...camera, order: index }));
}

/** 默认名称：“镜头 N”（N 为列表中的序号 +1）。 */
export function defaultModelCameraName(index: number): string {
  return `${MODEL_CAMERA_DEFAULT_NAME_PREFIX} ${index + 1}`;
}

/**
 * 重命名一条镜头（不改 pose/order；名称裁剪空白并限制长度）。
 */
export function renameModelCamera(
  cameras: readonly ModelCamera[],
  id: string,
  name: string
): ModelCamera[] {
  const trimmed = name.trim().slice(0, MAX_MODEL_CAMERA_NAME_LENGTH);
  if (trimmed === "") return [...cameras];
  return cameras.map((camera) => (camera.id === id ? { ...camera, name: trimmed } : camera));
}

/**
 * 把仰角钳制进规范半圆范围 `[-90°, +90°]`（schema 层）。
 */
export function clampCameraElevation(elevation: number): number {
  if (!isFiniteNumber(elevation)) return SHOT_CAMERA_DEFAULT_ELEVATION;
  return Math.min(SHOT_CAMERA_MAX_ELEVATION, Math.max(SHOT_CAMERA_MIN_ELEVATION, elevation));
}

/** 读取镜头有效仰角；缺省返回画布全局 pitch。 */
export function modelCameraElevation(camera: ModelCamera): number {
  return camera.elevation ?? SHOT_CAMERA_DEFAULT_ELEVATION;
}

/**
 * 重置一条镜头到默认取景：清空 `focusOffset` 并回到给定默认 pose，保留稳定 `id`、用户可见
 * `name`、`order` 与 `aspect`。
 */
export function resetModelCamera(
  cameras: readonly ModelCamera[],
  id: string,
  defaults: { azimuth: number; distance: number; elevation?: number }
): ModelCamera[] {
  return cameras.map((camera) =>
    camera.id === id
      ? {
          id: camera.id,
          name: camera.name,
          order: camera.order,
          azimuth: defaults.azimuth,
          elevation: clampCameraElevation(defaults.elevation ?? SHOT_CAMERA_DEFAULT_ELEVATION),
          distance: defaults.distance,
          aspect: camera.aspect
        }
      : camera
  );
}

/** 读取镜头有效 focusOffset；缺省返回零偏移（不产生新对象语义差异）。 */
export function modelCameraFocusOffset(camera: ModelCamera): ModelCameraFocusOffset {
  return camera.focusOffset ?? { x: 0, y: 0, z: 0 };
}

/** 设置一条镜头的画幅（design D8）。未知 id 或非法画幅返回原列表副本；其余字段不变。 */
export function setModelCameraAspect(
  cameras: readonly ModelCamera[],
  id: string,
  aspect: ModelCameraAspect
): ModelCamera[] {
  if (!MODEL_CAMERA_ASPECTS_INCLUDES(aspect)) return [...cameras];
  return cameras.map((camera) => (camera.id === id ? { ...camera, aspect } : camera));
}

/** 设置一条镜头的仰角。未知 id 返回原列表副本；越界/非有限值按半圆范围钳制。 */
export function setModelCameraElevation(
  cameras: readonly ModelCamera[],
  id: string,
  elevation: number
): ModelCamera[] {
  const value = clampCameraElevation(elevation);
  return cameras.map((camera) => (camera.id === id ? { ...camera, elevation: value } : camera));
}

/** 新建一条默认镜头：稳定 id、默认名称、`16:9` 画幅，追加到末尾并承载给定 pose。 */
export function createDefaultModelCamera(input: {
  existing: readonly ModelCamera[];
  azimuth: number;
  distance: number;
  aspect?: ModelCameraAspect;
  elevation?: number;
  nodeId?: string;
  seed?: string;
}): ModelCamera {
  const order = input.existing.length;
  const id = createModelCameraId({ ...(input.nodeId ? { nodeId: input.nodeId } : {}), ...(input.seed ? { seed: input.seed } : {}) });
  return {
    id,
    name: defaultModelCameraName(order),
    order,
    azimuth: input.azimuth,
    elevation: clampCameraElevation(input.elevation ?? SHOT_CAMERA_DEFAULT_ELEVATION),
    distance: input.distance,
    aspect: input.aspect ?? DEFAULT_MODEL_CAMERA_ASPECT
  };
}

/**
 * 在给定**权威集合副本**上应用一条单条变更，返回新的规范化集合。
 */
export function applyModelCameraMutationCommand(
  current: readonly ModelCamera[],
  mutation: ModelCameraMutation,
  input?: { nodeId?: string; seed?: string }
): ModelCameraMutationResult {
  switch (mutation.kind) {
    case "create": {
      if (current.length >= MAX_MODEL_CAMERAS) {
        return { ok: false, code: "model-cameras-limit", message: `镜头数量达到上限 ${MAX_MODEL_CAMERAS}` };
      }
      const base = createDefaultModelCamera({
        existing: current,
        azimuth: mutation.azimuth,
        distance: mutation.distance,
        ...(mutation.aspect !== undefined ? { aspect: mutation.aspect } : {}),
        ...(mutation.elevation !== undefined ? { elevation: mutation.elevation } : {}),
        ...(input?.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        ...(input?.seed !== undefined ? { seed: input.seed } : {})
      });
      let name = base.name;
      if (mutation.name !== undefined) {
        name = mutation.name.trim().slice(0, MAX_MODEL_CAMERA_NAME_LENGTH);
        if (name === "") return { ok: false, code: "invalid-model-cameras", message: "镜头名称不能为空" };
      }
      const created: ModelCamera = {
        ...base,
        name,
        ...(mutation.focusOffset !== undefined ? { focusOffset: mutation.focusOffset } : {})
      };
      const normalized = decodeModelCameras([created]);
      if (!normalized.ok) return { ok: false, code: "invalid-model-cameras", message: normalized.reason };
      return { ok: true, cameras: applyModelCameraMutation(current, { kind: "upsert", camera: normalized.value[0]! }) };
    }
    case "update": {
      const index = current.findIndex((camera) => camera.id === mutation.id);
      if (index < 0) return { ok: false, code: "unknown-camera", message: `镜头 ${mutation.id} 不存在` };
      const existing = current[index]!;
      const candidate = {
        ...existing,
        ...(mutation.azimuth !== undefined ? { azimuth: mutation.azimuth } : {}),
        ...(mutation.distance !== undefined ? { distance: mutation.distance } : {}),
        ...(mutation.elevation !== undefined ? { elevation: clampCameraElevation(mutation.elevation) } : {}),
        ...(mutation.aspect !== undefined ? { aspect: mutation.aspect } : {}),
        ...(mutation.focusOffset !== undefined ? { focusOffset: mutation.focusOffset } : {})
      };
      const normalized = decodeModelCameras([candidate]);
      if (!normalized.ok) return { ok: false, code: "invalid-model-cameras", message: normalized.reason };
      return {
        ok: true,
        cameras: current.map((camera, i) => (i === index ? normalized.value[0]! : camera))
      };
    }
    case "remove": {
      if (!current.some((camera) => camera.id === mutation.id)) {
        return { ok: false, code: "unknown-camera", message: `镜头 ${mutation.id} 不存在` };
      }
      return { ok: true, cameras: applyModelCameraMutation(current, { kind: "remove", id: mutation.id }) };
    }
    case "rename": {
      if (!current.some((camera) => camera.id === mutation.id)) {
        return { ok: false, code: "unknown-camera", message: `镜头 ${mutation.id} 不存在` };
      }
      const trimmed = mutation.name.trim();
      if (trimmed === "") return { ok: false, code: "invalid-model-cameras", message: "镜头名称不能为空" };
      return { ok: true, cameras: renameModelCamera(current, mutation.id, trimmed) };
    }
    case "reset": {
      if (!current.some((camera) => camera.id === mutation.id)) {
        return { ok: false, code: "unknown-camera", message: `镜头 ${mutation.id} 不存在` };
      }
      return {
        ok: true,
        cameras: resetModelCamera(current, mutation.id, {
          azimuth: mutation.azimuth,
          distance: mutation.distance,
          ...(mutation.elevation !== undefined ? { elevation: mutation.elevation } : {})
        })
      };
    }
    default:
      return { ok: false, code: "malformed-request", message: "未知的镜头变更 kind" };
  }
}

/**
 * 在给定**权威集合副本**上顺序应用一批单条变更，整批原子：任意一条失败即整体失败。
 */
export function applyModelCameraMutationBatch(
  current: readonly ModelCamera[],
  mutations: readonly ModelCameraMutation[],
  input?: { nodeId?: string; seed?: string }
): ModelCameraMutationResultBatch {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return { ok: false, code: "malformed-request", message: "镜头变更列表不能为空", failedIndex: -1 };
  }
  if (mutations.length > MAX_MODEL_CAMERA_MUTATIONS) {
    return {
      ok: false,
      code: "model-cameras-limit",
      message: `镜头变更数量超过上限 ${MAX_MODEL_CAMERA_MUTATIONS}`,
      failedIndex: -1
    };
  }
  let working: ModelCamera[] = [...current];
  for (let index = 0; index < mutations.length; index += 1) {
    const applied = applyModelCameraMutationCommand(working, mutations[index]!, {
      ...(input?.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      ...(input?.seed !== undefined ? { seed: `${input.seed}:${index}` } : {})
    });
    if (!applied.ok) return { ok: false, code: applied.code, message: applied.message, failedIndex: index };
    working = applied.cameras;
  }
  return { ok: true, cameras: working };
}

// 派生常量/身份工具：局部导入避免循环。
import { MODEL_CAMERA_ASPECTS } from "./types.js";
function MODEL_CAMERA_ASPECTS_INCLUDES(aspect: ModelCameraAspect): boolean {
  return (MODEL_CAMERA_ASPECTS as readonly string[]).includes(aspect);
}

/** 稳定短哈希（djb2）——无外部依赖，跨运行单元一致。 */
function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 随机熵（浏览器/Node 均可用；仅用于生成 display 无关的稳定 id）。 */
function randomEntropy(): string {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
