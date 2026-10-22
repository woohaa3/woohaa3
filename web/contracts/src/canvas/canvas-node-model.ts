/**
 * `model3d` / `animation3d` 自包含节点数据契约
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.1 / 1.2 / 1.3）。
 *
 * 两类节点都保存**完整本地 ModelDefinition**，不通过来源节点 ID 取得运行数据。为与仓库既有
 * 约定一致（`modelScript` / `modelCameras` 等均为 flat nodeData 字段），这里也使用 flat 字段，
 * 再由本模块的 decoder 组装成结构化 `Model3DNodeData` / `FilmSetNodeData`。
 *
 * `origin` 仅为可选来源说明，不参与加载或运行；连线的增删不改变节点模型（design「创建和导入
 * 是复制快照」）。`timelineDuration` 为 0 表示静态节点；有任意运动时须为正有限秒数。
 */
import { bevyNodeSize, COMPOSITE_ASSET_DEFAULT_SIZE } from "./render-scene.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import {
  clonePlacement,
  decodeModelDefinition,
  type ModelContentVersion,
  type ModelDefinition,
  type ModelPlacement
} from "./model-definition.js";
import {
  basedOnModel,
  compareMotionToModel,
  type MotionBasedOnModelVersion,
  type MotionDefinition,
  type MotionVersionMatch
} from "./motion-script.js";
import { DEFAULT_MODEL_CAMERA_ASPECT, MODEL_CAMERA_ASPECTS, type ModelCameraAspect } from "./model-cameras.js";
import type { MotionIr } from "./motion-ir.js";
import {
  decodeFilmSetContentFromNodeData,
  decodeFilmSetLocalTransform,
  type FilmSetContent,
  type FilmSetLocalTransform
} from "./film-set-content.js";
import { buildFilmSetObjectMotions } from "./film-set-composition.js";
import { isFiniteNumber, isJsonObject } from "../validation.js";
import { decodeFilmSetAnimations, emptyFilmSetAnimations, type FilmSetAnimations } from "./film-set-animations.js";
import { decodeFilmSetConversionOriginRecord } from "./film-set-conversion/origin.js";
import type { FilmSetConversionOriginRecord } from "./film-set-conversion/types.js";

/** canonical 节点类型：自包含三维模型节点。 */
export const MODEL3D_NODE_TYPE = "model3d" as const;
/**
 * 片场节点类型（原 `ANIMATION3D_NODE_TYPE="animation3d"`）
 * （change: 2026-10-11-extract-film-set-extension，D1/D6/D11）。
 *
 * 片场以复合资产类别 `composite-asset` + `extensionId="film-set"` 持久化；本常量是片场
 * `kind` 判别值，等于共同类型。旧 `animation3d` 生产别名已移除。
 */
export const FILM_SET_NODE_TYPE = COMPOSITE_ASSET_NODE_TYPE as "composite-asset";

/** 时间线最长时长（秒），与运动 IR 预算一致。 */
export const ANIMATION_MAX_DURATION_SECONDS = 3600;

/** 初始镜头（动画节点固定拥有的第 0 秒镜头）。 */
export type InitialShotCamera = {
  /** 绕世界 Y 轴方位角（弧度）。 */
  azimuth: number;
  /** 竖直半圆仰角（弧度，`[-90°, +90°]`）。 */
  elevation: number;
  /** 相机到焦点的距离（正有限世界单位）。 */
  distance: number;
  /** 受支持画幅（与模型镜头并集一致）。 */
  aspect: ModelCameraAspect;
  /** 注视点偏移（相对 placement 后模型 AABB 中心）。 */
  focusOffset: { x: number; y: number; z: number };
};

/** 时间线定义。 */
export type AnimationTimeline = {
  /** 时长（秒）；0 表示静态。 */
  duration: number;
  loop: boolean;
};

/**
 * 可选来源说明。缺失、来源节点不可访问或被删除都不影响运行；不用于加载或运行。
 *
 * `conversion` 为「转为片场」快捷转换的来源记录（change: 2026-10-13-add-node-to-film-set-shortcut，
 * 任务 1.3/1.4 / design D5）：保存 requestId、来源种类/内容 hash、转换模型/adapter、指令版本与
 * 视频范围，以及无法映射到片场镜头的附加镜头说明。仅说明，不参与加载。
 */
export type ModelImportOrigin = {
  sourceNodeId?: string;
  sourceCanvasId?: string;
  importedModelContentHash: string;
  importedAt: string;
  conversion?: FilmSetConversionOriginRecord;
};

/** 三维模型节点的结构化 nodeData。 */
export type Model3DNodeData = {
  kind: typeof MODEL3D_NODE_TYPE;
  title: string;
  model: ModelDefinition;
};

/**
 * 片场节点的结构化 nodeData
 * （change: 2026-10-11-extract-film-set-extension，D1/D6/D7/D8/D10）。
 *
 * 片场属于复合资产类别，`kind` 即共同类型 `composite-asset`；业务判别由规范 nodeData 的
 * `extensionId="film-set"` 与完整身份校验承担，不在此结构内重复存储。
 *
 * items-only：片场**不再**保存顶层 authored 模型/顶层动作。全部几何只存在于
 * `filmSetContent.items`；对象动作只存在于 `filmSetAnimations.clips[].bindings[].motion`；
 * 每个片段拥有**独立且仅允许镜头**的 `cameraMotion`。`camera`/`timeline` 是默认片段派生出的
 * 运行时视图，不是规范存储字段；独立整体摆放按 D7 保存在 `scenePlacement`。
 *
 * 规范静态构图（D10）：没有 clips 时（新建/删除最后片段/无动画来源），稳定静态镜头持久化在
 * `sceneCamera`（与 `scenePlacement` 对应的规范字段）；有默认片段时以片段 `initialCamera`
 * 为准，`sceneCamera` 仍作为删空片段后的回退。它**不是**旧 `initialCamera` 节点字段。
 */
export type FilmSetNodeData = {
  kind: typeof FILM_SET_NODE_TYPE;
  title: string;
  /** D7：独立片场根（有限 offset、正等比 scale、Y yaw），与画布 rect 和派生 fit 分离。 */
  scenePlacement: FilmSetLocalTransform;
  /** D10 规范静态镜头（无 clips 时的持久化构图；有默认片段时作为删空回退）。 */
  sceneCamera: InitialShotCamera;
  /** 默认片段派生的运行时静态镜头视图（规范存储在各片段 initialCamera / 回退 sceneCamera）。 */
  camera: InitialShotCamera;
  /** 默认片段派生的运行时时间线视图（规范存储在各片段 timeline）。 */
  timeline: AnimationTimeline;
  /** 唯一几何来源：内部 items（模型/媒体/地面）。 */
  filmSetContent: FilmSetContent;
  /** 片段集合（schema 2）；缺失按空集合解释。全部镜头/对象动作都保存在此。 */
  filmSetAnimations?: FilmSetAnimations;
  origin?: ModelImportOrigin;
};

/** 每类 3D 节点的默认尺寸（与 Bevy 节点尺寸同源）。延迟求值避免模块循环依赖。 */
export function model3DNodeSize(): { width: number; height: number } {
  return bevyNodeSize("model");
}
/** 片场默认尺寸：节点矩形即范围框，模型居中并等比适配（见 `COMPOSITE_ASSET_DEFAULT_SIZE`）。 */
export function filmSetNodeSize(): { width: number; height: number } {
  return COMPOSITE_ASSET_DEFAULT_SIZE;
}

/** 判断节点类型是否为自包含 3D 节点。 */
export function isSelfContained3DNodeType(type: string): boolean {
  return type === MODEL3D_NODE_TYPE || type === FILM_SET_NODE_TYPE;
}

export type InitialShotCameraDecodeResult =
  | { ok: true; value: InitialShotCamera }
  | { ok: false; reason: string };

/**
 * 读取并校验 `initialCamera`；缺失时回退给定默认（由模型 AABB 派生）。
 *
 * 字段完整、数值有限、距离为正、画幅受支持；未知画幅整条拒绝（不静默替换）。
 */
export function decodeInitialShotCamera(
  input: unknown,
  fallback?: InitialShotCamera
): InitialShotCameraDecodeResult {
  if (input === undefined || input === null) {
    if (fallback) return { ok: true, value: cloneInitialCamera(fallback) };
    return { ok: false, reason: "initialCamera 缺失且无默认值" };
  }
  if (!isJsonObject(input)) return { ok: false, reason: "initialCamera 必须是对象" };
  const azimuth = input.azimuth;
  const elevation = input.elevation;
  const distance = input.distance;
  if (!isFiniteNumber(azimuth) || !isFiniteNumber(elevation) || !isFiniteNumber(distance)) {
    return { ok: false, reason: "initialCamera 的 azimuth/elevation/distance 必须是有限数值" };
  }
  if (!(distance > 0)) return { ok: false, reason: "initialCamera.distance 必须是正有限数值" };
  const aspect = readAspect(input.aspect);
  if (aspect === null) return { ok: false, reason: "initialCamera.aspect 非法" };
  const focusOffset = readFocusOffset(input.focusOffset);
  if (focusOffset === null) return { ok: false, reason: "initialCamera.focusOffset 必须是三分量有限数值" };
  return { ok: true, value: { azimuth, elevation, distance, aspect, focusOffset } };
}

/** 读取时间线；缺失按静态（duration 0、loop false）。 */
export function decodeAnimationTimeline(
  input: unknown
): { ok: true; value: AnimationTimeline } | { ok: false; reason: string } {
  if (input === undefined || input === null) return { ok: true, value: { duration: 0, loop: false } };
  if (!isJsonObject(input)) return { ok: false, reason: "timeline 必须是对象" };
  const duration = input.duration ?? 0;
  if (!isFiniteNumber(duration) || duration < 0 || duration > ANIMATION_MAX_DURATION_SECONDS) {
    return { ok: false, reason: "timeline.duration 必须在 [0, 3600] 秒内" };
  }
  const loop = input.loop ?? false;
  if (typeof loop !== "boolean") return { ok: false, reason: "timeline.loop 必须是布尔值" };
  return { ok: true, value: { duration, loop } };
}

/** 读取可选来源说明；缺失返回 undefined，非法整体丢弃（仅说明，不影响运行）。 */
export function decodeModelImportOrigin(input: unknown): ModelImportOrigin | undefined {
  if (!isJsonObject(input)) return undefined;
  const importedModelContentHash = input.importedModelContentHash;
  const importedAt = input.importedAt;
  if (typeof importedModelContentHash !== "string" || importedModelContentHash.length === 0) return undefined;
  if (typeof importedAt !== "string" || importedAt.length === 0) return undefined;
  const origin: ModelImportOrigin = { importedModelContentHash, importedAt };
  if (typeof input.sourceNodeId === "string" && input.sourceNodeId.length > 0) origin.sourceNodeId = input.sourceNodeId;
  if (typeof input.sourceCanvasId === "string" && input.sourceCanvasId.length > 0) {
    origin.sourceCanvasId = input.sourceCanvasId;
  }
  // 快捷转换来源记录（可选；非法整体丢弃，不影响既有 origin 字段）。
  const conversion = decodeFilmSetConversionOriginRecord(input.conversion);
  if (conversion) origin.conversion = conversion;
  return origin;
}

export type Model3DNodeDataDecodeResult =
  | { ok: true; value: Model3DNodeData }
  | { ok: false; reason: string };

/** 从 flat nodeData 读取模型节点完整定义。 */
export function decodeModel3DNodeData(nodeData: unknown): Model3DNodeDataDecodeResult {
  if (!isJsonObject(nodeData)) return { ok: false, reason: "nodeData 必须是对象" };
  const model = decodeModelDefinition(nodeData);
  if (!model.ok) return model;
  const title = typeof nodeData.title === "string" && nodeData.title.trim() ? nodeData.title.trim() : "模型";
  return { ok: true, value: { kind: MODEL3D_NODE_TYPE, title, model: model.value } };
}

export type FilmSetNodeDataDecodeResult =
  | { ok: true; value: FilmSetNodeData }
  | { ok: false; reason: string };

/** 片场顶层 authored 模型五字段（D8）：生产读取必须严格拒绝。 */
export const FILM_SET_TOP_LEVEL_MODEL_FIELDS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "modelContentVersion",
  "modelPlacement"
] as const;

/** 旧节点级动作/镜头/时间线字段（D10）：items-only 生产读取必须严格拒绝。 */
export const FILM_SET_LEGACY_NODE_ANIMATION_FIELDS = [
  "motionScript",
  "motionScriptLanguage",
  "motionScriptVersion",
  "motionRevision",
  "motionSourceHash",
  "motionBasedOnModelVersion",
  "initialCamera",
  "timeline"
] as const;

/**
 * 从 flat nodeData 读取片场完整定义（items-only，change D7/D8/D10）。
 *
 * - 严格拒绝顶层 authored 模型五字段与旧节点级动作/镜头/时间线字段（无兼容读取）；
 * - 独立根 `scenePlacement` 缺失按默认（单位）变换；非法整条拒绝；
 * - 规范静态构图 `sceneCamera`（D10）缺失按调用方回退/稳定默认；非法整条拒绝；
 * - `filmSetContent` 必须是 schema 3（items-only 静态集合）；
 * - `filmSetAnimations` 必须是 schema 3；缺失按空集合（新空片场）。
 *
 * 旧格式（顶层 model/clip.motion）只由隔离离线 reader 转换，本函数不提供任何兼容读取。
 */
export function decodeFilmSetNodeData(
  nodeData: unknown,
  options: { cameraFallback?: InitialShotCamera } = {}
): FilmSetNodeDataDecodeResult {
  if (!isJsonObject(nodeData)) return { ok: false, reason: "nodeData 必须是对象" };
  for (const field of FILM_SET_TOP_LEVEL_MODEL_FIELDS) {
    if (nodeData[field] !== undefined) return { ok: false, reason: `片场不得保存顶层模型字段 ${field}` };
  }
  for (const field of FILM_SET_LEGACY_NODE_ANIMATION_FIELDS) {
    if (nodeData[field] !== undefined) return { ok: false, reason: `片场不得保存旧节点级字段 ${field}` };
  }
  const scenePlacement = decodeFilmSetLocalTransform(nodeData.scenePlacement);
  if (!scenePlacement.ok) return { ok: false, reason: `scenePlacement 非法：${scenePlacement.reason}` };
  const content = decodeFilmSetContentFromNodeData(nodeData);
  if (!content.ok) return content;
  if (content.value.schemaVersion !== 3) return { ok: false, reason: "片场 filmSetContent 要求 schema 3（items-only）" };
  const animations = nodeData.filmSetAnimations === undefined
    ? { ok: true as const, value: emptyFilmSetAnimations() }
    : decodeFilmSetAnimations(nodeData.filmSetAnimations, content.value);
  if (!animations.ok) return animations;
  const clip = animations.value.clips.find(value => value.id === animations.value.defaultClipId);
  // D10 规范静态构图：无片段时 `sceneCamera` 是持久化来源；缺失按调用方回退或稳定默认。
  const fallbackCamera: InitialShotCamera = options.cameraFallback ?? {
    azimuth: 0,
    elevation: Math.PI / 4,
    distance: 4,
    aspect: DEFAULT_MODEL_CAMERA_ASPECT,
    focusOffset: { x: 0, y: 0, z: 0 }
  };
  const sceneCameraDecoded = decodeInitialShotCamera(nodeData.sceneCamera, fallbackCamera);
  if (!sceneCameraDecoded.ok) return { ok: false, reason: `sceneCamera 非法：${sceneCameraDecoded.reason}` };
  const sceneCamera = sceneCameraDecoded.value;
  const camera: InitialShotCamera = clip?.initialCamera ?? sceneCamera;
  const title = typeof nodeData.title === "string" && nodeData.title.trim() ? nodeData.title.trim() : "片场";
  const origin = decodeModelImportOrigin(nodeData.origin);
  return {
    ok: true,
    value: {
      kind: FILM_SET_NODE_TYPE,
      title,
      scenePlacement: scenePlacement.value,
      sceneCamera,
      camera,
      timeline: clip?.timeline ?? { duration: 0, loop: false },
      filmSetContent: content.value,
      filmSetAnimations: animations.value,
      ...(origin ? { origin } : {})
    }
  };
}

/**
 * 由片场片段的当前播放状态构造 Bevy 播放投影
 * （change: 2026-10-11-extract-film-set-extension，D10；原任务 4.1）。
 *
 * 只读取**该片段**的初始镜头/时间线与已校验 Motion IR（镜头来自片段独立 `cameraMotion`，
 * 对象动作来自 `compiledObjects`）；不依赖任何顶层模型。`motion` 必须已通过
 * `checkAnimationMotion` 得到 `valid`。
 */
export function buildAnimationPlayback(input: {
  nodeId: string;
  /** 片段初始镜头（第 0 秒）。 */
  camera: InitialShotCamera;
  /** 片段时间线。 */
  timeline: AnimationTimeline;
  /** 已校验的 Motion IR（由 `executeMotionScript` 成功结果提供）。 */
  ir: MotionIr;
  /** 当前时间（秒）。 */
  time: number;
  playing: boolean;
  compiledObjects?: ReturnType<typeof buildFilmSetObjectMotions>;
  /** 该镜头背景的具体色（`#rrggbb`）；缺省即跟随主题（D6）。 */
  backdrop?: string;
}): import("./render-scene.js").BevyAnimationPlayback {
  const camera = input.camera;
  const objects = input.compiledObjects ?? { motions: [], diagnostics: [] };
  return {
    nodeId: input.nodeId,
    version: input.ir.version,
    time: Number.isFinite(input.time) ? input.time : 0,
    duration: input.timeline.duration,
    looped: input.timeline.loop,
    playing: input.playing,
    ...(input.backdrop ? { backdrop: input.backdrop } : {}),
    initialCamera: {
      aspect: camera.aspect,
      azimuth: camera.azimuth,
      elevation: camera.elevation,
      distance: camera.distance,
      focusOffset: [camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z]
    },
    cameraMotion: input.ir.cameraMotion,
    modelMotion: input.ir.modelMotion,
    ...(objects.motions.length > 0 ? { objects: objects.motions } : {})
  };
}

/**
 * 动画节点的本地版本派生状态（不写入 model/motion 定义，详见 design「版本提示比较本节点数据」）。
 */
export type AnimationVersionState = {
  versionMatch: MotionVersionMatch;
  /** 已结束/未开始的轨道是否仍合法（此处只做内容比较，结构检查由 motion IR validator 承担）。 */
  basedOnModel: MotionBasedOnModelVersion;
  currentModel: ModelContentVersion;
};

/** 比较运动适配版本与当前本地模型内容版本。 */
export function animationVersionState(
  motion: MotionDefinition,
  model: ModelDefinition
): AnimationVersionState {
  return {
    versionMatch: compareMotionToModel(motion, model.contentVersion),
    basedOnModel: motion.basedOnModelVersion,
    currentModel: model.contentVersion
  };
}

/** 以当前本地模型内容建立「适配关联」（初次创建或用户显式确认适配）。 */
export function establishedBasedOn(model: ModelDefinition): MotionBasedOnModelVersion {
  return basedOnModel(model.contentVersion);
}

/** 深拷贝初始镜头。 */
export function cloneInitialCamera(camera: InitialShotCamera): InitialShotCamera {
  return {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    distance: camera.distance,
    aspect: camera.aspect,
    focusOffset: { ...camera.focusOffset }
  };
}

/** 默认画幅兼容读取。 */
function readAspect(input: unknown): ModelCameraAspect | null {
  if (input === undefined || input === null) return DEFAULT_MODEL_CAMERA_ASPECT;
  if (typeof input !== "string") return null;
  return (MODEL_CAMERA_ASPECTS as readonly string[]).includes(input) ? (input as ModelCameraAspect) : null;
}

function readFocusOffset(input: unknown): { x: number; y: number; z: number } | null {
  if (input === undefined || input === null) return { x: 0, y: 0, z: 0 };
  if (!isJsonObject(input)) return null;
  const { x, y, z } = input;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  return { x, y, z };
}

/** 供测试与调用方复用：确保摆放为拷贝（避免共享可变引用）。 */
export function copyPlacement(placement: ModelPlacement): ModelPlacement {
  return clonePlacement(placement);
}
