/**
 * 拍摄镜头预览的宿主选择集保护（纯判定）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.5 / design D2）。
 *
 * 预览节点由源镜头生命周期维护，**不能**被当作普通节点单独删除、剪切、复制、重命名、打组、
 * 下载或转片场。宿主输入层只做**选择集过滤**与菜单可见性判定；真正的权威拒绝在共享 reducer
 * （`node.remove` / `nodeData.patch` / `edit.apply` 的受保护路径）。
 *
 * 这些是纯函数：只读节点结构身份与 `shotPreview` 归属，不写画布、不发命令，便于非渲染回归。
 */
import { decideContentAction, FILM_SET_SHOT_PREVIEW_NODE_TYPE, shotPreviewOwnershipOf, type ContentContributionResolver, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";

export type SelectableNode = { id: string; type: string };

/** 单个节点是否为本画布中受保护的拍摄镜头预览。 */
export function isProtectedShotPreviewNode(input: {
  node: SelectableNode | undefined;
  nodeData: Readonly<Record<string, Woohaa3CanvasJsonObject | undefined>>;
  content?: ContentContributionResolver;
}): boolean {
  if (!input.node) return false;
  if (input.content) {
    return !decideContentAction(input.content, "delete", input.node.type, input.nodeData[input.node.id]).allowed;
  }
  if (input.node.type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE) return false;
  return shotPreviewOwnershipOf(input.nodeData[input.node.id]) !== null;
}

/**
 * 把选择集切成「受保护预览」与「普通可操作节点」两组，保持各自原有顺序。
 *
 * 删除选择集据此过滤：可以删除其中的普通节点，但要提示预览需在拍摄镜头管理中删除；底层
 * `node.remove` 若只剩受保护预览则由 reducer 明确拒绝（不静默无操作）。
 */
export function partitionShotPreviewSelection(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly SelectableNode[];
  nodeData: Readonly<Record<string, Woohaa3CanvasJsonObject | undefined>>;
  content?: ContentContributionResolver;
}): { previewIds: string[]; others: string[] } {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const previewIds: string[] = [];
  const others: string[] = [];
  for (const id of input.selectedNodeIds) {
    if (isProtectedShotPreviewNode({ node: byId.get(id), nodeData: input.nodeData, content: input.content })) previewIds.push(id);
    else others.push(id);
  }
  return { previewIds, others };
}

/** 选择集是否全部为受保护预览（此时复制/剪切/独立删除请求明确拒绝）。 */
export function isShotPreviewOnlySelection(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly SelectableNode[];
  nodeData: Readonly<Record<string, Woohaa3CanvasJsonObject | undefined>>;
  content?: ContentContributionResolver;
}): boolean {
  if (input.selectedNodeIds.length === 0) return false;
  const { previewIds, others } = partitionShotPreviewSelection(input);
  return others.length === 0 && previewIds.length > 0;
}

/** 预览保护提示文案：说明它属于拍摄镜头，需在拍摄镜头管理中删除。 */
export const SHOT_PREVIEW_DELETE_HINT = "拍摄镜头预览需在拍摄镜头管理中删除";
/** 复制/剪切提示文案。 */
export const SHOT_PREVIEW_CLIPBOARD_HINT = "拍摄镜头预览不能单独复制或剪切；复制所属片场会一并复制其镜头";
/** 选择集混合时的删除提示（其余节点已删除，预览保留）。 */
export const PARTITION_SELECTION_DELETE_HINT = "已删除其余作品；拍摄镜头预览需在拍摄镜头管理中删除";
