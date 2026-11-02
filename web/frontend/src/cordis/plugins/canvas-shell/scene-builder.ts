/**
 * 画布快照合成
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；
 *   change: optimize-model-scene-snapshot-hot-path；
 *   change: remove-canvas-groups-and-film-set —— 只投影普通节点与边）。
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
import { applyRunStateProjection } from "./run-state-projection.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import type { InteractionControllerOptions } from "./interaction-types.js";
import type { Viewport } from "./interaction-core.js";
import { applyNodeResourceLoading } from "../../services/node-resource-loading.js";

export type SceneBuildInput = {
  selected: readonly string[];
  draft: { source: string; side: "input" | "output"; x: number; y: number } | null;
  /** 框选选区矩形（世界坐标）。 */
  marquee: { x: number; y: number; width: number; height: number } | null;
  localPositions: Map<string, { x: number; y: number }>;
  localSizes: Map<string, { width: number; height: number }>;
  worldGroundPreviews?: ReadonlyMap<string, { u: number; v: number }>;
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
  if (!working) return null;
  // Provider-backed media resolves asynchronously. Project the ready runtime asset into
  // this render snapshot so the canonical scene can expose `texture: true` immediately,
  // before the persistence command writes outputAssetId back to nodeData.
  const runtimeMedia = options.mediaContent;
  const runtimeAssets = runtimeMedia
    ? working.document.nodes
      .map(node => runtimeMedia.state(node.id)?.asset)
      .filter((asset): asset is import("@woohaa3/contracts").StoredAsset => !!asset && asset.status === "ready")
    : [];
  const canvasState: import("@woohaa3/contracts").ServerCanvas = runtimeAssets.length
    ? {
        ...working,
        assets: [...working.assets, ...runtimeAssets.filter(asset => !working.assets.some(existing => existing.id === asset.id))],
        nodeData: Object.fromEntries(working.document.nodes.map(node => {
          const asset = runtimeMedia?.state(node.id)?.asset;
          const data = working.nodeData[node.id] ?? {};
          return [node.id, asset?.status === "ready" && (node.type === "image" || node.type === "video") && typeof data.outputAssetId !== "string"
            ? { ...data, outputAssetId: asset.id }
            : data];
        })) as import("@woohaa3/contracts").ServerCanvas["nodeData"]
      } as import("@woohaa3/contracts").ServerCanvas
    : working;
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
  const viewport = input.viewportPreview ?? input.fallbackViewport;
  const surface = surfaceSize();
  const contentRight = Math.max(0, options.getContentRect?.().right ?? 0);
  const scene = buildCanvasRenderScene({
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
    worldGroundPreviews: input.worldGroundPreviews,
    ghostNodes: options.getGhostNodes?.() ?? [],
    nodeActionToolbars: options.getNodeActionToolbars?.(),
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
    focusTransition: options.getFocusTransition?.() ?? null
  });
  const isModelLoading = options.getModelLoading?.() ?? options.isModelLoading;
  applyNodeResourceLoading(scene, {
    image: options.textureSync,
    video: options.videoSessions,
    model: isModelLoading ? {
      isLoading: isModelLoading,
      isResourceNode: node => {
        const sourceNode = sourceNodes.get(node.id);
        return !!sourceNode && !!(options.nodeCapabilities?.resolve({ canvas: canvasState, node: sourceNode, data: canvasState.nodeData[node.id] }).modelPreparation);
      }
    } : undefined
  });
  // 统一生成运行状态 → 节点底部历史条投影。
  const runState = options.getRunState?.() ?? null;
  if (runState) applyRunStateProjection(scene.nodes, runState);
  for (const node of scene.nodes) for (const dot of node.historyStrip?.dots ?? []) {
    dot.hovered = input.hoveredHistory?.nodeId === node.id && input.hoveredHistory.presentationId === dot.presentationId;
    dot.pressed = input.pressedHistory?.nodeId === node.id && input.pressedHistory.presentationId === dot.presentationId;
  }

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
