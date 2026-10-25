/**
 * 三维模型 / 动画节点快照的创建、导入与版本推进
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 2.1–2.4）。
 *
 * 创建动画时**复制快照**：读取用户选定的模型版本，把源码、语言、API 版本与摆放复制到新节点，
 * 生成初始镜头、运动脚本与时间线，并把运动的适配版本设为新节点自己的模型内容版本。保存后
 * 播放/截图/历史/导出都只读取动画节点自身数据；`origin` 只作说明（design「创建和导入是复制
 * 快照」）。
 *
 * 本模块纯函数、JSON-only：不写 Store / Y.Doc / nodeData；实际提交由调用方经语义命令完成。
 */
import {
  DEFAULT_MODEL_PLACEMENT,
  deriveModelContentVersion,
  clonePlacement,
  modelSourceHash,
  type ModelContentVersion,
  type ModelPlacement
} from "./model-definition.js";
import {
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  basedOnModel,
  hashMotionScript,
  type MotionDefinition
} from "./motion-script.js";
import {
  cloneInitialCamera,
  decodeFilmSetNodeData,
  decodeModel3DNodeData,
  FILM_SET_NODE_TYPE,
  type FilmSetNodeData,
  type AnimationTimeline,
  type InitialShotCamera,
  type Model3DNodeData,
  type ModelImportOrigin
} from "./canvas-node-model.js";
import { filmSetAnimationsHash, emptyFilmSetAnimations, FILM_SET_ANIMATIONS_VERSION, staticShotCameraMotion, type FilmSetAnimations } from "./film-set-animations.js";
import { canonicalFilmSetFields, filmSetAnimationsOf } from "./film-set-clip-view.js";
import { DEFAULT_MODEL_CAMERA_ASPECT } from "./model-cameras.js";
import { shotFitDistance } from "./shot-camera.js";
import { MODEL_SCRIPT_LANGUAGE, type SupportedModelScriptVersion } from "./model-script.js";
import type { Aabb } from "./model-transform.js";
import {
  cloneFilmSetContent,
  cloneFilmSetLocalTransform,
  DEFAULT_FILM_SET_LOCAL_TRANSFORM,
  emptyFilmSetContent,
  filmSetContentHash,
  FILM_SET_CONTENT_VERSION,
  type FilmSetContent,
  type FilmSetLocalTransform
} from "./film-set-content.js";

/** 模型源码来源（模型节点或动画节点复制时读取的完整定义）。 */
export type ModelSnapshotInput = {
  modelScript: string;
  modelScriptLanguage?: typeof MODEL_SCRIPT_LANGUAGE;
  modelScriptVersion: SupportedModelScriptVersion;
  placement?: ModelPlacement;
};

export type ModelSnapshot = {
  modelScript: string;
  modelScriptLanguage: typeof MODEL_SCRIPT_LANGUAGE;
  modelScriptVersion: SupportedModelScriptVersion;
  contentVersion: ModelContentVersion;
  placement: ModelPlacement;
};

/**
 * 由源码、语言、版本与摆放派生**新模型快照**。
 *
 * `revision` 由调用方给出（新建副本从 1 开始）；这里只派生 sourceHash / contentHash。
 */
export function createModelSnapshot(input: ModelSnapshotInput & { revision?: number }): ModelSnapshot {
  const placement = input.placement ? clonePlacement(input.placement) : clonePlacement(DEFAULT_MODEL_PLACEMENT);
  const contentVersion = deriveModelContentVersion({
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion,
    placement,
    revision: input.revision ?? 1
  });
  return {
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion,
    contentVersion,
    placement
  };
}

/**
 * 内容变更时推进本地模型 revision：内容标识不变则保持原 revision（同请求重试/无净变化不推进）。
 */
export function advanceModelRevision(
  previous: ModelContentVersion | null,
  nextContentHash: string
): number {
  if (previous && previous.contentHash === nextContentHash) return previous.revision;
  return (previous?.revision ?? 0) + 1;
}

/** 运动快照创建输入。 */
export type MotionSnapshotInput = {
  motionScript: string;
  /** 本节点模型内容版本（作为适配版本）；省略时以零值占位，调用方须随后设置。 */
  basedOnModelVersion: ModelContentVersion;
  revision?: number;
};

/** 由运动源码派生新的 `MotionDefinition`。 */
export function createMotionSnapshot(input: MotionSnapshotInput): MotionDefinition {
  return {
    motionScript: input.motionScript,
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: input.revision ?? 1,
    sourceHash: hashMotionScript(input.motionScript),
    basedOnModelVersion: basedOnModel(input.basedOnModelVersion)
  };
}

/** 运动源码变化时推进 revision；相同源码不推进。 */
export function advanceMotionRevision(previous: MotionDefinition | null, nextSource: string): number {
  const nextHash = hashMotionScript(nextSource);
  if (previous && previous.sourceHash === nextHash) return previous.revision;
  return (previous?.revision ?? 0) + 1;
}

/**
 * 默认初始镜头：方位 0、仰角 45°、`16:9`、零注视点偏移。
 *
 * `distance` 优先按模型包围球半径自动取景；无 AABB 时使用与内容无关的稳定回退（半径 1 的
 * fit distance），保证同一内容在不同视口下派生相同默认构图（design「保存镜头构图 SHALL 独立
 * 于普通画布 viewport」）。
 */
export function defaultInitialShotCamera(aabb?: Aabb | null): InitialShotCamera {
  const radius = aabb ? boundingRadius(aabb) : 1;
  return {
    azimuth: 0,
    elevation: Math.PI / 4,
    distance: shotFitDistance(radius),
    aspect: DEFAULT_MODEL_CAMERA_ASPECT,
    focusOffset: { x: 0, y: 0, z: 0 }
  };
}

/** 创建完整片场节点数据（items-only，change D7/D8/D10）。 */
export type CreateAnimationSnapshotInput = {
  title: string;
  /**
   * 可选来源模型快照；提供时创建为片场**唯一 model item**（items-only，D8）。
   * 不再作为顶层 authored 模型。
   */
  model?: ModelSnapshotInput;
  /** 已派生完整快照；优先于 `model`（调用方已计算 contentVersion 时使用）。 */
  modelSnapshot?: ModelSnapshot;
  /** model item 的稳定 id；缺省 `"model"`。 */
  modelItemId?: string;
  modelItemName?: string;
  /** model item 的来源说明（不参与内容身份）。 */
  origin?: ModelImportOrigin;
  /** 可选对象动作脚本：非空时作为该 model item 的 binding（对象动作仅 binding，D10）。 */
  motionScript?: string;
  timeline: AnimationTimeline;
  /** 可选初始镜头；缺失时按 aabb 派生默认镜头。 */
  initialCamera?: InitialShotCamera;
  aabb?: Aabb | null;
  /** 显式内容；缺失时新建片场保持空 items。 */
  filmSetContent?: FilmSetContent;
  /** D7 独立片场根；缺失即单位变换。 */
  scenePlacement?: FilmSetLocalTransform;
};

/**
 * 创建完整片场节点数据（items-only）。
 *
 * - 全部几何来自 items；提供了 `model` 时创建为普通 model item（可选择/编辑/绑定/删除）；
 * - `motionScript` 作为该 item 的 binding 动作并建立到自身内容的适配关联；
 * - 无来源模型时保持空内容（删除最后对象不补内容）；
 * - 不生成顶层 authored 模型/动作/镜头字段；初始镜头进入 `camera` 运行时视图（片段为空时）。
 */
export function createFilmSetSnapshot(input: CreateAnimationSnapshotInput): FilmSetNodeData {
  const scenePlacement = input.scenePlacement
    ? cloneFilmSetLocalTransform(input.scenePlacement)
    : cloneFilmSetLocalTransform(DEFAULT_FILM_SET_LOCAL_TRANSFORM);
  const base = input.filmSetContent ? cloneFilmSetContent(input.filmSetContent) : emptyFilmSetContent();
  const items = [...base.items];
  const camera = input.initialCamera
    ? cloneInitialCamera(input.initialCamera)
    : defaultInitialShotCamera(input.aabb ?? null);

  const snapshot = input.modelSnapshot
    ?? (input.model ? createModelSnapshot({ ...input.model, revision: 1 }) : null);

  let filmSetAnimations = emptyFilmSetAnimations();
  if (snapshot) {
    const itemId = input.modelItemId ?? "model";
    const item = {
      id: itemId,
      kind: "model" as const,
      name: input.modelItemName ?? input.title,
      localTransform: cloneFilmSetLocalTransform(DEFAULT_FILM_SET_LOCAL_TRANSFORM),
      model: snapshot,
      ...(input.origin ? { origin: { ...input.origin } } : {})
    };
    items.push(item);
    const script = (input.motionScript ?? "").trim();
    if (script !== "") {
      // 携带对象动作的来源必然是动态拍摄镜头：强制正时长，避免与静态不变式冲突。
      const clipDuration = input.timeline.duration > 0 ? input.timeline.duration : 1;
      const playback = { startTime: 0, duration: clipDuration, timeScale: 1, loop: input.timeline.loop };
      const binding = {
        itemId,
        playback,
        motion: {
          motionScript: script,
          motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
          motionScriptVersion: MOTION_SCRIPT_VERSION,
          revision: 1,
          sourceHash: hashMotionScript(script),
          basedOnModelVersion: basedOnModel(snapshot.contentVersion)
        }
      };
      filmSetAnimations = {
        schemaVersion: FILM_SET_ANIMATIONS_VERSION,
        defaultClipId: "clip-1",
        clips: [{
          id: "clip-1",
          name: "动态拍摄镜头",
          kind: "dynamic",
          timeline: { duration: clipDuration, loop: input.timeline.loop },
          initialCamera: cloneInitialCamera(camera),
          cameraMotion: emptyCameraMotion(),
          bindings: [binding]
        }]
      };
    }
  }

  return {
    kind: FILM_SET_NODE_TYPE,
    title: input.title,
    scenePlacement,
    sceneCamera: cloneInitialCamera(camera),
    camera,
    timeline: { duration: input.timeline.duration, loop: input.timeline.loop },
    filmSetContent: { schemaVersion: FILM_SET_CONTENT_VERSION, items },
    filmSetAnimations,
    ...(input.origin ? { origin: input.origin } : {})
  };
}

/** 空（静态）拍摄镜头定义：完整 `MotionDefinition`，但脚本为空。 */
function emptyCameraMotion(): MotionDefinition {
  return staticShotCameraMotion();
}

/** 直接创建自包含模型节点数据（不建立来源连线）。 */
export function createModel3DNodeData(input: {
  title: string;
  model: ModelSnapshotInput;
  revision?: number;
}): Model3DNodeData {
  return {
    kind: "model3d",
    title: input.title,
    model: createModelSnapshot({ ...input.model, revision: input.revision ?? 1 })
  };
}

/**
 * 替换**指定 model item** 的模型快照，保留该 item 的 binding 动作及其旧适配版本。
 *
 * `revision` 省略时按内容变化推进该 item 的模型版本（内容标识不变则保持原 revision）。
 */
export function importModelSnapshot(
  animation: FilmSetNodeData,
  itemId: string,
  model: ModelSnapshotInput,
  options: { revision?: number } = {}
): FilmSetNodeData {
  const placement = model.placement ? clonePlacement(model.placement) : clonePlacement(DEFAULT_MODEL_PLACEMENT);
  const contentHash = deriveModelContentVersion({
    modelScript: model.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: model.modelScriptVersion,
    placement,
    revision: 1
  }).contentHash;
  const items = animation.filmSetContent.items.map(item => {
    if (item.id !== itemId || item.kind !== "model") return item;
    const revision = options.revision ?? advanceModelRevision(item.model.contentVersion, contentHash);
    const nextModel = createModelSnapshot({ ...model, revision });
    return { ...item, model: nextModel };
  });
  return { ...animation, filmSetContent: { ...animation.filmSetContent, items } };
}

/**
 * 把结构化片场节点数据序列化为规范 flat nodeData 字段（items-only，D7/D8/D10）。
 *
 * 只写 `extensionId` / `title` / `scenePlacement` / `filmSetContent` / `filmSetAnimations` / origin；
 * **不写**任何顶层模型/动作/镜头/时间线字段。
 */
export function filmSetNodeDataFields(animation: FilmSetNodeData): Record<string, unknown> {
  return canonicalFilmSetFields(animation);
}

/** 把结构化模型节点数据序列化为 flat nodeData 字段。 */
export function model3DNodeDataFields(model: Model3DNodeData): Record<string, unknown> {
  return {
    title: model.title,
    modelScript: model.model.modelScript,
    modelScriptLanguage: model.model.modelScriptLanguage,
    modelScriptVersion: model.model.modelScriptVersion,
    modelContentVersion: model.model.contentVersion,
    modelPlacement: model.model.placement
  };
}

/**
 * 快照 hash：片场完整可恢复状态的内容标识（design「编辑与保存规则」）。
 *
 * 覆盖独立根、items-only 内容与全部片段（含镜头通道、binding 动作/适配/播放）；不含
 * selection/preview 等瞬态，也不计算任何顶层模型。
 */
export function animationSnapshotHash(animation: FilmSetNodeData): string {
  return hashMotionScript(JSON.stringify({
    scenePlacement: filmSetScenePlacementIdentity(animation.scenePlacement),
    sceneCamera: filmSetCameraIdentity(animation.sceneCamera),
    content: filmSetContentHash(animation.filmSetContent),
    animations: filmSetAnimationsHash(filmSetAnimationsOf(animation))
  }));
}

function filmSetScenePlacementIdentity(placement: FilmSetNodeData["scenePlacement"]): unknown {
  return [placement.offset.x, placement.offset.y, placement.offset.z, placement.scale, placement.yaw];
}

/** 规范静态镜头的内容身份（不暴露运行时 `camera` 派生视图）。 */
function filmSetCameraIdentity(camera: InitialShotCamera): unknown {
  return [camera.azimuth, camera.elevation, camera.distance, camera.aspect, camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z];
}

/**
 * 由**已保存的片场定义**计算同一快照 hash（隔离离线迁移与历史共用此结果）。
 * 缺失 `filmSetContent` 的旧记录按空集合处理。
 */
export function animationDefinitionSnapshotHash(input: {
  scenePlacement?: FilmSetNodeData["scenePlacement"];
  sceneCamera?: InitialShotCamera;
  filmSetContent?: FilmSetContent | null;
  filmSetAnimations?: FilmSetAnimations | null;
}): string {
  return hashMotionScript(JSON.stringify({
    scenePlacement: input.scenePlacement ? filmSetScenePlacementIdentity(input.scenePlacement) : null,
    sceneCamera: input.sceneCamera ? filmSetCameraIdentity(input.sceneCamera) : null,
    content: filmSetContentHash(input.filmSetContent ?? emptyFilmSetContent()),
    animations: filmSetAnimationsHash(filmSetAnimationsOf({ filmSetAnimations: input.filmSetAnimations ?? undefined }))
  }));
}

/** 从已保存的 flat nodeData 读取片场节点（不完整时返回 null）。 */
export function readStoredAnimation(nodeData: unknown): FilmSetNodeData | null {
  const decoded = decodeFilmSetNodeData(nodeData);
  return decoded.ok ? decoded.value : null;
}
/** 从已保存的 flat nodeData 读取模型节点（不完整时返回 null）。 */
export function readStoredModel(nodeData: unknown): Model3DNodeData | null {
  const decoded = decodeModel3DNodeData(nodeData);
  return decoded.ok ? decoded.value : null;
}

/** 模型源码内容标识（供调用方做并发 precondition）。 */
export function modelSnapshotSourceHash(model: ModelSnapshot): string {
  return modelSourceHash(model.modelScript);
}

/**
 * 截帧输出记录的实际片场版本（design「播放和截图只使用本节点」）。
 *
 * items-only：不再有单一顶层模型/动作，改记录片场内容标识、片段集合标识、默认片段镜头与时间线。
 */
export type AnimationCaptureMetadata = {
  contentHash: string;
  animationsHash: string;
  timeline: AnimationTimeline;
  initialCamera: InitialShotCamera;
  /** 指定截帧时间（秒）。 */
  timeSeconds: number;
  /** 本节点完整内容标识（独立根 + items + 完整片段）。 */
  snapshotHash: string;
};

export function animationCaptureMetadata(
  animation: FilmSetNodeData,
  timeSeconds: number
): AnimationCaptureMetadata {
  return {
    contentHash: filmSetContentHash(animation.filmSetContent),
    animationsHash: filmSetAnimationsHash(filmSetAnimationsOf(animation)),
    timeline: { ...animation.timeline },
    initialCamera: cloneInitialCamera(animation.camera),
    timeSeconds: Number.isFinite(timeSeconds) ? timeSeconds : 0,
    snapshotHash: animationSnapshotHash(animation)
  };
}

function boundingRadius(aabb: Aabb): number {
  const values = [...aabb.min, ...aabb.max];
  if (!values.every((value) => Number.isFinite(value))) return 1;
  const dx = aabb.max[0] - aabb.min[0];
  const dy = aabb.max[1] - aabb.min[1];
  const dz = aabb.max[2] - aabb.min[2];
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
  return radius > 1e-4 && Number.isFinite(radius) ? radius : 1;
}
