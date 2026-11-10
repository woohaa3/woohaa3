import { modelGroundAnchorLocal } from "../world-animation-spatial.js";
import { storedHumanoidRig } from "../humanoid-rig.js";
import { observeContentResolver, type ContentContributionResolver } from "../content-contribution.js";
import { builtinNodeCapabilityResolver } from "../builtin-node-capabilities.js";
import { decodeWorldInstanceData } from "../shared-world-codec.js";
import { decodeWorldCamera } from "../world-camera-codec.js";
import { cameraShotPresentation, worldCameraShotContext } from "../world-camera-shot.js";
import { quatMul } from "../model-transform.js";
import { sceneAreaAnimationOrigin, type GroundAabb, type GroundPoint, type SceneAreaData, type WorldPoint, type WorldRotation } from "../shared-world.js";
import { decodeSceneAreaData, decodeWorkflowGroupData } from "../creation-scope-codec.js";
import { executeWorldAnimationScript, sampleWorldAnimationInArea, type SampledCameraMotion, type SampledInstanceMotion, type WorldAnimationIr, type WorldAnimationScript } from "../world-animation-script.js";
import type { NodeCapabilityResolver } from "../node-capabilities.js";
/**
 * `CanvasRenderScene` 快照装配与呈现指纹（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 单一映射层：把 woohaa3 的 `ServerCanvas` + 瞬时 selection/hover/gesture + surface 转换为
 * **Bevy 运行时期望的快照结构**。画布已删除组与片场容器（change:
 * remove-canvas-groups-and-film-set），因此这里只投影普通节点卡片、幽灵节点与边。
 *
 * 热路径预算：`renderSceneFingerprint` 只覆盖可见标量与模型 `resourceKey/signature`，不遍历
 * mesh 顶点或序列化 ops。
 */
import {
  type CanvasNodeData,
  type ServerCanvas,
  type StoredAsset,
  type Woohaa3CanvasViewport
} from "../domain/index.js";
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "../model-script.js";
import type { SceneV2Op } from "../scene-ir-v2.js";
import { prepareModelResource, type PreparedModelResource } from "../prepared-model.js";
import { fnv1a64Hex } from "../content-hash.js";
import type { ModelFocusProjection } from "../model-focus.js";
import { defaultAppTheme, validateAppThemePreset, type AppThemeSnapshot } from "../../theme/index.js";
import { resolveNodeDisplayName, contentTypeLabelForNode } from "../node-display-name.js";
import {
  bevyKindForNodeType,
  bevyNodeSize,
  effectiveCanvasNodeSize,
} from "./node-geometry.js";
import {
  CANVAS_RENDER_SCENE_VERSION,
  type BevyAggregateConnect,
  type BevyAnimationPlayback,
  type BevyDragAttach,
  type BevyFocusTransition,
  type BevyHover,
  type BevyImageFocus,
  type BevyModelEditor,
  type BevyNodeActionsPresentation,
  type BevyRenderDraft,
  type BevyRenderMarquee,
  type BevyRenderNode,
  type BevyRenderSurface,
  type BevyVideoFocus,
  type CanvasRenderScene,
  type GhostRenderNode
} from "./wire-scene.js";
import {
  clampProgress,
  isBusy,
  readBody,
  resolveTextureKey
} from "./node-projection.js";

export type CanvasRenderSceneInput = {
  /** 扩展内容贡献。缺省时空解析器，不改变现有场景。 */
  content?: ContentContributionResolver;
  canvas: ServerCanvas;
  nodeCapabilities?: NodeCapabilityResolver;
  selection?: { nodes?: readonly string[]; edge?: string | null };
  draft?: BevyRenderDraft | null;
  /** 框选选区矩形（世界坐标）。 */
  marquee?: BevyRenderMarquee | null;
  surface?: BevyRenderSurface | null;
  /** 节点瞬时位置覆盖（拖拽预览），世界坐标。 */
  positionOverrides?: ReadonlyMap<string, { x: number; y: number }>;
  /** 节点瞬时尺寸覆盖（resize 预览），世界坐标 width/height（change: add-node-resize）。 */
  sizeOverrides?: ReadonlyMap<string, { width: number; height: number }>;
  viewportOverride?: Woohaa3CanvasViewport | null;
  /** 每节点的 V2 模型 Scene IR（change: enhance-model-scene-authoring-api）。 */
  modelScenesV2?: ReadonlyMap<string, SceneV2Op[]>;
  /**
   * 每节点的 prepared model resource（change: optimize-model-scene-snapshot-hot-path）。
   *
   * 优先于 `modelScenes` / `modelScenesV2`：controller 从 model-scene plugin 的 prepared
   * resource 读取，映射层不再遍历 mesh 顶点或序列化 ops。缺省（测试/最小 fixture）时回落到
   * 原始 ops 并在映射内一次性派生，保持旧调用可用。
   */
  modelResources?: ReadonlyMap<string, PreparedModelResource>;
  /** Transient ground displacement in meters; never applied to the canvas document. */
  worldGroundPreviews?: ReadonlyMap<string, { u: number; v: number }>;
  /**
   * Transient camera pose while the user drags a camera frustum. Presentation only:
   * the canonical `nodeData.worldCamera` is never rewritten here.
   */
  worldCameraPreviews?: ReadonlyMap<string, { position: WorldPoint; rotation: WorldRotation }>;
  /** 取景阶段（卡片 preview/ready/stale/failed）；由宿主状态轮询提供。 */
  worldCameraShotPhases?: ReadonlyMap<string, import("../world-camera-shot.js").WorldCameraShotPhase>;
  /**
   * Transient scene-area ground bounds keyed by area node id (move/resize preview).
   * Presentation only; the canonical `nodeData.sceneArea` is never rewritten here.
   */
  sceneAreaPreviews?: ReadonlyMap<string, import("../shared-world.js").GroundAabb>;
  /** 导演区整体动画播放头（秒）；缺省不采样。 */
  sceneAnimationTimes?: ReadonlyMap<string, number>;
  sceneAnimationPlayheads?: ReadonlyMap<string, number>;
  sceneAnimationPlayer?: { nodeId: string | null; playing: boolean };
  sceneAnimationLoop?: (nodeId: string) => boolean;
  /** 上传中的幽灵节点（只渲染，不进规范状态）；与真实节点同 id 时自动跳过。 */
  ghostNodes?: readonly GhostRenderNode[];
  /**
   * 当前主题 snapshot（change: unify-application-theme-tokens）。
   *
   * 由 Theme Service 传入，**不从 canonical canvas 推导**。缺省使用内置默认主题
   * （兼容测试/最小 fixture）；传入非法值会抛出，避免混合主题。
   */
  theme?: AppThemeSnapshot | unknown;
  /** 模型聚焦瞬时投影（change: add-model-focus-viewing）。 */
  modelFocus?: ModelFocusProjection | null;
  /** 图片聚焦瞬时投影（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。 */
  imageFocus?: BevyImageFocus | null;
  /** 视频聚焦瞬时投影（change: 2026-10-10-add-video-node-focus-workspace）。 */
  videoFocus?: BevyVideoFocus | null;
  /** 模型编辑 gizmo/镜头工具瞬时态（change: add-model-editor-gizmo-shot-capture）。 */
  modelEditor?: BevyModelEditor | null;
  /** 节点端点 / 连线悬停瞬时态（change: add-node-endpoint-hover / add-edge-hover-delete）。 */
  hover?: BevyHover | null;
  /** 单节点拖动中的 Q/E 触碰粘连瞬时投影（change: add-drag-touch-connections）。 */
  dragAttach?: BevyDragAttach | null;
  /** 多选聚合拉线瞬时投影（change: add-multi-select-aggregate-connect）。 */
  aggregateConnect?: BevyAggregateConnect | null;
  /** 活动动画节点播放瞬时投影（change: 2026-10-05-bind-model-animation-to-shots）。 */
  animationPlayback?: BevyAnimationPlayback | null;
  /** 公共聚焦过渡进度瞬时更新。 */
  focusTransition?: BevyFocusTransition | null;
  /**
   * 每节点的顶部操作横条呈现（change: 2026-10-13-add-node-to-film-set-shortcut）。
   *
   * 由 canvas-shell 贡献层计算后注入；横条由 Bevy 绘制、Rust 命中。
   */
  nodeActionToolbars?: ReadonlyMap<string, BevyNodeActionsPresentation>;
};

/**
 * 旧版模型卡片（缺少 `sharedWorldInstance` 的 `model3d`）只显示这段固定的诊断正文，
 * 不再执行模型脚本、生成资源、预览、统计或动作
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
export const LEGACY_MODEL_CARD_BODY = "旧版 3D 模型卡片已不再支持，删除后重新创建模型";

/** 校验并返回本帧使用的主题；非法输入直接抛错（不得部分降级）。 */
export function resolveSceneTheme(input: unknown): AppThemeSnapshot {
  const result = validateAppThemePreset(input ?? defaultAppTheme());
  if (!result.ok) {
    throw new Error(`非法 theme snapshot：${result.code} ${result.error}`);
  }
  return result.theme;
}

/** 构建 Bevy 快照。 */
/**
 * Area-move previews translate bounds; carry the animation origin by the same
 * delta. Resize previews change an edge, so the stable origin stays put.
 */
function animationOriginForPreview(area: SceneAreaData, preview: GroundAabb | undefined): GroundPoint {
  const origin = sceneAreaAnimationOrigin(area);
  if (!preview) return origin;
  const u = preview.min.u - area.bounds.min.u;
  const v = preview.min.v - area.bounds.min.v;
  const maxU = preview.max.u - area.bounds.max.u;
  const maxV = preview.max.v - area.bounds.max.v;
  if (Math.abs(u - maxU) > 1e-9 || Math.abs(v - maxV) > 1e-9) return origin;
  return { u: origin.u + u, v: origin.v + v };
}

export function buildCanvasRenderScene(input: CanvasRenderSceneInput): CanvasRenderScene {
  observeContentResolver(input.content);
  const { canvas } = input;
  const resolver = input.nodeCapabilities ?? builtinNodeCapabilityResolver;
  const capabilitiesOf = (node: ServerCanvas["document"]["nodes"][number]) => resolver.resolve({ canvas, node, data: canvas.nodeData[node.id] });
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const assets = new Map<string, StoredAsset>(canvas.assets.map((asset) => [asset.id, asset]));
  const selectedIds = new Set(input.selection?.nodes ?? []);

  // 导演区是 h=0 的地面范围，不是画布卡片：只通过 `sceneAreas` 投影，节点列表不再
  // 生成通用卡片。2D 组保留节点身份（命中/选择/动作）但以 `frame` chrome 绘制包围框。
  const sceneAreaNodeIds = new Set<string>();
  const sceneAreaOrdinals = new Map<string, number>();
  const animationSamples = new Map<string, SampledInstanceMotion>();
  const cameraAnimationSamples = new Map<string, SampledCameraMotion>();
  if (input.sceneAnimationTimes) {
    // The playing director retains its preview when selection is cleared.
    const priority = (id: string) => input.sceneAnimationPlayer?.playing && input.sceneAnimationPlayer.nodeId === id
      ? 2 : Number(selectedIds.has(id));
    const animationNodes = [...canvas.document.nodes].sort((a, b) => priority(a.id) - priority(b.id));
    for (const node of animationNodes) {
      const area = decodeSceneAreaData(nodeData[node.id]?.sceneArea);
      const script = area.ok ? area.value.animationScript : undefined;
      if (!area.ok || !script) continue;
      const ir = compiledWorldAnimation(script);
      if (!ir) continue;
      const sample = sampleWorldAnimationInArea(
        ir,
        input.sceneAnimationTimes.get(node.id) ?? 0,
        animationOriginForPreview(area.value, input.sceneAreaPreviews?.get(node.id))
      );
      for (const [instanceId, transform] of sample.instances) {
        const current = animationSamples.get(instanceId) ?? {};
        animationSamples.set(instanceId, { ...current, ...transform });
      }
      for (const [cameraId, motion] of sample.cameras) {
        const current = cameraAnimationSamples.get(cameraId) ?? {};
        cameraAnimationSamples.set(cameraId, { ...current, ...motion });
      }
    }
  }
  let sceneAreaCount = 0;
  for (const node of canvas.document.nodes) {
    if (decodeSceneAreaData(nodeData[node.id]?.sceneArea).ok) {
      sceneAreaCount += 1;
      sceneAreaOrdinals.set(node.id, sceneAreaCount);
    }
  }
  const nodes: BevyRenderNode[] = canvas.document.nodes.flatMap((node) => {
    const capabilities = capabilitiesOf(node);
    const kind = capabilities.appearance?.palette ?? "node";
    const size = effectiveCanvasNodeSize(node, input.sizeOverrides?.get(node.id), capabilities);
    const override = input.positionOverrides?.get(node.id);
    const data = nodeData[node.id];
    const cameraPreview = input.worldCameraPreviews?.get(node.id);
    const baseCameraInput = data?.worldCamera;
    const baseCamera = baseCameraInput === undefined ? undefined : decodeWorldCamera(baseCameraInput);
    const cameraMotion = baseCamera?.ok ? cameraAnimationSamples.get(baseCamera.value.cameraId) : undefined;
    const animatedCameraInput = baseCameraInput !== undefined && cameraMotion
      ? {
          ...(baseCameraInput as Record<string, unknown>),
          ...(cameraMotion.position ? { position: cameraMotion.position } : {}),
          ...(cameraMotion.rotation ? { rotation: cameraMotion.rotation } : {}),
          ...(cameraMotion.zoom !== undefined ? { projection: zoomedProjection((baseCameraInput as { projection: unknown }).projection, cameraMotion.zoom) } : {})
        }
      : baseCameraInput;
    // A direct gesture preview is the user's current intent and must win over the
    // sampled script; otherwise dragging an animated camera appears to do nothing.
    const cameraInput = animatedCameraInput !== undefined && cameraPreview
      ? {
          ...(animatedCameraInput as Record<string, unknown>),
          position: cameraPreview.position,
          rotation: cameraPreview.rotation
        }
      : animatedCameraInput;
    const camera = cameraInput === undefined ? undefined : decodeWorldCamera(cameraInput);
    if (camera && !camera.ok) throw new Error(`Invalid shared world camera: ${camera.code}`);
    const area = decodeSceneAreaData(data?.sceneArea);
    if (area.ok) {
      sceneAreaNodeIds.add(node.id);
      return [];
    }
    const workflowGroupInput = data?.workflowGroup2d;
    const workflowGroup = workflowGroupInput === undefined ? undefined : decodeWorkflowGroupData(workflowGroupInput);
    const worldInput = data?.sharedWorldInstance;
    const world = worldInput === undefined ? undefined : decodeWorldInstanceData(worldInput);
    if (world && !world.ok) throw new Error(`Invalid shared world instance: ${world.code}`);
    const groundPreview = input.worldGroundPreviews?.get(node.id);
    if (groundPreview && (!Number.isFinite(groundPreview.u) || !Number.isFinite(groundPreview.v))) {
      throw new Error("Invalid shared world ground preview");
    }
    const animated = world?.ok ? animationSamples.get(world.value.instanceId) : undefined;
    const baseTransform = world?.ok && animated ? {
      ...world.value.transform,
      ...(animated.position ? { position: animated.position } : {}),
      ...(animated.rotation ? { rotation: quatMul(world.value.transform.rotation as unknown as import("../model-transform.js").Quat, animated.rotation as unknown as import("../model-transform.js").Quat) as WorldRotation } : {}),
      ...(animated.scale !== undefined ? { scale: animated.scale } : {})
    } : world?.ok ? world.value.transform : undefined;
    const projectedWorld = world?.ok && baseTransform && (groundPreview || animated) ? {
      ...world.value,
      transform: { ...baseTransform, ...(groundPreview ? { position: {
        ...baseTransform.position,
        u: baseTransform.position.u + groundPreview.u,
        v: baseTransform.position.v + groundPreview.v
      } } : {}) }
    } : world?.ok ? world.value : undefined;
    if (projectedWorld && !decodeWorldInstanceData(projectedWorld).ok) throw new Error("Invalid shared world ground preview");
    const x = override ? override.x : node.position?.x ?? 0;
    const y = override ? override.y : node.position?.y ?? 0;
    const { width, height } = size;
    // 旧卡片模型（缺少 sharedWorldInstance）只投影为只读诊断卡片：不执行脚本、不生成资源。
    const legacyModelCard = node.type === "model3d" && !projectedWorld;
    const displayName = resolveNodeDisplayName({
      type: node.type,
      explicitName: data?.title,
      prompt: data?.prompt
    });
    const texture = resolveTextureKey(node.type, data, assets) !== null;
    const modelOpsV2 = input.modelScenesV2?.get(node.id);
    const preparedResource = input.modelResources?.get(node.id);
    const resource = capabilities.modelPreparation
      ? (preparedResource
        ?? (modelOpsV2
          ? prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: modelOpsV2 })
          : null))
      : null;
    const shotPresentation = camera?.ok
      ? cameraShotPresentation(
          worldCameraShotContext(canvas, camera.value),
          input.worldCameraShotPhases?.get(node.id)
        )
      : null;
    const rendered: BevyRenderNode = {
      id: node.id,
      type: kind,
      x,
      y,
      width,
      height,
      // 旧卡片模型不再执行脚本或生成预览：只显示固定诊断正文。
      body: legacyModelCard ? LEGACY_MODEL_CARD_BODY : readBody(node.type, data, assets),
      ...(camera?.ok ? { worldCamera: camera.value } : {}),
      ...(shotPresentation ? { cameraShot: shotPresentation } : {}),
      title: displayName.displayName,
      // 动态镜头的次标题直接承载视频语义：预览/就绪/过期/失败 + 动画时长。
      typeLabel: shotPresentation && shotPresentation.kind === "dynamic" && shotPresentation.label !== ""
        ? shotPresentation.label
        : displayName.contentTypeLabel,
      progress: legacyModelCard ? 0 : clampProgress(data?.progress),
      busy: legacyModelCard ? false : isBusy(data),
      texture,
      // 仅当该节点是唯一选中项时才绘制抓手，避免多选时语义歧义（design D1）。
      // 共享世界实例没有卡片尺寸抓手：模型缩放走世界变换/助手，不是卡片 resize。
      resizable: !projectedWorld && !!capabilities.resize && selectedIds.size === 1 && selectedIds.has(node.id),
      ...(projectedWorld ? {
        sharedWorldInstance: projectedWorld,
        chrome: { kind: "none" as const }
      } : {}),
      ...(workflowGroup?.ok ? {
        chrome: {
          kind: "frame" as const,
          groupId: workflowGroup.value.groupId,
          memberNodeIds: [...workflowGroup.value.memberNodeIds]
        }
      } : {}),
      ...(capabilities.appearance?.cardLabel ? { cardLabel: capabilities.appearance.cardLabel } : {})
    };
    if (capabilities.modelPreparation && resource) {
      const storedRig = data?.modelRig == null ? null : storedHumanoidRig(data.modelRig);
      const groundAnchorLocal = projectedWorld ? modelGroundAnchorLocal(resource.ops, storedRig?.ok ? storedRig.value : null) : null;
      rendered.model = {
        ...(groundAnchorLocal ? { groundAnchorLocal } : {}),
        sceneVersion: resource.sceneVersion,
        resourceKey: resource.resourceKey,
        signature: resource.signature,
        ...(animated?.partRotations ? { partRotations: animated.partRotations } : {})
      };
    }
    return [rendered];
  });

  // 幽灵节点（上传中）：追加为普通 Bevy 节点，复用完全相同的卡片绘制。
  // 同 id 的真实节点已存在时跳过（working projection 接管，避免重复绘制）。
  const realIds = new Set(canvas.document.nodes.map((node) => node.id));
  for (const ghost of input.ghostNodes ?? []) {
    if (realIds.has(ghost.id)) continue;
    const kind = bevyKindForNodeType(ghost.nodeType);
    const size = bevyNodeSize(kind);
    nodes.push({
      id: ghost.id,
      type: kind,
      x: ghost.x,
      y: ghost.y,
      width: size.width,
      height: size.height,
      body: ghost.label ?? "",
      title: ghost.label ?? "",
      typeLabel: contentTypeLabelForNode(ghost.nodeType),
      progress: clampProgress(ghost.progress),
      // busy=true 驱动进度环；节点卡片不显示任何状态文案。
      busy: true,
      texture: ghost.texture === true,
      resizable: false,
      ghost: true
    });
  }

  // 纯模型扩展节点没有连线端点：映射层防御性过滤，避免异常帧绘制非法连线
  // （change: 2026-10-08-make-film-set-model-only；change: 2026-10-10 泛化）。
  const endpointlessNodeIds = new Set(
    canvas.document.nodes.filter((node) => capabilitiesOf(node).connections?.endpoints({ canvas, node, data: nodeData[node.id] }) === "none").map((node) => node.id)
  );
  // 导演区节点不出现在节点列表里；指向它的旧连线不能留下悬空端点。
  for (const nodeId of sceneAreaNodeIds) endpointlessNodeIds.add(nodeId);
  const edges = canvas.document.edges
    .filter((edge) => !endpointlessNodeIds.has(edge.source) && !endpointlessNodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: typeof edge.data?.label === "string" ? edge.data.label : ""
    }));

  return {
    version: CANVAS_RENDER_SCENE_VERSION,
    canvasId: canvas.id,
    revision: canvas.revision,
    nodes,
    sceneAreas: canvas.document.nodes.flatMap(node => {
      const area = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
      if (!area.ok) return [];
      const data = canvas.nodeData[node.id] as { title?: unknown } | undefined;
      const resolved = resolveNodeDisplayName({ type: node.type, explicitName: data?.title });
      const title = resolved.nameSource === "default"
        ? `导演区 ${sceneAreaOrdinals.get(node.id) ?? 1}`
        : resolved.displayName;
      const preview = input.sceneAreaPreviews?.get(node.id);
      const script = area.value.animationScript;
      const playback = script && script.duration > 0 ? {
        time: Math.max(0, Math.min(script.duration, (input.sceneAnimationPlayheads ?? input.sceneAnimationTimes)?.get(node.id) ?? 0)),
        duration: script.duration,
        playing: input.sceneAnimationPlayer?.nodeId === node.id && input.sceneAnimationPlayer.playing,
        loop: input.sceneAnimationLoop?.(node.id) ?? script.loop
      } : undefined;
      if (!preview) return [{ nodeId: node.id, title, bounds: area.value.bounds, ...(playback ? { playback } : {}) }];
      if (![preview.min.u, preview.min.v, preview.max.u, preview.max.v].every(Number.isFinite)
        || preview.min.u > preview.max.u || preview.min.v > preview.max.v) {
        throw new Error("Invalid scene area bounds preview");
      }
      return [{ nodeId: node.id, title, bounds: { min: { ...preview.min }, max: { ...preview.max } }, ...(playback ? { playback } : {}) }];
    }),
    edges,
    selection: {
      nodes: [...(input.selection?.nodes ?? [])],
      edge: input.selection?.edge ?? null
    },
    viewport: input.viewportOverride ?? { x: 0, y: 0, zoom: 1 },
    draft: input.draft ?? null,
    surface: input.surface ?? null,
    theme: resolveSceneTheme(input.theme),
    ...(input.marquee ? { marquee: input.marquee } : {}),
    ...(input.modelFocus ? { modelFocus: input.modelFocus } : {}),
    ...(input.imageFocus ? { imageFocus: input.imageFocus } : {}),
    ...(input.videoFocus ? { videoFocus: input.videoFocus } : {}),
    ...(input.modelEditor ? { modelEditor: input.modelEditor } : {}),
    ...(input.hover ? { hover: input.hover } : {}),
    ...(input.dragAttach ? { dragAttach: input.dragAttach } : {}),
    ...(input.aggregateConnect ? { aggregateConnect: input.aggregateConnect } : {}),
    ...(input.animationPlayback ? { animationPlayback: input.animationPlayback } : {}),
    ...(input.focusTransition ? { focusTransition: input.focusTransition } : {}),
    ...(input.nodeActionToolbars && input.nodeActionToolbars.size > 0
      ? { nodeActions: Object.fromEntries([...input.nodeActionToolbars].filter(([, value]) => value.actions.length > 0)) }
      : {})
  };
}

/**
 * 只比较影响绘制的字段；任务内部字段变化不产生新快照
 * （change: optimize-model-scene-snapshot-hot-path）。
 *
 * 快照已不再内联模型 `ops`：`fingerprint` 由可见标量、轻量节点/边字段及模型
 * `resourceKey/signature` 构成，比较成本不随模型顶点/面/字节数增长。这里保留 JSON 比较
 * 作为契约层兜底（用于测试与最小 fixture）；热路径由 controller 的 fingerprint 短路。
 */
export function renderSceneEquals(left: CanvasRenderScene | null, right: CanvasRenderScene | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 稳定呈现 fingerprint（change: optimize-model-scene-snapshot-hot-path，design D4）。
 *
 * 只覆盖**可见**字段：节点/边的轻量标量与模型 `resourceKey/signature`（不含 ops / payload /
 * 媒体字节），因此成本独立于模型顶点/面数。controller 用它替代逐帧全场景 `JSON.stringify`
 * 深比较。
 *
 * 使用结构化字段编码 + FNV-1a 64-bit；节点/模型内容变化必然改变输入文本。为排除短 hash
 * 碰撞导致的漏帧，`renderSceneEquals` 仍作为契约层兜底。
 */
export function renderSceneFingerprint(scene: CanvasRenderScene): string {
  const parts: string[] = [
    scene.version,
    `cameraEdit=${JSON.stringify(scene.worldCameraEdit ?? null)}`,
    `rev=${scene.revision}`,
    `sel=${scene.selection.nodes.join(",")}|${scene.selection.edge ?? ""}`,
    JSON.stringify(scene.sceneAreas ?? []),
    JSON.stringify(scene.executingScopes ?? []),
    `vp=${scene.viewport.x},${scene.viewport.y},${scene.viewport.zoom}`,
    `theme=${scene.theme.fingerprint}`,
    `globalLight=${scene.globalLightEnabled ?? true}`,
    scene.draft ? `draft=${scene.draft.source},${scene.draft.side},${scene.draft.x},${scene.draft.y}` : "draft=",
    scene.marquee
      ? `marquee=${scene.marquee.x},${scene.marquee.y},${scene.marquee.width},${scene.marquee.height}`
      : "marquee=",
    scene.surface ? `surf=${scene.surface.width},${scene.surface.height},${scene.surface.pixelRatio},${scene.surface.contentRight ?? 0},${JSON.stringify(scene.surface.contentRect ?? null)},${scene.surface.originX ?? 0},${scene.surface.originY ?? 0}` : "surf=",
    JSON.stringify(scene.modelFocusContext ?? null),
    scene.modelFocus
      ? `focus=${scene.modelFocus.nodeId},${scene.modelFocus.yaw},${scene.modelFocus.pitch},${scene.modelFocus.distance},${scene.modelFocus.radius},${scene.modelFocus.target.join(",")}`
      : "focus=",
    scene.imageFocus
      ? `ifocus=${scene.imageFocus.nodeId},${scene.imageFocus.viewport.x},${scene.imageFocus.viewport.y},${scene.imageFocus.viewport.zoom},${scene.imageFocus.sourceWidth}x${scene.imageFocus.sourceHeight},${scene.imageFocus.presentationReady ?? true},${JSON.stringify(scene.imageFocus.documentView ?? null)}`
      : "ifocus=",
    scene.videoFocus
      ? `vfocus=${scene.videoFocus.nodeId},${scene.videoFocus.viewport.x},${scene.videoFocus.viewport.y},${scene.videoFocus.viewport.zoom},${scene.videoFocus.sourceWidth}x${scene.videoFocus.sourceHeight}`
      : "vfocus=",
    scene.modelEditor ? `editor=${JSON.stringify(scene.modelEditor)}` : "editor=",
    `hoverCursor=${scene.hover?.cursor?.x ?? ""},${scene.hover?.cursor?.y ?? ""}`,
    scene.hover
      ? "nodeId" in scene.hover
        ? `hover=n:${scene.hover.nodeId}:${scene.hover.port ?? ""}`
        : `hover=e:${(scene.hover as { edgeId: string }).edgeId}`
      : "hover=",
    scene.dragAttach
      ? `attach=${scene.dragAttach.nodeId},${scene.dragAttach.mode ?? ""},${scene.dragAttach.contactNodeId ?? ""},${scene.dragAttach.pendingEdges
          .map((edge) => `${edge.id}:${edge.source}>${edge.target}`)
          .join(";")}`
      : "attach=",
    scene.aggregateConnect
      ? `agg=${scene.aggregateConnect.direction ?? ""},${scene.aggregateConnect.cursor ? `${scene.aggregateConnect.cursor.x},${scene.aggregateConnect.cursor.y}` : ""},${scene.aggregateConnect.pendingEdges
          .map((edge) => `${edge.id}:${edge.source}>${edge.target}`)
          .join(";")}`
      : "agg=",
    scene.animationPlayback
      ? `motion=${scene.animationPlayback.nodeId},${scene.animationPlayback.time},${scene.animationPlayback.duration},${scene.animationPlayback.playing ? 1 : 0},${scene.animationPlayback.looped ? 1 : 0}`
      : "motion=",
    scene.focusTransition
      ? `ftrans=${scene.focusTransition.nodeId},${scene.focusTransition.kind},${scene.focusTransition.progress},${scene.focusTransition.runtimeGeneration},${scene.focusTransition.transitionId}`
      : "ftrans=",
    scene.nodeActions
      ? `na=${Object.entries(scene.nodeActions).map(([id, value]) => `${id}:${value.actions.map((action) => `${action.id}:${action.label}:${action.enabled ? 1 : 0}:${action.menu ? 1 : 0}:${action.tone ?? "neutral"}:${action.icon ?? ""}:${action.iconOnly ? 1 : 0}`).join("|")}@${value.summary ?? ""}`).join(";")}`
      : "na="
  ];
  for (const node of scene.nodes) {
    parts.push(`n=${stablePresentationStringify(node)}`);
  }
  for (const edge of scene.edges) {
    parts.push(`e=${edge.id},${edge.source},${edge.target},${edge.label}`);
  }
  return fnv1a64Hex(parts.join("\n"));
}

// 类型再导出：保持 `scene-builder` 作为装配入口时的自解释性。
export type { CanvasRenderScene };

/** Stable JSON for the complete lightweight wire projection, never prepared payloads. */
export function stablePresentationStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
}

/** 编译缓存：同一动画脚本只在源码/时长/循环变化时重新执行。 */
const worldAnimationCache = new Map<string, WorldAnimationIr | null>();

function compiledWorldAnimation(script: WorldAnimationScript): WorldAnimationIr | null {
  const key = `${script.sourceHash}:${script.scriptVersion}:${script.duration}:${script.loop ? 1 : 0}`;
  if (worldAnimationCache.has(key)) return worldAnimationCache.get(key)!;
  const result = executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop });
  const ir = result.ok ? result.ir : null;
  if (worldAnimationCache.size >= 64) {
    const first = worldAnimationCache.keys().next().value;
    if (first !== undefined) worldAnimationCache.delete(first);
  }
  worldAnimationCache.set(key, ir);
  return ir;
}

function zoomedProjection(projection: unknown, zoom: number): unknown {
  const p = projection as { kind?: string; verticalFovRadians?: number; verticalSizeMeters?: number };
  if (p?.kind === "perspective" && typeof p.verticalFovRadians === "number") {
    return { ...p, verticalFovRadians: Math.max(0.01, Math.min(Math.PI * 0.9, p.verticalFovRadians * zoom)) };
  }
  if (p?.kind === "isometric" && typeof p.verticalSizeMeters === "number") {
    return { ...p, verticalSizeMeters: Math.max(0.01, p.verticalSizeMeters * zoom) };
  }
  return projection;
}
