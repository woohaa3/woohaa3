import { observeContentResolver, type ContentContributionResolver } from "../content-contribution.js";
import { builtinNodeCapabilityResolver } from "../builtin-node-capabilities.js";
import type { NodeCapabilityResolver } from "../node-capabilities.js";
/**
 * `CanvasRenderScene` 快照装配与呈现指纹（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 单一映射层：把 woohaa3 的 `ServerCanvas` + 瞬时 selection/hover/gesture + surface 转换为
 * **Bevy 运行时期望的快照结构**。节点/边/交互与片场对象 motion/editor/media 投影复用独立叶子
 * 模块；本模块只做编排与产出，不复制几何公式。
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
import { encodeFilmSetPartId, readFilmSetContent } from "../film-set-content.js";
import type { ModelFocusProjection } from "../model-focus.js";
import { getGroupLayoutSizes } from "../domain/core/group-geometry.js";
import { groupAppearanceModel } from "../group-appearance.js";
import { hiddenByCollapsedGroups } from "../group-presentation.js";
import { clampGroupBadgeScale } from "../group-badge.js";
import { canvasGroundAnchor, compareCanvasGroundOrder } from "../ground-anchor.js";
import { defaultAppTheme, validateAppThemePreset, type AppThemeSnapshot } from "../../theme/index.js";
import { resolveNodeDisplayName, contentTypeLabelForNode } from "../node-display-name.js";
import {
  bevyKindForNodeType,
  bevyNodeSize,
  effectiveCanvasNodeSize,
} from "./node-geometry.js";
import {
  type BevyModelPlacement
} from "./wire-model.js";
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
  type BevyShotPreviewLink,
  type BevyVideoFocus,
  type CanvasRenderScene,
  type CompositeAssetScopeShape,
  type GhostRenderNode
} from "./wire-scene.js";
import {
  EMPTY_PLANE_IDS,
  compositeAssetScopeForNode,
  pureModelFit
} from "./film-set-projection.js";
import {
  clampProgress,
  isBusy,
  readBody,
  readPlacement,
  resolveTextureKey
} from "./node-projection.js";
import { shotPreviewCardPresentation, shotPreviewCardPresentationForFilmSetGroup, shotPreviewLinksForFilmSet, shotPreviewLinksForFilmSetGroup } from "./shot-preview-projection.js";
import { managedShotPreviewOwnershipOf, shotPreviewOwnershipOf } from "../film-set-shot-preview.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import type { FilmSetNodeData } from "../canvas-node-model.js";
import { activeFilmSetSceneBindings, prepareFilmSetGroup, readFilmSetGroupMarker } from "../film-set-group.js";
import { FILM_SET_GROUP_RENDER_SCHEMA_VERSION, type BevyFilmSetGroupPreparation, type BevyFilmSetGroupBinding } from "./wire-scene.js";

export type CanvasRenderSceneInput = {
  /** 扩展内容贡献。缺省时空解析器，不改变现有场景。 */
  content?: ContentContributionResolver;
  groupBadgeScaleOverrides?: ReadonlyMap<string, number>;
  /** Group ids carrying a render-only drop target highlight. */
  dropTargetGroupIds?: ReadonlySet<string> | readonly string[];
  groupBadgeResizable?: boolean;
  canvas: ServerCanvas;
  nodeCapabilities?: NodeCapabilityResolver;
  modelPreviews?: ReadonlyMap<string, import("./wire-model.js").BevyModelPreview>;
  selection?: { nodes?: readonly string[]; edge?: string | null };
  draft?: BevyRenderDraft | null;
  /** 框选选区矩形（世界坐标，change: fix-group-and-marquee-preview）。 */
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
  /** 模型 placement（来自 DOM 参数面板的瞬时/规范 nodeData）。 */
  modelPlacements?: ReadonlyMap<string, BevyModelPlacement>;
  /**
   * 已上传纹理的片场媒体平面 id 集合（change: 2026-10-08-make-film-set-model-only）。
   *
   * 平面几何由 `filmSetContent` 派生；此集合只标记哪些平面已有可用纹理（影响 `hasTexture`）。
   * 只承载浏览器本地呈现态与稳定引用，不进入 canonical。
   */
  compositeAssetReadyPlanes?: ReadonlySet<string>;
  /**
   * 每片场节点的对象身份映射（稳定 itemId → 组合作用域根 id）与其编译诊断
   * （change: 2026-10-09-add-film-set-object-motion-and-editing）。
   *
   * 供渲染层把 itemRoots 下发 Rust（对象 picking）与 UI 显示对象级诊断；只承载浏览器本地
   * 派生状态，不进入 canonical。
   */
  compositeAssetCompositions?: ReadonlyMap<string, import("./wire-scene.js").BevyCompositeAssetCompositionInfo>;
  /**
   * 每复合资产节点的范围形状**覆盖**声明（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
   *
   * 复合资产类别默认即 `isometric-diamond`；可信 adapter 只在需要按严格身份改为轴对齐矩形时
   * 通过宿主注入 `rect`。缺省不写入即使用类别默认。只承载派生呈现声明，不进入 canonical。
   */
  compositeAssetEmptyPlaceholders?: ReadonlyMap<string, import("./wire-scene.js").CompositeAssetEmptyPlaceholder>;
  compositeAssetScopeShapes?: ReadonlyMap<string, CompositeAssetScopeShape>;
  /**
   * 每节点的总览 primitive LOD 策略声明
   * （change: 2026-10-15-add-film-set-overview-lod，design D1；
   *  change: film-set group 迁移后同时覆盖 group 徽标场景）。
   *
   * 由宿主按可信 adapter 严格身份解析后注入；存在即写入复合资产的
   * `compositeAsset.geometryQuality` 或 group 的 `geometryQuality`，运行时据此按世界投影尺寸选择
   * 整场图元细分。缺省不写入即 World 用途保持 High。只承载派生呈现声明，不进入 canonical 内容
   * hash、脚本执行 key 或持久 DTO。
   */
  geometryQualities?: ReadonlyMap<string, import("./wire-scene.js").CompositeAssetGeometryQuality>;
  /**
   * 每复合资产节点的**业务类型显示名**（如「片场」「游戏炼丹炉」）
   * （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
   *
   * 由宿主按可信 adapter 身份解析后注入；存在即覆盖通用内容类型标签，供渲染层标注聚合节点业务类型。
   * 缺省不写入即回落到 `contentTypeLabelForNode`。只承载派生呈现声明，不进入 canonical。
   */
  compositeAssetTypeLabels?: ReadonlyMap<string, string>;
  /** 上传中的幽灵节点（只渲染，不进规范状态）；与真实节点同 id 时自动跳过。 */
  ghostNodes?: readonly GhostRenderNode[];
  /**
   * 当前主题 snapshot（change: unify-application-theme-tokens）。
   *
   * 由 Theme Service 传入，**不从 canonical canvas 推导**。缺省使用内置默认主题
   * （兼容测试/最小 fixture）；传入非法值会抛出，避免混合主题。
   */
  theme?: AppThemeSnapshot | unknown;
  /**
   * 模型聚焦瞬时投影（change: add-model-focus-viewing）。
   * 由 Canvas Runtime 传入；缺省或 null 表示普通正交画布。
   */
  modelFocus?: ModelFocusProjection | null;
  /**
   * 图片聚焦瞬时投影（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
   * 由 Canvas Runtime 传入；缺省或 null 表示普通画布。
   */
  imageFocus?: BevyImageFocus | null;
  /**
   * 视频聚焦瞬时投影（change: 2026-10-10-add-video-node-focus-workspace）。
   * 由 Canvas Runtime 传入；缺省或 null 表示普通画布。与 `imageFocus` 互斥。
   */
  videoFocus?: BevyVideoFocus | null;
  /**
   * 模型编辑 gizmo/镜头工具瞬时态（change: add-model-editor-gizmo-shot-capture）。
   * 由 Canvas Runtime 传入；缺省表示不绘制编辑 gizmo。
   */
  modelEditor?: BevyModelEditor | null;
  /**
   * 节点端点 / 连线悬停瞬时态（change: add-node-endpoint-hover / add-edge-hover-delete）。
   * 由 Canvas Runtime 传入；缺省或 null 表示无悬停（端点与删除按钮均不绘制）。
   */
  hover?: BevyHover | null;
  /**
   * 单节点拖动中的 Q/E 触碰粘连瞬时投影（change: add-drag-touch-connections）。
   * 由 Canvas Runtime 传入；缺省或 null 表示当前没有粘连拖动（不绘制操作条）。
   */
  dragAttach?: BevyDragAttach | null;
  /**
   * 多选聚合拉线瞬时投影（change: add-multi-select-aggregate-connect）。
   * 由 Canvas Runtime 传入；缺省或 null 表示当前没有聚合把手。
   */
  aggregateConnect?: BevyAggregateConnect | null;
  /**
   * 活动动画节点播放瞬时投影（change: 2026-10-05-bind-model-animation-to-shots）。
   * 由 Canvas Runtime 传入；缺省或 null 表示当前无活动动画节点。
   */
  animationPlayback?: BevyAnimationPlayback | null;
  /**
   * 公共聚焦过渡进度瞬时更新
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
   * 由 Canvas Runtime coordinator 按唯一帧账本推入；Rust 三维相机据此求值，不再独立计时。
   */
  focusTransition?: BevyFocusTransition | null;
  /**
   * 每节点的顶部操作横条呈现（change: 2026-10-13-add-node-to-film-set-shortcut）。
   *
   * 由 canvas-shell 贡献层计算后注入：宿主贡献「下载」、film-set 贡献「转为片场」，
   * 条目按 `order` 从左到右。横条由 Bevy 绘制、Rust 命中，映射层把每节点的动作描述写入
   * render scene（`nodeActions`）。缺省或空表示该节点不绘制横条。
   */
  nodeActionToolbars?: ReadonlyMap<string, BevyNodeActionsPresentation>;
  /**
   * 多选动作横条描述（change: 2026-10-16-add-group-selection-toolbar）。
   *
   * 由 canvas-shell 贡献层在选中 ≥2 个节点时计算后注入；横条锚定选区轴对齐包围盒顶部。缺省或空
   * 表示不绘制。与 `nodeActionToolbars` 一样由 Bevy 绘制、Rust 命中。
   */
  selectionActionToolbar?: BevyNodeActionsPresentation;
  /**
   * 每预览节点的本地播放状态（change: 2026-10-15-add-film-set-shooting-shot-previews）。
   *
   * 由 canvas-shell/film-set 播放 owner 注入：`progress`/`playing` 只承载**本地**播放投影，
   * 不是 canonical 数据。卡片状态机（准备中/待更新/失败）也在此声明。缺省即全部 `ready`
   * 且无播放进度。
   */
  shotPreviews?: ReadonlyMap<string, {
    state?: import("./wire-scene.js").BevyShotPreviewCardState;
    progress?: number;
    playing?: boolean;
    diagnostic?: string;
  }>;
  /**
   * 每镜头的归属线起点投影（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）。
   *
   * 由 canvas-shell 注入：把镜头当前相机世界姿态（静态/非活动用 initialCamera，活动动态用
   * 同一 T 的采样相机）经当前观察相机投影为画布 2D 起点。缺省即不派生归属线（不伪造起点）。
   */
  shotPreviewCameraProjection?: (filmSetNodeId: string, clipId: string) => { x: number; y: number } | null;
};


/** 校验并返回本帧使用的主题；非法输入直接抛错（不得部分降级）。 */

/** 校验并返回本帧使用的主题；非法输入直接抛错（不得部分降级）。 */
/** 校验并返回本帧使用的主题；非法输入直接抛错（不得部分降级）。 */
export function resolveSceneTheme(input: unknown): AppThemeSnapshot {
  const result = validateAppThemePreset(input ?? defaultAppTheme());
  if (!result.ok) {
    throw new Error(`非法 theme snapshot：${result.code} ${result.error}`);
  }
  return result.theme;
}

/** 构建 Bevy 快照。 */
export function buildCanvasRenderScene(input: CanvasRenderSceneInput): CanvasRenderScene {
  observeContentResolver(input.content);
  const { canvas } = input;
  const resolver = input.nodeCapabilities ?? builtinNodeCapabilityResolver;
  const capabilitiesOf = (node: ServerCanvas["document"]["nodes"][number]) => resolver.resolve({ canvas, node, data: canvas.nodeData[node.id] });
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const assets = new Map<string, StoredAsset>(canvas.assets.map((asset) => [asset.id, asset]));
  const selectedIds = new Set(input.selection?.nodes ?? []);
  // group 的父级几何（change: add-canvas-node-grouping，design D2）：
  // Bevy 只接收绝对画布几何，因此这里先按 parentId 链解析每个节点的绝对偏移。
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const absoluteOffset = (node: { id: string; parentId?: string }): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let parentId = node.parentId;
    const guard = new Set<string>([node.id]);
    while (parentId && !guard.has(parentId)) {
      guard.add(parentId);
      const parent = nodeById.get(parentId);
      if (!parent) break;
      // 父级有位置预览（拖拽 group）时用预览值，使后代在预览中跟随容器
      // （change: add-canvas-node-grouping，design D3）。
      const parentOverride = input.positionOverrides?.get(parentId);
      x += parentOverride ? parentOverride.x : parent.position.x;
      y += parentOverride ? parentOverride.y : parent.position.y;
      // Overrides are absolute: their ancestor offset is already included.
      if (parentOverride) break;
      parentId = parent.parentId;
    }
    return { x, y };
  };
  const directChildren = new Map<string, number>();
  for (const node of canvas.document.nodes) {
    if (!node.parentId) continue;
    directChildren.set(node.parentId, (directChildren.get(node.parentId) ?? 0) + 1);
  }
  // 递归叶子（非 group）计数：决定 group 是否显示聚合输出端点。
  const outputCapableLeaves = (groupId: string): number => {
    let count = 0;
    const stack = canvas.document.nodes.filter((node) => node.parentId === groupId);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (capabilitiesOf(node).container) {
        stack.push(...canvas.document.nodes.filter((candidate) => candidate.parentId === node.id));
      } else {
        count += 1;
      }
    }
    return count;
  };
  const groupSizes = getGroupLayoutSizes(canvas.document.nodes, input.sizeOverrides);
  const dropTargetGroupIds = input.dropTargetGroupIds instanceof Set
    ? input.dropTargetGroupIds
    : new Set(input.dropTargetGroupIds ?? []);
  const hidden = input.modelFocus || input.imageFocus || input.videoFocus ? new Set<string>() : hiddenByCollapsedGroups(canvas);
  // Keep projection input independent from insertion order. Render depth has a
  // deliberate layering policy below: ungrouped roots are always the lowest
  // layer and top-level containers are ordered by their structural bottom edge.
  // Persisted zIndex remains a document/edit field; it is not reused as a second
  // visual truth here (change: 2026-10-27-order-canvas-layers-by-ground-anchor).
  const canonicalNodes = [...canvas.document.nodes];
  // 顶层容器身份（group 结构容器与 composite-asset 片场）：只有在容器层按锚点排序，
  // 普通节点永远留在未归属层（change: 2026-10-27-order-canvas-layers-by-ground-anchor）。
  const containerIds = new Set<string>();
  const projectedNodes = canonicalNodes.filter(node => !hidden.has(node.id)).map((node) => {
    const context = { canvas, node, data: nodeData[node.id] };
    const capabilities = capabilitiesOf(node);
    if (capabilities.container || capabilities.scope) containerIds.add(node.id);
    const kind = capabilities.appearance?.palette ?? "node";
    const previewCard = capabilities.modelPreview;
    // 纯模型节点（片场 animation3d + 通用扩展节点 extension3d）：无卡片，节点矩形即范围框。
    const pureModel = !!capabilities.scope;
    // Legacy film-set composites remain readable for migration/history, but are
    // never emitted as executable compositeAsset wire. Canonical film-set
    // rendering is provided by the group preparation plane below.
    const filmSet = pureModel;
    const size = groupSizes.get(node.id) ?? effectiveCanvasNodeSize(node, input.sizeOverrides?.get(node.id), capabilities);
    const override = input.positionOverrides?.get(node.id);
    const offset = absoluteOffset(node);
    // 位置预览（拖拽）是绝对画布坐标；无预览时用文档局部坐标 + 父级绝对偏移投影。
    const data = nodeData[node.id];
    const executableComposite = filmSet && !isFilmSetNode(node.type, data);
    const collapsed = node.type === "group" && data?.groupCollapsed === true;
    // Preserve the structural anchor so collapsing never moves/resizes the badge.
    // Rust derives the visible bounds from the badge when group.collapsed is true.
    const { x, y, width, height } = {
      x: override ? override.x : node.position.x + offset.x,
      y: override ? override.y : node.position.y + offset.y,
      ...size,
    };
    const displayName = resolveNodeDisplayName({
      type: node.type,
      explicitName: data?.title,
      prompt: data?.prompt
    });
    const texture = resolveTextureKey(node.type, data, assets) !== null;
    const modelOpsV2 = input.modelScenesV2?.get(node.id);
    const preparedResource = input.modelResources?.get(node.id);
    const placement = input.modelPlacements?.get(node.id)
      ?? (kind === "group" ? groupAppearanceModel(data).placement : readPlacement(data));
    // 模型资源：prepared resource 优先，缺省时在同一份规范化结果上一次性派生
    // （测试/最小 fixture 兼容）。
    const resource = capabilities.modelPreparation
      ? (preparedResource
        ?? (modelOpsV2
          ? prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: modelOpsV2 })
          : null))
      : null;
    // 片场：模型与媒体平面共用同一等比适配因子，让范围框（节点矩形）罩住整套内容，
    // 拖动角落缩放矩形即等比缩放内容（change: 2026-10-08-make-film-set-model-only 修订）。
    const pureFit = executableComposite
      ? pureModelFit({
          nodeId: node.id,
          data,
          resource,
          placement,
          width,
          height,
          readyPlaneIds: input.compositeAssetReadyPlanes ?? EMPTY_PLANE_IDS
        })
      : null;
    const filmSetLayoutAabb = pureFit?.layoutAabb ?? null;
    const filmSetMediaPlanes = pureFit?.mediaPlanes ?? [];
    const rendered: BevyRenderNode = {
      id: node.id,
      type: kind,
      x,
      y,
      width,
      height,
      body: readBody(node.type, data, assets),
      title: displayName.displayName,
      // 复合资产节点优先显示可信 adapter 声明的**业务类型名**（如「片场」「游戏炼丹炉」），
      // 否则回落通用内容类型标签（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
      typeLabel: input.compositeAssetTypeLabels?.get(node.id) ?? displayName.contentTypeLabel,
      progress: clampProgress(data?.progress),
      busy: isBusy(data),
      texture,
      // 仅当该节点是唯一选中项时才绘制抓手，避免多选时语义歧义（design D1）。
      // group 容器同样支持右下角 resize（design D2）。
      resizable: !!capabilities.resize && !collapsed && selectedIds.size === 1 && selectedIds.has(node.id),
      ...(previewCard ? { modelPreview: previewCard.project(context, input.modelPreviews?.get(node.id)) } : {}),
      // 片场（animation3d）纯模型：不携带卡片分类名（Bevy 不绘制卡片），只给条件范围几何。
      // 普通 model3d 保留「3D 模型」分类名（change: 2026-10-08-make-film-set-model-only）。
      ...(capabilities.appearance?.cardLabel ? { cardLabel: capabilities.appearance.cardLabel } : {}),
      ...(executableComposite
      ? {
          compositeAsset: compositeAssetScopeForNode({
            x,
            y,
            width,
            height,
            // 范围形状是**复合资产类别的默认**：除非可信 adapter 按严格身份另行声明，所有
            // composite-asset（片场、炼丹炉、未来第三方）一律使用地面占地的等距范围；非
            // composite-asset（text/image/model3d 卡片/group）不进入此分支，保持矩形。
            // （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3 修订）。
            scopeShape: input.compositeAssetScopeShapes?.get(node.id) ?? capabilities.scope!.shape(context),
            // 总览 LOD 策略只由可信 adapter 声明；缺失即 World 用途保持 High
            // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
            emptyPlaceholder: input.compositeAssetEmptyPlaceholders?.get(node.id),
            geometryQuality: input.geometryQualities?.get(node.id),
            mediaPlanes: filmSetMediaPlanes,
            layoutAabb: filmSetLayoutAabb,
            rootPlacement: placement,
            contentExtent: resource?.extent ?? 2,
            itemPlacements: Object.fromEntries(readFilmSetContent(data).items.map(item => [
              encodeFilmSetPartId(item.id, ""),
              { offset: { ...item.localTransform.offset }, scale: item.localTransform.scale, yaw: item.localTransform.yaw * 180 / Math.PI }
            ])),
            ...(input.compositeAssetCompositions?.get(node.id)?.itemRoots
              ? { itemRoots: input.compositeAssetCompositions.get(node.id)!.itemRoots }
              : {})
          })
        }
      : {})
    };
    if (capabilities.container) {
      rendered.group = {
        ...capabilities.container.project(context, {
          memberCount: directChildren.get(node.id) ?? 0,
          outputCapableLeafCount: outputCapableLeaves(node.id)
        }),
        // Group-only presentation stays a projection of canonical nodeData; defaults are never
        // written back (change: 2026-10-24-unify-group-and-film-set-authoring).
        ...(kind === "group" ? {
          collapsed,
          badgeScale: clampGroupBadgeScale(input.groupBadgeScaleOverrides?.get(node.id) ?? data?.groupBadgeScale ?? 1),
          badgeResizable: input.groupBadgeResizable === true && selectedIds.size === 1 && selectedIds.has(node.id),
          // 所有 group（普通组与片场组）都绘制节点顶部操作横条；具体动作仍由
          // `canvas.node-action` 贡献按通用能力与节点身份决定。
          actionBar: true,
          // 可信 adapter 的声明同时覆盖 group 徽标的场景组合（片场迁移后不再有 compositeAsset）。
          ...(input.geometryQualities?.get(node.id) ? { geometryQuality: input.geometryQualities.get(node.id) } : {}),
          ...(resource?.aabb ? { modelBounds: { aabb: resource.aabb, extent: resource.extent } } : {})
        } : {})
      };
      if (node.type === "group" && dropTargetGroupIds.has(node.id)) rendered.group.dropTarget = true;
    }
    if (capabilities.modelPreparation) {
      // prepared resource 优先：映射层只引用 resource key，不遍历顶点/序列化 ops。
      // 缺省时回落到裸 ops，在同一份规范化结果上一次性派生（测试/最小 fixture 兼容）。
      if (resource) {
        rendered.model = {
          sceneVersion: resource.sceneVersion,
          resourceKey: resource.resourceKey,
          signature: resource.signature,
          ...(placement ? { placement } : {})
        };
      }
    }
    // 拍摄镜头预览卡片呈现（change: 2026-10-15-add-film-set-shooting-shot-previews，design D2/D8）：
    // 只读投影源镜头的标题/类型/画幅/时长/状态，不复制第二份权威数据；无归属或源已消失时不绘制。
    // 旧形态写 `shotPreview`；迁移后的形态是 owner-managed 媒体节点（`managedBy` + `mediaContent`）。
    const legacyShotOwnership = shotPreviewOwnershipOf(data);
    const shotOwnership = legacyShotOwnership ?? managedShotPreviewOwnershipOf(data);
    if (shotOwnership) {
      const filmSetData = nodeData[shotOwnership.filmSetNodeId] as FilmSetNodeData | undefined;
      const local = input.shotPreviews?.get(node.id);
      const ownerNode = canvas.document.nodes.find(entry => entry.id === shotOwnership.filmSetNodeId);
      const groupMarker = ownerNode?.type === "group" ? readFilmSetGroupMarker(filmSetData) : null;
      const presentation = groupMarker
        ? shotPreviewCardPresentationForFilmSetGroup({ groupNodeId: shotOwnership.filmSetNodeId, groupData: filmSetData, clipId: shotOwnership.clipId, state: local?.state, progress: local?.progress, playing: local?.playing, diagnostic: local?.diagnostic })
        : legacyShotOwnership ? shotPreviewCardPresentation({
          filmSetNodeId: shotOwnership.filmSetNodeId,
          previewData: data,
          filmSetData,
          state: local?.state,
          progress: local?.progress,
          playing: local?.playing,
          diagnostic: local?.diagnostic
        }) : null;
      if (presentation) {
        rendered.shotPreview = presentation;
        // 卡片主标题 = 镜头名，次要标记 = 静态/动态类型（design D8）。这些是源镜头的只读投影，
        // 不在预览节点上复制权威数据。
        rendered.title = presentation.name;
        rendered.typeLabel = presentation.kind === "static" ? "静态镜头" : "动态镜头";
      }
    }
    return rendered;
  });

  // Render depth is intentionally separate from persisted zIndex
  // （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D2/D3）：
  // 1. 未归属层：`parentId` 为空且不是容器的节点按现有文档顺序在最下；
  // 2. 容器层：顶层容器（`group` 与顶层 `composite-asset` 片场）按**绝对结构底边**锚点
  //    升序（y 越大越靠前、越后绘制），同锚点按节点 id 升序；每个容器后紧跟它的成员闭包，
  //    组内片场按成员处理，不重复进入容器排序；
  // 3. 兜底：被环/异常 parent 关系挤出的节点仍按文档顺序发射，不丢节点。
  // 这是派生的绘制序列，不写回第二份持久顺序字段。
  const projectedById = new Map(projectedNodes.map((node) => [node.id, node]));
  const documentOrder = new Map(canonicalNodes.map((node, index) => [node.id, index]));
  const children = new Map<string, string[]>();
  for (const node of canonicalNodes) {
    if (!node.parentId || !projectedById.has(node.id) || !projectedById.has(node.parentId)) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const compareChildIds = (left: string, right: string): number => {
    const leftNode = projectedById.get(left);
    const rightNode = projectedById.get(right);
    const leftGroup = leftNode?.type === "group" ? 0 : 1;
    const rightGroup = rightNode?.type === "group" ? 0 : 1;
    return leftGroup - rightGroup
      || (leftGroup === 0 ? compareId(left, right) : (documentOrder.get(left) ?? 0) - (documentOrder.get(right) ?? 0));
  };
  for (const ids of children.values()) ids.sort(compareChildIds);
  const orderedIds: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const node = projectedById.get(id);
    if (!node) return;
    visited.add(id);
    orderedIds.push(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  const roots = canonicalNodes.filter((node) => !node.parentId || !projectedById.has(node.parentId));
  for (const node of roots.filter((entry) => !containerIds.has(entry.id))) visit(node.id);
  const containers = roots
    .filter((entry) => containerIds.has(entry.id) && projectedById.has(entry.id))
    .map((entry) => ({ id: entry.id, anchor: canvasGroundAnchor(projectedById.get(entry.id)!) }))
    .sort(compareCanvasGroundOrder);
  for (const container of containers) visit(container.id);
  for (const node of projectedNodes) visit(node.id);
  const nodes = orderedIds.map((id) => projectedById.get(id)!);

  // 幽灵节点（上传中）：追加为普通 Bevy 节点，复用完全相同的卡片绘制。
  // 同 id 的真实节点已存在时跳过（working projection 接管，避免重复绘制）。
  const realIds = new Set(canvas.document.nodes.map((node) => node.id));
  for (const ghost of input.ghostNodes ?? []) {
    if (realIds.has(ghost.id)) continue;
    const kind = bevyKindForNodeType(ghost.nodeType);
    const size = bevyNodeSize(kind);
    const progress = clampProgress(ghost.progress);
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
      progress,
      // busy=true 驱动进度环；节点卡片不显示任何状态文案。
      busy: true,
      texture: ghost.texture === true,
      resizable: false,
      ghost: true
    });
  }

  // 纯模型节点（片场 animation3d + 通用扩展节点 extension3d）不能作为边端点：
  // canonical 已由 reducer/规范化保证；映射层再做一次防御过滤，避免异常帧绘制纯模型连线
  // （change: 2026-10-08-make-film-set-model-only；change: 2026-10-10 泛化）。
  const filmSetNodeIds = new Set(
    canvas.document.nodes.filter((node) => capabilitiesOf(node).connections?.endpoints({ canvas, node, data: nodeData[node.id] }) === "none").map((node) => node.id)
  );
  const edges = canvas.document.edges
    .filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target) && !filmSetNodeIds.has(edge.source) && !filmSetNodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: typeof edge.data?.label === "string" ? edge.data.label : ""
    }));

  // 派生拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）：
  // 独立于普通边拓扑；起点由注入的相机投影给出，缺失即不派生该线（不伪造起点）。
  const previewNodeById = new Map(nodes.map((node) => [node.id, node]));
  const shotPreviewLinks: BevyShotPreviewLink[] = [];
  if (input.shotPreviewCameraProjection) {
    for (const node of canvas.document.nodes) {
      const data = nodeData[node.id];
      if (hidden.has(node.id)) continue;
      if (isFilmSetNode(node.type, data)) {
        shotPreviewLinks.push(...shotPreviewLinksForFilmSet({
          filmSetNodeId: node.id,
          data: data as FilmSetNodeData | undefined,
          previewNodeById: (previewId) => { const node = previewNodeById.get(previewId); return node?.shotPreview?.hidden ? undefined : node; },
          cameraProjection: (clipId) => input.shotPreviewCameraProjection!(node.id, clipId)
        }));
      } else if (node.type === "group" && readFilmSetGroupMarker(data)) {
        shotPreviewLinks.push(...shotPreviewLinksForFilmSetGroup({
          groupNodeId: node.id,
          groupData: data,
          previewNodeById: (previewId) => { const preview = previewNodeById.get(previewId); return preview?.shotPreview?.hidden ? undefined : preview; },
          cameraProjection: (clipId) => input.shotPreviewCameraProjection!(node.id, clipId)
        }));
      }
    }
  }

  // Film-set groups are rendered from source cards and bindings.  The
  // preparation is deliberately a read projection: unavailable cards remain
  // represented by diagnostics and never cause the binding to disappear.
  const filmSetGroups: BevyFilmSetGroupPreparation[] = [];
  for (const node of canvas.document.nodes) {
    if (hidden.has(node.id) || node.type !== "group" || !readFilmSetGroupMarker(nodeData[node.id])) continue;
    const prepared = prepareFilmSetGroup(canvas, node.id);
    if (!prepared) continue;
    const diagnosticByBinding = new Map(prepared.diagnostics.map(diagnostic => [diagnostic.bindingId, diagnostic.message]));
    const objectIds = new Set((input.modelResources?.get(node.id)?.ops ?? input.modelScenesV2?.get(node.id) ?? []).map(op => op.id));
    const sceneBindings = activeFilmSetSceneBindings(prepared.marker);
    for (const binding of sceneBindings) if (objectIds.has(encodeFilmSetPartId(binding.bindingId, "resource-unavailable"))) diagnosticByBinding.set(binding.bindingId, diagnosticByBinding.get(binding.bindingId) ?? "资源准备失败，请检查来源卡片后重试");
    const bindings: BevyFilmSetGroupBinding[] = sceneBindings.map(binding => {
      const resolved = prepared.bindings.find(candidate => candidate.bindingId === binding.bindingId);
      const sourcePresentation = projectedNodes.find(candidate => candidate.id === binding.sourceNodeId);
      const sourceData = nodeData[binding.sourceNodeId];
      const assetId = sourceData?.outputAssetId ?? sourceData?.mediaContent?.payload?.assetId;
      const sourceAsset = typeof assetId === "string" ? assets.get(assetId) : undefined;
      const width = sourceAsset?.metadata?.width, height = sourceAsset?.metadata?.height;
      const aspectRatio = typeof width === "number" && Number.isFinite(width) && width > 0 && typeof height === "number" && Number.isFinite(height) && height > 0 ? width / height : 1;
      return {
        bindingId: binding.bindingId,
        sourceNodeId: binding.sourceNodeId,
        kind: binding.kind,
        contentKey: resolved?.contentKey ?? binding.contentKey,
        ...(sourcePresentation?.model?.resourceKey ? { resourceKey: sourcePresentation.model.resourceKey } : {}),
        ...(sourcePresentation?.model?.signature ? { signature: sourcePresentation.model.signature } : {}),
        transform: { ...binding.transform },
        visible: binding.visibility,
        ...(binding.kind === "model3d" ? {} : { aspectRatio }),
        ...(diagnosticByBinding.has(binding.bindingId) ? { diagnostic: diagnosticByBinding.get(binding.bindingId) } : {})
      };
    });
    filmSetGroups.push({
      schemaVersion: FILM_SET_GROUP_RENDER_SCHEMA_VERSION,
      ownerId: node.id,
      ...(prepared.marker.sceneTransform ? { sceneTransform: { ...prepared.marker.sceneTransform } } : {}),
      badgeOrigin: { x: absoluteOffset(node).x + (node.width ?? 0) / 2, y: absoluteOffset(node).y + (node.height ?? 0) },
      bindings,
      ...(prepared.marker.ground ? { ground: { ...prepared.marker.ground } } : {}),
      ...(prepared.marker.activeClip === undefined ? {} : { activeClip: prepared.marker.activeClip })
    });
  }

  return {
    version: CANVAS_RENDER_SCENE_VERSION,
    revision: canvas.revision,
    nodes,
    edges,
    ...(filmSetGroups.length > 0 ? { filmSetGroups } : {}),
    ...(shotPreviewLinks.length > 0 ? { shotPreviewLinks } : {}),
    selection: {
      nodes: [...(input.selection?.nodes ?? [])].filter(id => !hidden.has(id)),
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
      ? { nodeActions: Object.fromEntries([...input.nodeActionToolbars].filter(([id, value]) => !hidden.has(id) && value.actions.length > 0)) }
      : {}),
    ...(input.selectionActionToolbar && input.selectionActionToolbar.actions.length > 0
      ? { selectionActions: input.selectionActionToolbar }
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
    `rev=${scene.revision}`,
    `sel=${scene.selection.nodes.join(",")}|${scene.selection.edge ?? ""}`,
    `vp=${scene.viewport.x},${scene.viewport.y},${scene.viewport.zoom}`,
    `theme=${scene.theme.fingerprint}`,
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
      : "na=",
    scene.selectionActions
      ? `sa=${scene.selectionActions.actions.map((action) => `${action.id}:${action.label}:${action.enabled ? 1 : 0}:${action.menu ? 1 : 0}:${action.tone ?? "neutral"}`).join("|")}@${scene.selectionActions.summary ?? ""}`
      : "sa="
  ];
  for (const node of scene.nodes) {
    parts.push(`n=${stablePresentationStringify(node)}`);
  }
  for (const edge of scene.edges) {
    parts.push(`e=${edge.id},${edge.source},${edge.target},${edge.label}`);
  }
  // 派生归属线（change: 2026-10-15-add-film-set-shooting-shot-previews）：起点/目标变化即重绘。
  for (const link of scene.shotPreviewLinks ?? []) {
    parts.push(`shot-link=${link.id},${link.ownerNodeId},${link.previewNodeId},${link.clipId},${link.start.x},${link.start.y}`);
  }
  // 活动播放投影的 viewMode/目标卡片参与指纹，使 hover 目标切换触发一次 set_scene。
  if (scene.animationPlayback) {
    parts.push(`motion-view=${scene.animationPlayback.viewMode ?? ""},${scene.animationPlayback.targetPreviewNodeId ?? ""}`);
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
