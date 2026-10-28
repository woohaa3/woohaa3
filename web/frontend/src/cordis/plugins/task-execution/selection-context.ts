/**
 * 选中上下文解析（change: add-image-text-node-execution，任务 3.2）。
 *
 * 运行时只上报节点 ID；节点类型、prompt、parameters、任务状态一律从**规范 Canvas Store**
 * 读取。因此：
 * - 失效 ID（节点已删除）→ `null`，页面清空执行面板；
 * - 不支持的类型 → `null`；
 * - 运行时上报的业务数据一律不参与（它只有渲染缓存，可能旧于规范状态）。
 *
 * 纯函数，方便在无 DOM 环境下断言「已删除节点」等场景。
 */
import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import { groupAllowsExecutionPanel, isModelNodeType } from "@woohaa3/contracts";
import { panelKindForNodeType, type NodePanelKind } from "./node-panel-registry.js";

export type NodeSelectionContext = {
  nodeId: string;
  nodeType: string;
  /** 普通生成任务有 panelKind；3D 模型节点仅显示参数面板，因此为 null。 */
  panelKind: NodePanelKind | null;
  /** 规范 nodeData；节点存在时至少是空对象。 */
  nodeData: CanvasNodeData;
};

export function resolveSelectionContext(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null | undefined
): NodeSelectionContext | null {
  if (!canvas || !nodeId) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const panelKind = panelKindForNodeType(node.type);
  if (!panelKind && !isModelNodeType(node.type) && node.type !== "group") return null;
  const nodeData = (canvas.nodeData as Record<string, CanvasNodeData | undefined>)[nodeId];
  if (node.type === "group" && !groupAllowsExecutionPanel(nodeData)) return null;
  return {
    nodeId,
    nodeType: node.type,
    panelKind,
    nodeData: nodeData ?? {}
  };
}
