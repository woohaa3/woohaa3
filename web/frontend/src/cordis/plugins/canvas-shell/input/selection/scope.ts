/**
 * 组／导演区的点选优先级（点击子元素先选中容器）。
 *
 * 画布上的成员卡片、世界模型与镜头都画在组框/导演区之上，命中天然先落到子元素。
 * 这里把「点击进入容器」的判定抽成纯函数：子元素所属的组（显式成员表）或导演区
 * （地面范围包含世界位置）尚未被选中时，第一次点击选中容器；容器已在选区里，或
 * 当前选区已经包含同一容器内的其它子元素时，直接选中/拖动子元素。
 *
 * 只描述选择语义，不读 store、不发命令；2D 组按 `memberNodeIds`（权威成员表），
 * 导演区按 `sceneArea.bounds` 与子元素的世界地面位置。镜头的 2D 卡片不参与容器优先：
 * 点卡片直接选中镜头，只有 3D 机位/视锥拾取才先选中容器。
 */
import {
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  decodeWorldCamera,
  decodeWorldInstanceData,
  type GroundAabb,
  type GroundPoint,
  type ServerCanvas
} from "@woohaa3/contracts";

function inside(bounds: GroundAabb, point: GroundPoint): boolean {
  return point.u >= bounds.min.u && point.u <= bounds.max.u
    && point.v >= bounds.min.v && point.v <= bounds.max.v;
}

/** 子元素的世界地面位置（导演区用）；没有世界身份的卡片返回 `null`。 */
function worldGroundPointOf(canvas: ServerCanvas, nodeId: string): GroundPoint | null {
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  if (!data) return null;
  const instance = decodeWorldInstanceData(data.sharedWorldInstance);
  if (instance.ok) {
    const { u, v } = instance.value.transform.position;
    return { u, v };
  }
  const camera = decodeWorldCamera(data.worldCamera);
  if (camera.ok) {
    const { u, v } = camera.value.position;
    return { u, v };
  }
  return null;
}

/**
 * 镜头的 2D 卡片直接选中镜头本身，不先进入所属组/导演区。
 *
 * 镜头同时有 2D 卡片和 3D 机位：点卡片是明确的“选这个镜头”，只有渲染器拾取到
 * 3D 机位/视锥时才继续遵守容器优先，避免把卡片点击也当成“先选片场”。
 */
export function selectsCardDirectly(
  canvas: ServerCanvas | null,
  nodeId: string,
  via: "card" | "pick"
): boolean {
  return via === "card" && canvas?.nodeData?.[nodeId]?.worldCamera !== undefined;
}

/**
 * 节点所属的创作容器：显式 2D 组成员优先，其次包含其世界位置的最小导演区。
 *
 * 2D 组不嵌套、导演区可能重叠，因此取包含面积最小的区作为最内层容器。
 */
export function enclosingAuthoringScope(canvas: ServerCanvas | null, nodeId: string): string | null {
  if (!canvas) return null;
  for (const node of canvas.document.nodes) {
    if (node.type !== "workflow-group-2d") continue;
    const decoded = decodeWorkflowGroupData(canvas.nodeData[node.id]?.workflowGroup2d);
    if (decoded.ok && decoded.value.memberNodeIds.includes(nodeId)) return node.id;
  }
  const point = worldGroundPointOf(canvas, nodeId);
  if (!point) return null;
  let best: { nodeId: string; area: number } | null = null;
  for (const node of canvas.document.nodes) {
    if (node.type !== "scene-area") continue;
    const decoded = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
    if (!decoded.ok || !inside(decoded.value.bounds, point)) continue;
    const { min, max } = decoded.value.bounds;
    const area = (max.u - min.u) * (max.v - min.v);
    if (!best || area < best.area) best = { nodeId: node.id, area };
  }
  return best?.nodeId ?? null;
}

/**
 * 当前选区里是否已有同一容器内的其它子元素。
 *
 * 这是「已经进入该容器」的另一种形态：用户先选中了导演区内的模型 A，再点同区的
 * 模型 B 时不应重新退回导演区。只比较子元素的所属容器，不把容器自身算作兄弟。
 */
export function hasSelectedSiblingInScope(
  canvas: ServerCanvas | null,
  selected: readonly string[],
  scopeId: string | null
): boolean {
  if (!canvas || !scopeId) return false;
  return selected.some((id) => id !== scopeId && enclosingAuthoringScope(canvas, id) === scopeId);
}

/**
 * 本次按下应当优先选中的容器 id；返回 `null` 表示按原逻辑处理该子元素。
 *
 * - 附加选择（Shift）保持原有加选语义，不抢先选容器；
 * - 子元素本身已在选区（例如框选后拖动）时不改变选择；
 * - 容器已在选区说明是「再次点击」；
 * - 同容器内已有其它子元素被选中，说明用户已经进入该容器；
 * - 以上情况都交给原有逻辑选中子元素。
 */
export function scopeSelectionPrecedence(input: {
  canvas: ServerCanvas | null;
  nodeId: string | null | undefined;
  selected: readonly string[];
  additive?: boolean;
  /** 已由目标归一化算出的容器；缺省时现场解析，避免同一按下重复扫描。 */
  scopeId?: string | null;
}): string | null {
  if (input.additive || !input.nodeId || input.selected.includes(input.nodeId)) return null;
  const scope = input.scopeId !== undefined
    ? input.scopeId
    : enclosingAuthoringScope(input.canvas, input.nodeId);
  if (!scope || input.selected.includes(scope) || hasSelectedSiblingInScope(input.canvas, input.selected, scope)) return null;
  return scope;
}
