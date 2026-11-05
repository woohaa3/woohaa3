/**
 * 节点取消选择时是否直接收起 Agent 对话详情右侧面板。
 *
 * 详情面板是右侧常驻侧栏：打开后会一直保留，直到用户显式关闭。用户清空选择（取消选中
 * 节点）后，该面板已经不再对应任何画布目标，应直接消失，而不是留在画布右侧等用户再点
 * 一次「关闭」。切换节点仍由选择协调器打开目标节点自己的面板，不在此处理。
 */
import type { CanvasPanelRoute } from "../../navigation/contracts.js";

export function shouldDismissAgentDetailOnDeselect(input: {
  /** 上一次选择的主节点；null 表示此前没有选中节点。 */
  previousNodeId: string | null;
  /** 本次选择的主节点；取消选择后为 null。 */
  nextNodeId: string | null;
  /** 当前已打开的 panel route。 */
  panel: CanvasPanelRoute | null;
}): boolean {
  return input.previousNodeId !== null
    && input.nextNodeId === null
    && input.panel?.type === "agent-conversation";
}
