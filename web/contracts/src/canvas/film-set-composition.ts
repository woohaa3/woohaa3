import { mediaTimelineLocalTime } from "./media-time.js";
/**
 * 片场组合内容入口（change: 2026-10-09-add-film-set-object-motion-and-editing，
 * 任务 3.1 / design D2）。
 *
 * 组合入口读取全部 model items 与 ground 几何，输出可丢弃的**对象图**与无碰撞的
 * `(itemId, partId)` 运行时身份。片场节点的自身模型就是整场 items 组合；`groupAppearance`
 * 只属于普通组，不参与片场组合。组合 IR 只用于发送给执行器，绝不写回 canonical nodeData。
 *
 * - 每个 item 的模型部件映射到 `encodeFilmSetPartId(itemId, partId)`，item 根为
 *   `encodeFilmSetPartId(itemId, "")`；
 * - material / animation 目标 id 一并重映射，避免同名部件/材质跨对象碰撞；
 * - items 重排不改变对象或部件身份；子 motion 中的对象内 partId 保持原语义（由 adapter 编码）。
 *
 * 本模块纯函数、JSON-only。
 */
import {
  encodeFilmSetPartId,
  isFilmSetMediaItem,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetLocalTransform,
  type FilmSetMotion,
  type FilmSetPlayback
} from "./film-set-content.js";
import type { ModelPlacement } from "./model-definition.js";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { executeMotionScript } from "./motion-executor.js";
import { evaluateMotionIr, type ModelMotionDelta, type MotionIr } from "./motion-ir.js";
import type { BevyFilmSetObjectMotion } from "./render-scene.js";
import { quatFromEulerYXZDegrees, quatMul, type Quat } from "./model-transform.js";
import type { SceneV2Op, SceneV2ShapeOp } from "./scene-ir-v2.js";

/** 独立片场根保留 id（非空、不与真实 itemId 碰撞；itemId 必须非空）。 */
export const FILM_SET_SCENE_ROOT_ID = "\u0000scene";

/** 组合输入中的一个模型对象（ops 由调用方执行该 item 的 modelScript 得到）。 */
export type FilmSetCompositionModel = {
  itemId: string;
  localTransform: FilmSetLocalTransform;
  ops: readonly SceneV2Op[];
  /**
   * 源模型原 placement（change design D4 固定变换链中的「源模型原 placement」）。
   * 作为 item 根 group 与模型层级之间的内层 group。缺省即单位变换。
   */
  placement?: ModelPlacement;
};

/** 组合输入中的一个地面对象。 */
export type FilmSetCompositionGround = {
  itemId: string;
  localTransform: FilmSetLocalTransform;
  size: { width: number; depth: number };
  color?: string;
};

export type FilmSetCompositionInput = {
  /**
   * D7 独立片场根（整体摆放）：作为所有 item 的父级，每层只应用一次。缺失即单位变换。
   * 空片场也保留该根（可编辑整体入口），它不是 authored 模型、不创建任何 mesh/item。
   */
  scenePlacement?: FilmSetLocalTransform;
  models?: readonly FilmSetCompositionModel[];
  grounds?: readonly FilmSetCompositionGround[];
};

export type FilmSetComposition = {
  /** 组合后的 Scene IR ops（可发送 `prepare_and_register_model_resource`）。 */
  ops: SceneV2Op[];
  /** 对象根 id（`encodeFilmSetPartId(itemId, "")`）。 */
  itemRoots: Record<string, string>;
  /** D7 独立片场根 id（每个 item 的父级）。 */
  sceneRoot: string;
};

const GROUND_DEFAULT_COLOR = "#9aa4b2";
/** 地面厚度（世界单位），保证可见且不与模型 z-fighting。 */
export const FILM_SET_GROUND_THICKNESS = 0.15;

/**
 * 构建片场组合 Scene IR（仅 items）。
 *
 * 顺序稳定：独立片场根 → 各 model item → 各 ground。每个对象包一层 group 根，承载
 * `localTransform`，子部件保持原层级。片场的自身模型就是整场 items；`groupAppearance`
 * 只属于普通组，不进入组合。
 */
export function composeFilmSetScene(input: FilmSetCompositionInput): FilmSetComposition {
  const ops: SceneV2Op[] = [];
  const itemRoots: Record<string, string> = {};
  const sceneRoot = FILM_SET_SCENE_ROOT_ID;

  ops.push(groupOp(sceneRoot, null, input.scenePlacement ?? identityTransform()));

  for (const model of input.models ?? []) {
    const rootId = encodeFilmSetPartId(model.itemId, "");
    itemRoots[model.itemId] = rootId;
    ops.push(groupOp(rootId, sceneRoot, model.localTransform));
    if (model.placement) {
      const placementId = encodeFilmSetPartId(model.itemId, "\u0000placement");
      ops.push(groupOp(placementId, rootId, modelPlacementToLocal(model.placement)));
      ops.push(...remapOps(model.ops, model.itemId, placementId));
    } else {
      ops.push(...remapOps(model.ops, model.itemId, rootId));
    }
  }

  for (const ground of input.grounds ?? []) {
    const rootId = encodeFilmSetPartId(ground.itemId, "");
    itemRoots[ground.itemId] = rootId;
    ops.push(groupOp(rootId, sceneRoot, ground.localTransform));
    ops.push({
      t: "box",
      id: encodeFilmSetPartId(ground.itemId, "surface"),
      parent: rootId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: null,
      color: ground.color ?? GROUND_DEFAULT_COLOR,
      size: [ground.size.width, FILM_SET_GROUND_THICKNESS, ground.size.depth]
    });
  }

  return { ops, itemRoots, sceneRoot };
}

function groupOp(id: string, parent: string | null, transform: FilmSetLocalTransform): SceneV2ShapeOp {
  return {
    t: "group",
    id,
    parent,
    position: [transform.offset.x, transform.offset.y, transform.offset.z],
    rotation: [0, degrees(transform.yaw), 0],
    scale: [transform.scale, transform.scale, transform.scale],
    material: null,
    color: null
  };
}

function identityTransform(): FilmSetLocalTransform {
  return { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
}

/** ModelDefinition 的 yaw 是角度；片场局部变换统一使用弧度。 */
function modelPlacementToLocal(placement?: ModelPlacement): FilmSetLocalTransform {
  if (!placement) return identityTransform();
  return {
    offset: { ...placement.offset },
    scale: placement.scale,
    yaw: placement.yaw * Math.PI / 180
  };
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * 把一份已校验的 ops 重映射到给定作用域。
 *
 * shape/material 的 `id` 与 shape 的 `parent`/`material` 引用、animation 的 `id` 目标全部编码；
 * 未识别 op 原样保留（validator 已保证全部合法）。
 */
function remapOps(ops: readonly SceneV2Op[], itemId: string, rootId: string): SceneV2Op[] {
  const remapped: SceneV2Op[] = [];
  for (const op of ops) {
    if (op.t === "material") {
      remapped.push({ ...op, id: encodeFilmSetPartId(itemId, op.id) });
      continue;
    }
    if (op.t === "oscillate" || op.t === "move" || op.t === "rotate") {
      remapped.push({ ...op, id: encodeFilmSetPartId(itemId, op.id) });
      continue;
    }
    const shape = op as SceneV2ShapeOp;
    remapped.push({
      ...shape,
      id: encodeFilmSetPartId(itemId, shape.id),
      parent: shape.parent === null ? rootId : encodeFilmSetPartId(itemId, shape.parent),
      material: shape.material === null ? null : encodeFilmSetPartId(itemId, shape.material)
    });
  }
  return remapped;
}

/**
 * 构建片场内部对象的 child 运动投影（design D2/D4/D10）。
 *
 * 对象动作只来自传入的 `bindings`（`{ itemId, motion, playback }`），不再读取 item.motion。
 * 每个有非空 `motionScript` 的对象：以对象自身模型部件集合校验动作目标，把目标编码为组合
 * 作用域 id，并附带对象基础局部变换与局部 playback。非法动作被隔离为对象诊断，不影响其他对象。
 */
export function buildFilmSetObjectMotions(input: {
  filmSetContent: FilmSetContent;
  /** 目标片段的 binding 投影（运行时视图，见 `resolveFilmSetClip`）。 */
  bindings?: readonly { itemId: string; motion?: FilmSetMotion; playback?: FilmSetPlayback }[];
}): { motions: BevyFilmSetObjectMotion[]; diagnostics: string[] } {
  const motions: BevyFilmSetObjectMotion[] = [];
  const diagnostics: string[] = [];
  const byItem = new Map((input.bindings ?? []).map(binding => [binding.itemId, binding]));
  for (const item of input.filmSetContent.items) {
    const binding = byItem.get(item.id);
    if (!binding?.motion || binding.motion.motionScript.trim() === "") continue;
    const playback = binding.playback ?? { startTime: 0, duration: 0, timeScale: 1, loop: false };
    if (!(playback.duration > 0)) {
      diagnostics.push(`片场对象 ${item.id} 动作缺少正有限 duration`);
      continue;
    }
    const rootId = encodeFilmSetPartId(item.id, "");
    const partIds = new Set<string>(["root", ""]);
    const partIdMap: Record<string, string> = { root: rootId, "": rootId };
    if (item.kind === "model") {
      const execution = executeModelScriptVersioned(item.model.modelScript, item.model.modelScriptVersion);
      if (!execution.ok) {
        diagnostics.push(`片场对象 ${item.id} 模型编译失败：${execution.stage}:${execution.code}`);
        continue;
      }
      for (const op of execution.scene.ops) {
        if (op.t === "material") continue;
        partIds.add(op.id);
        if (op.id !== "root") partIdMap[op.id] = encodeFilmSetPartId(item.id, op.id);
      }
    } else {
      // 媒体/地面只有对象根作为动作目标。
      partIds.add("surface");
      partIdMap.surface = encodeFilmSetPartId(item.id, "surface");
    }
    const execution = executeMotionScript(binding.motion.motionScript, {
      duration: playback.duration,
      partIds
    });
    if (!execution.ok) {
      diagnostics.push(`片场对象 ${item.id} 动作非法：${execution.stage}:${execution.code}：${execution.message}`);
      continue;
    }
    if (execution.ir.cameraMotion.length > 0) {
      diagnostics.push(`片场对象 ${item.id} child 动作不得操作共享镜头`);
      continue;
    }
    motions.push({
      itemId: item.id,
      playback: {
        startTime: playback.startTime,
        duration: playback.duration,
        timeScale: playback.timeScale,
        loop: playback.loop
      },
      modelMotion: execution.ir.modelMotion,
      partIds: partIdMap
    });
  }
  return { motions, diagnostics };
}

export type { MotionIr };

/**
 * 由一份片场运行时片段视图构建固定 T 的**静态**组合 ops（供原生预览烘焙单帧）。
 *
 * 组合独立片场根、内部模型与地面；对每个有 binding 动作的对象按其局部时间求值，把增量烘焙进
 * 对象根/部件的局部变换。返回组合 ops 与对象级诊断（任一对象模型/动作非法）。
 *
 * 媒体对象（图片/视频）不属于模型几何，由调用方另行处理（原生需要真实媒体帧，不能以占位冒充）。
 */
export function composeFilmSetPreviewAtTime(
  input: {
    scenePlacement: FilmSetLocalTransform;
    filmSetContent: FilmSetContent;
    bindings?: readonly { itemId: string; motion?: FilmSetMotion; playback?: FilmSetPlayback }[];
  },
  time: number
): { ops: SceneV2Op[]; diagnostics: string[]; hasMedia: boolean } {
  const content = input.filmSetContent;
  const diagnostics: string[] = [];
  let hasMedia = false;
  const models: FilmSetCompositionModel[] = [];
  const grounds: FilmSetCompositionGround[] = [];
  for (const item of content.items) {
    if (isFilmSetMediaItem(item)) {
      hasMedia = true;
      continue;
    }
    if (item.kind === "ground") {
      grounds.push({
        itemId: item.id,
        localTransform: item.localTransform,
        size: { ...item.size },
        ...(item.color ? { color: item.color } : {})
      });
      continue;
    }
    const execution = executeModelScriptVersioned(item.model.modelScript, item.model.modelScriptVersion);
    if (!execution.ok) {
      diagnostics.push(`片场对象 ${item.id} 模型编译失败：${execution.stage}:${execution.code}`);
      continue;
    }
    models.push({ itemId: item.id, localTransform: item.localTransform, ops: execution.scene.ops, placement: item.model.placement });
  }
  const composition = composeFilmSetScene({
    scenePlacement: input.scenePlacement,
    models,
    grounds
  });
  const byItem = new Map((input.bindings ?? []).map(binding => [binding.itemId, binding]));
  // 烘焙对象动作（固定 T 的局部时间）。
  for (const item of content.items) {
    const binding = byItem.get(item.id);
    if (!binding?.motion || binding.motion.motionScript.trim() === "") continue;
    const local = mediaTimelineLocalTime(binding.playback, time);
    if (local === null) continue;
    const rootId = composition.itemRoots[item.id];
    if (!rootId) continue;
    const bake = bakeObjectMotion(item, binding.motion, binding.playback, local);
    if (!bake.ok) {
      diagnostics.push(`片场对象 ${item.id} 动作：${bake.reason}`);
      continue;
    }
    applyBakedDeltas(composition.ops, item.id, rootId, bake.deltas);
  }
  return { ops: composition.ops, diagnostics, hasMedia };
}

type BakedMotion = { ok: true; deltas: Map<string, ModelMotionDelta> } | { ok: false; reason: string };

function bakeObjectMotion(
  item: FilmSetItem,
  motion: FilmSetMotion,
  playback: FilmSetPlayback | undefined,
  localTime: number
): BakedMotion {
  const rootId = encodeFilmSetPartId(item.id, "");
  const partIds = new Set<string>(["root", ""]);
  const targetMap: Record<string, string> = { root: rootId, "": rootId };
  if (item.kind === "model") {
    const execution = executeModelScriptVersioned(item.model.modelScript, item.model.modelScriptVersion);
    if (!execution.ok) return { ok: false, reason: `${execution.stage}:${execution.code}` };
    for (const op of execution.scene.ops) {
      if (op.t === "material") continue;
      partIds.add(op.id);
      if (op.id !== "root") targetMap[op.id] = encodeFilmSetPartId(item.id, op.id);
    }
  }
  const resolved = playback ?? { startTime: 0, duration: 0, timeScale: 1, loop: false };
  const execution = executeMotionScript(motion.motionScript, {
    duration: resolved.duration > 0 ? resolved.duration : 1,
    partIds
  });
  if (!execution.ok) return { ok: false, reason: `${execution.stage}:${execution.code}：${execution.message}` };
  if (execution.ir.cameraMotion.length > 0) return { ok: false, reason: "child 动作不得操作共享镜头" };
  const evaluation = evaluateMotionIr(execution.ir, localTime, {
    duration: resolved.duration > 0 ? resolved.duration : 1,
    partIds,
    initialCamera: { azimuth: 0, elevation: 0, distance: 1, focusOffset: { x: 0, y: 0, z: 0 } }
  });
  if (!evaluation.ok) return { ok: false, reason: evaluation.message };
  const deltas = new Map<string, ModelMotionDelta>();
  for (const [targetId, delta] of evaluation.model) {
    const encoded = targetMap[targetId];
    if (!encoded) return { ok: false, reason: `跨对象目标：${targetId}` };
    deltas.set(encoded, delta);
  }
  return { ok: true, deltas };
}

function applyBakedDeltas(
  ops: SceneV2Op[],
  itemId: string,
  rootId: string,
  deltas: Map<string, ModelMotionDelta>
): void {
  for (const [targetId, delta] of deltas) {
    const found = ops.find((candidate) => candidate.t !== "material" && candidate.id === targetId);
    if (!found || found.t === "material" || found.t === "oscillate" || found.t === "move" || found.t === "rotate") continue;
    const op = found as SceneV2ShapeOp;
    void itemId;
    void rootId;
    op.position = [op.position[0] + delta.translation[0], op.position[1] + delta.translation[1], op.position[2] + delta.translation[2]];
    op.scale = [op.scale[0] * delta.scale[0], op.scale[1] * delta.scale[1], op.scale[2] * delta.scale[2]];
    op.rotation = quatToEulerYXZDegrees(quatMul(quatFromEulerYXZDegrees(op.rotation), delta.rotation));
  }
}

function quatToEulerYXZDegrees(quat: Quat): [number, number, number] {
  const [x, y, z, w] = quat;
  const m23 = 2 * (y * z - x * w);
  const pitch = Math.asin(-Math.max(-1, Math.min(1, m23)));
  const yaw = Math.abs(m23) < 0.9999999 ? Math.atan2(2 * (x * z + y * w), 1 - 2 * (x * x + y * y)) : Math.atan2(-2 * (x * z - y * w), 1 - 2 * (y * y + z * z));
  const roll = Math.abs(m23) < 0.9999999 ? Math.atan2(2 * (x * y + z * w), 1 - 2 * (x * x + z * z)) : 0;
  const toDeg = 180 / Math.PI;
  return [pitch * toDeg, yaw * toDeg, roll * toDeg];
}
