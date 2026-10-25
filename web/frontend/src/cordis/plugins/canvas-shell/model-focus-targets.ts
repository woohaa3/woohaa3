import { builtinNodeCapabilityResolver, type NodeCapabilityResolver } from "@woohaa3/contracts";
/**
 * 模型聚焦目标解析
 * （change: add-model-focus-viewing，任务 3.1；design D1/D3）。
 *
 * 把 model-scene provider 的 Scene IR、当前画布与本地视口/尺寸合成为 `FocusTargetInput`，
 * 供双击射线命中与目标失效判定复用。纯函数、无副作用；只读 canonical/working 投影，
 * 不写 ServerCanvas / CanvasCommand / Y.Doc。
 */
import {
  filmSetLayoutBounds,
  readFilmSetContent,
  isFilmSetNode,
  v2SceneExtent,
  MODEL_SCRIPT_SCENE_IR_V2_VERSION,
  type BevyModelPlacement,
  type PreparedModelResource,
  type SceneV2Op,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { FocusTargetInput } from "./model-focus-session.js";

export type ModelFocusTargetSource = {
  nodeCapabilities?: NodeCapabilityResolver;
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
  source: Pick<ModelFocusTargetSource, "canvas" | "resources" | "scenesV2" | "nodeCapabilities">,
  nodeId: string
): boolean {
  const node = source.canvas?.document.nodes.find(node => node.id === nodeId);
  return !!node && !!(source.nodeCapabilities ?? builtinNodeCapabilityResolver).resolve({ canvas: source.canvas!, node, data: source.canvas!.nodeData[nodeId] }).focus
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
    const capabilities = (source.nodeCapabilities ?? builtinNodeCapabilityResolver).resolve({ canvas, node, data: canvas.nodeData[node.id] });
    if (!capabilities.focus?.kind({ canvas, node, data: canvas.nodeData[node.id] })) continue;
    const placement = readPlacement(canvas.nodeData?.[node.id]);
    const nonCanonical = source.nonCanonicalNodes?.has(node.id) === true;
    const base = {
      canvas,
      capabilities,
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
