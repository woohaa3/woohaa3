/**
 * 画布快照合成
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；
 *   change: optimize-model-scene-snapshot-hot-path）。
 *
 * 从 `interaction-controller.ts` 拆出：合成 `CanvasRenderScene` 并附带本帧引用到的
 * prepared model resources。只读取注入的输入，不持有 gesture/RAF 状态。
 */
import {
  buildCanvasRenderScene,
  defaultAppTheme,
  prepareModelResource,
  type CanvasRenderScene,
  type PreparedModelResource
} from "@woohaa3/contracts";
import { projectCompositeFocusContext } from "./composite-focus-context.js";
import { applyRunStateProjection } from "./run-state-projection.js";
import { buildShotPreviewSceneInput } from "./shot-preview-scene-input.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import type { InteractionControllerOptions } from "./interaction-types.js";
import type { Viewport } from "./interaction-core.js";
import { applyNodeResourceLoading } from "../../services/node-resource-loading.js";

export type SceneBuildInput = {
  badgeResize?: {nodeId: string; scale: number} | null;
  selected: readonly string[];
  draft: { source: string; side: "input" | "output"; x: number; y: number } | null;
  /** 框选选区矩形（世界坐标，change: fix-group-and-marquee-preview）。 */
  marquee: { x: number; y: number; width: number; height: number } | null;
  localPositions: Map<string, { x: number; y: number }>;
  localSizes: Map<string, { width: number; height: number }>;
  viewportPreview: Viewport | null;
  fallbackViewport: Viewport;
  hoveredNodeId: string | null;
  hoveredPort: "input" | "output" | null;
  hoveredEdgeId: string | null;
  hoveredHistory?: { nodeId: string; presentationId: string } | null;
  pressedHistory?: { nodeId: string; presentationId: string } | null;
  /**
   * 拖动粘连瞬时投影（change: add-drag-touch-connections）。
   * 缺省/`null` 表示当前没有粘连拖动；只在合格 drag 越过移动阈值后投影。
   */
  dragAttach?: import("@woohaa3/contracts").BevyDragAttach | null;
  /**
   * 多选聚合把手瞬时投影（change: add-multi-select-aggregate-connect）。
   * 缺省/`null` 表示当前没有聚合把手。
   */
  aggregateConnect?: import("@woohaa3/contracts").BevyAggregateConnect | null;
  /**
   * 已上传纹理的片场媒体平面 id 集合（change: 2026-10-08-make-film-set-model-only）。
   * 缺省/`null` 表示本帧无就绪片场媒体纹理。
   */
  compositeAssetReadyPlanes?: ReadonlySet<string> | null;
  /**
   * 每片场节点的对象身份映射（稳定 itemId → 组合作用域根 id）与诊断
   * （change: 2026-10-09-add-film-set-object-motion-and-editing）。
   * 缺省时回落到 model-scene 组合 store 快照。
   */
  compositeAssetCompositions?: ReadonlyMap<string, import("@woohaa3/contracts").BevyCompositeAssetCompositionInfo> | null;
};

export function buildSceneWithResources(
  options: InteractionControllerOptions,
  surfaceSize: () => { width: number; height: number; pixelRatio: number; originX?: number; originY?: number },
  modelPlacements: () => ReadonlyMap<string, import("@woohaa3/contracts").BevyModelPlacement>,
  input: SceneBuildInput
): { scene: CanvasRenderScene; resources: Map<string, PreparedModelResource> } | null {
  // Bevy/hit test 使用 working projection：立即反映本页 pending 命令（design D11）。
  const source = workingCanvasOf(woohaa3CanvasStore.getState());
  const working = options.projectHistoryCanvas?.(source) ?? source;
  const canvasState = options.compositeAssets?.projectCanvas(working) ?? working;
  if (!canvasState) return null;
  const sourceNodes = new Map(canvasState.document.nodes.map(node => [node.id, node]));
  // provider 的 prepared resource 按 nodeId 索引；映射层按 nodeId 取用。
  const byNode = new Map<string, PreparedModelResource>(options.getModelResources?.() ?? []);
  // 历史本地 snapshot override：只覆盖对应节点的 Scene IR，不写规范状态（任务 4.3）。
  const focusNode = options.getModelFocus?.()?.nodeId ?? null;
  if (focusNode) {
    const override = options.getModelSceneOverride?.(focusNode) ?? null;
    if (override) {
      // override ops 未持久化 prepared 结果；每次选择历史版本生成一份临时资源（低频）。
      byNode.set(focusNode, prepareModelResource({ sceneVersion: override.version, ops: override.ops as never }));
    }
  }
  const compositions = new Map(options.getCompositeAssetCompositions?.() ?? options.compositeAssets?.compositions() ?? []);
  if (focusNode) {
    const history = options.compositeAssets?.resolve(canvasState, focusNode)?.historyProjection?.(focusNode);
    if (history) {
      if (history.resource) byNode.set(focusNode, history.resource);
      else byNode.delete(focusNode);
      if (history.composition) compositions.set(focusNode, history.composition);
    }
  }
  const viewport = input.viewportPreview ?? input.fallbackViewport;
  const surface = surfaceSize();
  const contentRight = Math.max(0, options.getContentRect?.().right ?? 0);
  // 拍摄镜头预览：宿主只从权威画布 + 当前播放投影派生只读卡片状态与归属线起点投影
  // （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D7/D8）。
  const shotPreviews = buildShotPreviewSceneInput({
    canvas: canvasState,
    playback: options.getAnimationPlayback?.() ?? null,
    targets: options.getModelFocusTargets?.() ?? []
  });
  const scene = buildCanvasRenderScene({
    groupBadgeScaleOverrides: input.badgeResize ? new Map([[input.badgeResize.nodeId, input.badgeResize.scale]]) : undefined,
    groupBadgeResizable: options.isWritable?.() ?? options.getSession()?.isWritable() ?? false,
    canvas: canvasState,
    nodeCapabilities: options.nodeCapabilities,
    modelPreviews: modelPreviewStore.snapshot(),
    selection: { nodes: [...input.selected], edge: null },
    draft: input.draft,
    marquee: input.marquee,
    surface: { ...surface, contentRight, ...(options.getFocusContentRect?.() ? { contentRect: options.getFocusContentRect!()! } : {}) },
    positionOverrides: input.localPositions,
    sizeOverrides: input.localSizes,
    viewportOverride: viewport,
    modelResources: byNode,
    modelPlacements: modelPlacements(),
    ghostNodes: options.getGhostNodes?.() ?? [],
    nodeActionToolbars: options.getNodeActionToolbars?.(),
    selectionActionToolbar: options.getSelectionActionToolbar?.() ?? undefined,
    shotPreviews: shotPreviews.shotPreviews,
    shotPreviewCameraProjection: shotPreviews.shotPreviewCameraProjection,
    theme: options.getTheme?.() ?? defaultAppTheme(),
    modelFocus: options.getModelFocus?.() ?? null,
    imageFocus: options.getImageFocus?.() ?? null,
    videoFocus: options.getVideoFocus?.() ?? null,
    modelEditor: options.getModelEditor?.() ?? null,
    hover: input.hoveredNodeId
      ? { nodeId: input.hoveredNodeId, port: input.hoveredPort }
      : input.hoveredEdgeId
        ? { edgeId: input.hoveredEdgeId }
        : null,
    dragAttach: input.dragAttach ?? null,
    aggregateConnect: input.aggregateConnect ?? null,
    animationPlayback: options.getAnimationPlayback?.() ?? null,
    focusTransition: options.getFocusTransition?.() ?? null,
    compositeAssetReadyPlanes: input.compositeAssetReadyPlanes ?? undefined,
    compositeAssetCompositions: compositions,
    // 通用范围形状按严格身份从可信 adapter 解析，与 working 尺寸同源派生
    // （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3）。
    compositeAssetScopeShapes: options.compositeAssets?.scopeShapes(canvasState),
    // 业务类型显示名按严格身份从可信 adapter 解析，供浮动名称面板标注聚合节点业务类型
    // （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
    compositeAssetTypeLabels: options.compositeAssets?.typeLabels(canvasState),
    // 总览 primitive LOD 策略按严格身份从可信 adapter 解析；仅显式声明的业务用例降档，其它
    // World 用途保持 High（change: 2026-10-15-add-film-set-overview-lod，design D1）。
    compositeAssetEmptyPlaceholders: options.compositeAssets?.emptyPlaceholders(canvasState),
    compositeAssetGeometryQualities: options.compositeAssets?.geometryQualities(canvasState)
  });
  const isModelLoading = options.getModelLoading?.() ?? options.isModelLoading;
  applyNodeResourceLoading(scene, {
    image: options.textureSync,
    video: options.videoSessions,
    model: isModelLoading ? {
      isLoading: isModelLoading,
      isResourceNode: node => {
        const source = sourceNodes.get(node.id);
        return !!source && !!(options.nodeCapabilities?.resolve({ canvas: canvasState, node: source, data: canvasState.nodeData[node.id] }).modelPreparation);
      }
    } : undefined
  });
  for (const node of scene.nodes) {
    // 内容投影回调只改内容/媒体/对象，不拥有形状声明；先记录 mapper 派生的形状，回调后恢复，
    // 避免投影无意覆盖 scopeShape（design D3）。
    const scopeShape = node.compositeAsset?.scopeShape;
    // 总览 LOD 策略同属 mapper 派生呈现声明，回调不拥有；回调后恢复为宿主注入值
    // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    const geometryQuality = node.compositeAsset?.geometryQuality;
    const sourceNode = sourceNodes.get(node.id);
    if (sourceNode) options.compositeAssets?.resolveNode(canvasState, sourceNode)?.projectPresentation?.(node, canvasState.nodeData[node.id], byNode.get(node.id));
    if (node.compositeAsset) {
      if (scopeShape) node.compositeAsset.scopeShape = scopeShape;
      else delete node.compositeAsset.scopeShape;
      if (geometryQuality) node.compositeAsset.geometryQuality = geometryQuality;
      else delete node.compositeAsset.geometryQuality;
    }
  }
  options.compositeAssets?.projectChildren(scene, canvasState);
  // 统一生成运行状态 → 节点底部历史条与聚合运行遮罩投影
  // （change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
  const runState = options.getRunState?.() ?? null;
  if (runState) applyRunStateProjection(scene.nodes, runState);
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const node of scene.nodes) {
    if (node.aggregateRun?.filmSet) {
      node.aggregateRun.reduceMotion = reduceMotion;
      // Historical model/media projections are read-only outputs of an older work, never live executions.
      if ((node.id === focusNode && options.getModelSceneOverride?.(node.id))
        || (sourceNodes.has(node.id) && options.compositeAssets?.resolveNode(canvasState, sourceNodes.get(node.id)!)?.historyProjection?.(node.id))) delete node.aggregateRun;
    }
  }
  for (const node of scene.nodes) for (const dot of node.historyStrip?.dots ?? []) {
    dot.hovered = input.hoveredHistory?.nodeId === node.id && input.hoveredHistory.presentationId === dot.presentationId;
    dot.pressed = input.pressedHistory?.nodeId === node.id && input.pressedHistory.presentationId === dot.presentationId;
  }

  projectCompositeFocusContext(scene, canvasState, options.compositeAssets, (options.isWritable?.() ?? options.getSession()?.isWritable() ?? false) && options.getModelFocusMode?.() !== "history");

  // runtime 按 resourceKey 注册；只收集本帧实际引用的资源（先注册、后提交）。
  const resources = new Map<string, PreparedModelResource>();
  for (const node of scene.nodes) {
    const key = node.model?.resourceKey;
    if (!key) continue;
    const resource = byNode.get(node.id);
    if (resource) resources.set(key, resource);
  }
  sceneDiagnostics.sceneBuilds += 1;
  return { scene, resources };
}
