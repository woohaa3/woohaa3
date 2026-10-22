/**
 * 模型聚焦目标解析
 * （change: add-model-focus-viewing，任务 3.1；design D1/D3）。
 *
 * 把 model-scene provider 的 Scene IR、当前画布与本地视口/尺寸合成为 `FocusTargetInput`，
 * 供双击射线命中与目标失效判定复用。纯函数、无副作用；只读 canonical/working 投影，
 * 不写 ServerCanvas / CanvasCommand / Y.Doc。
 */
import {
  bevyKindForNodeType,
  filmSetLayoutBounds,
  readFilmSetContent,
  isFilmSetNode,
  isCompositeAssetNodeType,
  v2SceneExtent,
  MODEL_SCRIPT_SCENE_IR_V2_VERSION,
  type BevyModelPlacement,
  type PreparedModelResource,
  type SceneV2Op,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { FocusTargetInput } from "./model-focus-session.js";

/**
 * 可承载 3D 模型**聚焦查看**的节点类型
 * （change: 2026-10-11-extract-film-set-extension：复合资产类别收敛）。
 *
 * 与 `bevyKindForNodeType` 的 model 映射一致：`model3d` 与 `composite-asset`（片场/炉体）。
 */
export function isModelNodeType(type: string): boolean {
  return bevyKindForNodeType(type) === "model";
}

/**
 * 是否进入**宿主模型参数编辑器**聚焦（`model3d` 与片场业务）。
 *
 * 游戏炼丹炉等其他复合资产业务的聚焦工作区由 extension 拥有（双击经 Navigation 进入
 * extension 工作区），因此 MUST NOT 触发宿主模型编辑器面板
 * （change: 2026-10-11-extract-film-set-extension，D11 严格业务判别）。
 */
export function isModelEditorNodeType(type: string, data?: unknown): boolean {
  return type === "model3d" || isFilmSetNode(type, data);
}

/**
 * 双击/聚焦 3D 节点时请求的 Navigation focus kind
 * （change: 2026-10-11-extract-film-set-extension，D11）。
 *
 * 游戏炼丹炉等其他复合资产业务聚焦到 `"extension"` 工作区（由 extension 贡献）；其余
 * 3D 节点（`model3d` 与片场）沿用宿主 `"model"` 聚焦查看/编辑。
 */
export function focusKindForModelNodeType(type: string, data?: unknown): "model" | "extension" {
  if (isFilmSetNode(type, data) || type === "model3d") return "model";
  if (isCompositeAssetNodeType(type)) return "extension";
  return "model";
}

export type ModelFocusTargetSource = {
  /** 当前绘制画布（working projection 优先；命中与渲染同源）。 */
  canvas: ServerCanvas | null;
  viewport: { x: number; y: number; zoom: number };
  surface: { width: number; height: number };
  /**
   * 每节点的 prepared model resource（含已派生 extent/AABB，避免重复遍历）
   * （change: optimize-model-scene-snapshot-hot-path）。
   */
  resources?: ReadonlyMap<string, PreparedModelResource>;
  /** V2 模型 Scene IR（change: 2026-10-07-remove-residual-compatibility —— V2-only）。 */
  scenesV2?: ReadonlyMap<string, SceneV2Op[]>;
  /**
   * 非 canonical 临时模型快照节点集合（change: add-model-focus-editing，任务 3.4）。
   * 缺省为空；这些节点仍可聚焦查看但禁止 placement 编辑。
   */
  nonCanonicalNodes?: ReadonlySet<string>;
};

/** 只检查目标成员资格，不派生 placement、extent 或布局包围盒。 */
export function hasModelFocusTarget(
  source: Pick<ModelFocusTargetSource, "canvas" | "resources" | "scenesV2">,
  nodeId: string
): boolean {
  const node = source.canvas?.document.nodes.find(node => node.id === nodeId);
  return !!node && isModelNodeType(node.type)
    && !!(source.resources?.get(nodeId) || source.scenesV2?.get(nodeId));
}

/**
 * 解析所有可聚焦模型目标。缺少合法 Scene IR 的节点不产生目标，因此不会进入空白聚焦场景。
 */
export function resolveModelFocusTargets(source: ModelFocusTargetSource): FocusTargetInput[] {
  const canvas = source.canvas;
  if (!canvas) return [];
  const targets: FocusTargetInput[] = [];
  for (const node of canvas.document.nodes) {
    if (!isModelNodeType(node.type)) continue;
    const placement = readPlacement(canvas.nodeData?.[node.id]);
    const nonCanonical = source.nonCanonicalNodes?.has(node.id) === true;
    const base = {
      canvas,
      nodeId: node.id,
      viewport: source.viewport,
      surface: source.surface,
      placement,
      ...(nonCanonical ? { nonCanonical } : {})
    };
    // prepared resource 优先：直接复用已派生 extent/AABB，避免重复遍历 mesh 顶点。
    const resource = source.resources?.get(node.id);
    if (resource) {
      targets.push({
        ...base,
        sceneVersion: resource.sceneVersion,
        ops: resource.ops,
        extent: resource.extent,
        aabb: isFilmSetNode(node.type, canvas.nodeData?.[node.id]) ? filmSetLayoutBounds(resource.ops, readFilmSetContent(canvas.nodeData?.[node.id]), resource.extent) : resource.aabb
      });
      continue;
    }
    const opsV2 = source.scenesV2?.get(node.id);
    if (opsV2) {
      targets.push({
        ...base,
        sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION,
        ops: opsV2,
        extent: v2SceneExtent(opsV2)
      });
    }
  }
  return targets;
}

/** 从 nodeData 读取参考格式的 modelPlacement（与 render-scene 同源）。 */
function readPlacement(data: unknown): BevyModelPlacement | null {
  if (!data || typeof data !== "object") return null;
  const placement = (data as { modelPlacement?: unknown }).modelPlacement;
  if (!placement || typeof placement !== "object") return null;
  const record = placement as Record<string, unknown>;
  const offset = (record.offset as Record<string, unknown> | undefined) ?? {};
  return {
    offset: { x: finite(offset.x) ?? 0, y: finite(offset.y) ?? 0, z: finite(offset.z) ?? 0 },
    scale: finite(record.scale) ?? 1,
    yaw: finite(record.yaw) ?? 0
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
