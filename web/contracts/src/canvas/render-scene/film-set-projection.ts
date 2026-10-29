/**
 * 片场（film-set）渲染投影（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 片场范围几何、媒体平面世界投影与对象 placement 读取。纯派生几何，不写规范文档；
 * 渲染、聚焦、drop 命中与 Rust 共用同一公式。
 */
import type { CanvasNodeData } from "../domain/index.js";
import { compositeAssetNodeBoxSize as nodeBoxSize } from "../node-dimensions.js";
import { decodeFilmSetLocalTransform, readFilmSetContent } from "../film-set-content.js";
import { filmSetFitFactor, modelAnchor, modelLayoutAabbRelative, modelWorldAabbRelative, worldToCanvasPoint, type ModelSceneInput } from "../model-focus.js";
import type { Aabb } from "../model-transform.js";
import { filmSetLayoutBounds } from "../film-set-layout.js";
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "../model-script.js";
import type { PreparedModelResource } from "../prepared-model.js";
import type { SceneV2Op } from "../scene-ir-v2.js";
import type { BevyModelMediaPlane, BevyCompositeAssetPresentation, CompositeAssetGeometryQuality, CompositeAssetScopeShape } from "./wire-scene.js";
import type { BevyModelPlacement } from "./wire-model.js";
import { COMPOSITE_ASSET_SCOPE_AXIS_X, COMPOSITE_ASSET_SCOPE_AXIS_Y, COMPOSITE_ASSET_SCOPE_MARGIN, type ScopeGround, type ScopePoint } from "./composite-asset-scope.js";

/** 空片场最小可点击范围半边长（世界坐标）。 */
export const COMPOSITE_ASSET_SCOPE_MIN_HALF = 32;

/**
 * 片场默认节点尺寸（= 范围基准矩形默认尺寸）。
 *
 * 片场没有卡片，模型居中并等比适配基准矩形；`rect` 范围即基准矩形，菱形范围由它派生同心
 * 外接菱形。拖动菱形右顶点抓手等比缩放基准矩形即等比缩放整个片场内容
 * （change: 2026-10-08-make-film-set-model-only 修订；change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
 */
export { COMPOSITE_ASSET_DEFAULT_SIZE } from "../node-dimensions.js";

/** Canonical dimensions only. Old compact defaults are handled by the offline migration. */
export function compositeAssetNodeBoxSize(node: { width?: number; height?: number }): { width: number; height: number } {
  return nodeBoxSize(node);
}

/** 沿地面轴等比外扩固定边距：`k = 1 + margin / max(hx, hz)`，保持地面宽深比（design D2）。 */
export function expandGroundFootprint(center: ScopePoint, halfX: number, halfZ: number, margin: number): ScopeGround {
  const hx0 = Number.isFinite(halfX) && halfX > 0 ? halfX : 0;
  const hz0 = Number.isFinite(halfZ) && halfZ > 0 ? halfZ : 0;
  const maxHalf = Math.max(hx0, hz0);
  const k = maxHalf > 0 ? 1 + margin / maxHalf : 1;
  return { cx: center.x, cy: center.y, hx: hx0 * k, hz: hz0 * k };
}

/**
 * 由模型内容与适配单位派生范围**地面矩形**（change: design D2 修订）。
 *
 * 事实源为内容局部三维 AABB 的 **x/z 投影**（`layoutAabb` 已含对象 yaw 后的内容包围盒）。
 * 复用与渲染/锚点完全相同的共享原语（`modelWorldAabbRelative` + `modelAnchor` +
 * `worldToCanvasPoint`），保证范围中心与模型世界位置逐位一致。范围 = 地面占地（世界轴对齐，
 * 四边始终平行网格）等比外扩固定边距。无几何/非法数值时返回 `null`。
 */
export function compositeAssetScopeGroundForNode(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  layoutAabb?: Aabb | null;
  rootPlacement?: BevyModelPlacement | null;
  contentExtent?: number;
  itemPlacements?: Record<string, BevyModelPlacement>;
}): ScopeGround | null {
  const local = input.layoutAabb;
  if (!local) return null;
  const extent = Number.isFinite(input.contentExtent) && (input.contentExtent as number) > 0 ? (input.contentExtent as number) : 2;
  const offset = input.rootPlacement?.offset ?? { x: 0, y: 0, z: 0 };
  const scene: ModelSceneInput = {
    sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION,
    ops: [],
    extent,
    aabb: local,
    placement: input.rootPlacement ?? null,
    filmSetFit: { width: input.width, height: input.height }
  };
  // 相对锚点的世界地面 x/z 占地（yaw + unit，不含等距相机旋转）。
  const relative = modelWorldAabbRelative(scene);
  const isometric = modelLayoutAabbRelative(scene);
  if (!relative || !isometric) return null;
  const anchor = modelAnchor({
    nodeX: input.x,
    nodeY: input.y,
    nodeWidth: input.width,
    nodeHeight: input.height,
    centered: true,
    relativeAabb: isometric,
    offset: { x: offset.x, y: offset.y, z: offset.z }
  });
  // 地面中心（相对锚点的局部 x/z 中心，世界 y=0）；直接投影到画布。
  const groundX = (relative.min[0] + relative.max[0]) / 2;
  const groundZ = (relative.min[2] + relative.max[2]) / 2;
  const center = worldToCanvasPoint([anchor[0] + groundX, anchor[1], anchor[2] + groundZ]);
  const halfX = (relative.max[0] - relative.min[0]) / 2;
  const halfZ = (relative.max[2] - relative.min[2]) / 2;
  return expandGroundFootprint({ x: center.x, y: center.y }, halfX, halfZ, COMPOSITE_ASSET_SCOPE_MARGIN);
}

/** 空片场（无模型地面几何）回退：内接于基准矩形的正方形地面范围。 */
export function compositeAssetScopeBaseGround(x: number, y: number, width: number, height: number): ScopeGround {
  const ax = COMPOSITE_ASSET_SCOPE_AXIS_X;
  const ay = COMPOSITE_ASSET_SCOPE_AXIS_Y;
  const h = Math.max(1, Math.min(width / (4 * ax), height / (4 * ay)));
  return { cx: x + width / 2, cy: y + height / 2, hx: h, hz: h };
}

/**
 * 派生片场的范围几何（change: 2026-10-08-make-film-set-model-only 修订；
 *  change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
 *
 * 复合资产（片场、炼丹炉等）没有卡片：模型被居中并等比适配到节点矩形内。`x/y/width/height` 是
 * **内容适配基准矩形**；`scopeShape` 缺省即 `isometric-diamond`（复合资产类别默认），由
 * `scopeGround`（模型地面占地等比外扩固定边距）派生与地面网格平行的平行四边形（地面宽深相等
 * 时为菱形）作为可见与命中范围；仅当可信 adapter 覆盖为 `rect` 时该基准矩形才是可见范围
 * （Rust `canvas_query::scope` 在运行时按同一公式绘制/命中）。这是纯派生几何，不写规范文档、
 * 不进镜头成片。
 */
export function compositeAssetScopeForNode(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  scopeShape?: CompositeAssetScopeShape;
  emptyPlaceholder?: import("./wire-scene.js").CompositeAssetEmptyPlaceholder;
  geometryQuality?: CompositeAssetGeometryQuality;
  mediaPlanes?: readonly BevyModelMediaPlane[];
  itemRoots?: Record<string, string>;
  itemPlacements?: Record<string, BevyModelPlacement>;
  layoutAabb?: Aabb | null;
  rootPlacement?: BevyModelPlacement | null;
  contentExtent?: number;
}): BevyCompositeAssetPresentation {
  const { x: nodeX, y: nodeY, width, height } = input;
  // 最小可点击尺寸：无内容/极小节点也保留可命中范围。
  const w = Math.max(width, COMPOSITE_ASSET_SCOPE_MIN_HALF * 2);
  const h = Math.max(height, COMPOSITE_ASSET_SCOPE_MIN_HALF * 2);
  const scopeGround = input.scopeShape === "isometric-diamond"
    ? compositeAssetScopeGroundForNode({
        x: nodeX,
        y: nodeY,
        width,
        height,
        layoutAabb: input.layoutAabb,
        rootPlacement: input.rootPlacement,
        contentExtent: input.contentExtent
      }) ?? compositeAssetScopeBaseGround(nodeX, nodeY, width, height)
    : null;
  return {
    x: nodeX + width / 2 - w / 2,
    y: nodeY + height / 2 - h / 2,
    width: w,
    height: h,
    ...(input.scopeShape && input.scopeShape !== "rect" ? { scopeShape: input.scopeShape } : {}),
    // 总览 LOD 策略由可信 adapter 声明后注入；缺失即 World 用途保持 High
    // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    ...(input.emptyPlaceholder === "brand-plinth-v1" ? { emptyPlaceholder: input.emptyPlaceholder } : {}),
    ...(input.geometryQuality ? { geometryQuality: input.geometryQuality } : {}),
    ...(scopeGround ? { scopeGround } : {}),
    ...(input.mediaPlanes && input.mediaPlanes.length > 0 ? { mediaPlanes: [...input.mediaPlanes] } : {}),
    ...(input.rootPlacement ? { rootPlacement: input.rootPlacement } : {}),
    contentExtent: input.contentExtent ?? 2,
    ...(input.layoutAabb ? { layoutAabb: input.layoutAabb } : {}),
    ...(input.itemPlacements ? { itemPlacements: input.itemPlacements } : {}),
    ...(input.itemRoots && Object.keys(input.itemRoots).length > 0 ? { itemRoots: { ...input.itemRoots } } : {})
  };
}

/** 片场媒体平面默认高度（世界单位，竖直落地，保留宽高比）。 */
export const FILM_SET_MEDIA_PLANE_HEIGHT = 48;

/**
 * 纯模型节点等比适配结果（片场与通用扩展节点共用）。
 *
 * 片场（animation3d）与通用扩展节点（extension3d）共用同一「模型 + 媒体平面等比适配到
 * 节点矩形」规则（change: 2026-10-08-make-film-set-model-only 修订；
 * change: 2026-10-10-add-game-furnace-extension 泛化）。
 */
export function pureModelFit(input: {
  nodeId: string;
  data: CanvasNodeData | undefined;
  resource: PreparedModelResource | null;
  placement: BevyModelPlacement | null;
  width: number;
  height: number;
  readyPlaneIds: ReadonlySet<string>;
}): { fit: number; layoutAabb: Aabb | null; mediaPlanes: BevyModelMediaPlane[] } {
  const layoutAabb = filmSetLayoutBounds(input.resource?.ops ?? [], readFilmSetContent(input.data), input.resource?.extent ?? 2);
  const fit = filmSetFitFactor(
    {
      sceneVersion: input.resource?.sceneVersion ?? MODEL_SCRIPT_SCENE_IR_V2_VERSION,
      ops: (input.resource?.ops ?? []) as readonly SceneV2Op[],
      extent: input.resource?.extent ?? 1,
      aabb: layoutAabb ?? input.resource?.aabb ?? undefined,
      placement: input.placement
    },
    { width: input.width, height: input.height }
  );
  const mediaPlanes = filmSetMediaPlanesForNode({
    nodeId: input.nodeId,
    data: input.data,
    readyPlaneIds: input.readyPlaneIds,
    contentExtent: input.resource?.extent ?? 2
  });
  return { fit, layoutAabb, mediaPlanes };
}

export const EMPTY_PLANE_IDS: ReadonlySet<string> = new Set();

/**
 * 由片场 `filmSetContent` 派生媒体平面的**内容局部**几何
 * （change: 2026-10-08-make-film-set-model-only 修订；
 *  change: 2026-10-11-extract-film-set-extension D4/D7：共同 scenePlacement 根与统一世界链）。
 *
 * 输出与 `composeFilmSetScene` 组合出的**模型内容局部空间**同一坐标系：先应用各 media item 的
 * 局部 offset/scale/yaw，再应用共同 `scenePlacement` 根（offset + 等比 scale + Y yaw），每层只
 * 应用一次。平面竖直立于片场局部地面高度（局部 Y=0），`y` 为平面中心高度（含半高），保留资源
 * 固有宽高比。
 *
 * **不**在此嵌入画布/节点中心坐标：世界变换由 Rust 与模型/地面共用同一条根链
 * （`anchor + view_rotation × (unit × content)`）完成，使共同根平移/旋转/缩放不改变模型与媒体
 * 的相对位置。`unit` 由 Rust 按模型资源派生，这里只给内容局部量。返回按内容顺序稳定；纹理就绪
 * 状态由调用方注入。
 */
export function filmSetMediaPlanesForNode(input: {
  nodeId: string;
  data: CanvasNodeData | undefined;
  readyPlaneIds: ReadonlySet<string>;
  /**
   * 片场组合资源的规范 extent（`PreparedModelResource.extent`）。用于把「48 世界单位」的默认
   * 平面高度折算为内容单位：`contentHeight = 48 × extent / 192`，再由 Rust 的 `unit`（含
   * `192/extent` 自然单位）还原为原屏幕尺寸。缺省 2（空/单内容场景）。
   */
  contentExtent?: number;
}): BevyModelMediaPlane[] {
  const content = readFilmSetContent(input.data);
  const scenePlacement = decodeFilmSetLocalTransform((input.data as { scenePlacement?: unknown } | undefined)?.scenePlacement);
  const scene = scenePlacement.ok ? scenePlacement.value : { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
  const extent = Number.isFinite(input.contentExtent) && (input.contentExtent as number) > 0 ? (input.contentExtent as number) : 2;
  const cos = Math.cos(scene.yaw);
  const sin = Math.sin(scene.yaw);
  const planes: BevyModelMediaPlane[] = [];
  for (const item of content.items) {
    if (item.kind !== "image" && item.kind !== "video") continue;
    const id = `${input.nodeId}::${item.id}`;
    const ratio = Number.isFinite(item.aspectRatio) && item.aspectRatio > 0 ? item.aspectRatio : 1;
    // 内容单位平面高度（未含共同根 scale）：48 世界单位 ÷ 自然单位（192/extent）。
    const itemHeight = (FILM_SET_MEDIA_PLANE_HEIGHT * item.localTransform.scale * extent) / 192;
    // 共同根 scale 作用于整场（含 item 位置与尺寸）；每层只应用一次。
    const contentHeight = itemHeight * scene.scale;
    const contentWidth = contentHeight * ratio;
    // 内容局部中心：base = offset，竖直中心 = base + 半高；再应用共同根 offset + R_y(yaw)×scale。
    const localY = item.localTransform.offset.y + itemHeight / 2;
    const scaledX = item.localTransform.offset.x * scene.scale;
    const scaledY = localY * scene.scale;
    const scaledZ = item.localTransform.offset.z * scene.scale;
    const x = scene.offset.x + (scaledX * cos + scaledZ * sin);
    const y = scene.offset.y + scaledY;
    const z = scene.offset.z + (-scaledX * sin + scaledZ * cos);
    planes.push({
      id,
      kind: item.kind,
      itemId: item.id,
      unit: scene.scale,
      x,
      y,
      z,
      width: contentWidth,
      height: contentHeight,
      yaw: item.localTransform.yaw + scene.yaw,
      hasTexture: input.readyPlaneIds.has(id)
    });
  }
  return planes;
}
