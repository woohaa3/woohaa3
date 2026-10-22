/**
 * Model Execution Host 选择上下文
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1 / design D4）。
 *
 * 从 working/canonical 投影解析选中节点、panelKind 与 nodeData；随后由 resolver 决定
 * 渲染哪个已注册 Model Interaction Panel。Host 不做 audio/video/edit_video 专用布局判断。
 */
import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import { isModelNodeType } from "@woohaa3/contracts";
import { panelKindForNodeType, type NodePanelKind } from "./node-panel-registry.js";

export type ModelExecutionContext = {
  nodeId: string;
  nodeType: string;
  /** 普通生成任务有 panelKind；仅参数面板节点为 null。 */
  panelKind: NodePanelKind | null;
  nodeData: CanvasNodeData;
};

export type { NodePanelKind };

export function resolveModelExecutionContext(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null | undefined
): ModelExecutionContext | null {
  if (!canvas || !nodeId) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const panelKind = panelKindForNodeType(node.type);
  if (!panelKind && !isModelNodeType(node.type)) return null;
  const nodeData = (canvas.nodeData as Record<string, CanvasNodeData | undefined>)[nodeId];
  return {
    nodeId,
    nodeType: node.type,
    panelKind,
    nodeData: nodeData ?? {}
  };
}
