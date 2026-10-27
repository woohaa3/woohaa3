/** Run explicit appearance candidates inside the existing bounded script executor before any durable write. */
import { decodeGroupAppearance, type CanvasCommand, type CanvasNodeData, type ServerCanvas } from "@woohaa3/contracts";
import { executeSceneIr } from "../model-mcp/script-executor.js";
export async function validateGroupAppearanceCommands(canvas: ServerCanvas, commands: readonly CanvasCommand[]): Promise<string | null> {
  const candidates: Array<{ nodeId: string; type?: string; data?: CanvasNodeData | null }> = [];
  const typeOf = (nodeId: string) => canvas.document.nodes.find(node => node.id === nodeId)?.type;
  for (const command of commands) {
    if (command.type === "nodeData.patch") candidates.push({ nodeId: command.nodeId, type: typeOf(command.nodeId), data: command.value });
    if (command.type === "node.add") candidates.push({ nodeId: command.node.id, type: command.node.type, data: command.nodeData });
    if (command.type === "edit.apply") for (const op of command.operations) {
      if (op.kind === "node-add") candidates.push({ nodeId: op.node.id, type: op.node.type, data: op.nodeData });
      if (op.kind === "node-data-set") candidates.push({ nodeId: op.nodeId, type: typeOf(op.nodeId), data: op.value });
    }
  }
  for (const { nodeId, type, data } of candidates) {
    if (data?.groupAppearance === undefined || JSON.stringify(data.groupAppearance) === JSON.stringify(canvas.nodeData[nodeId]?.groupAppearance)) continue;
    // `groupAppearance` 只属于普通组；片场及未来复合资产的自身模型由各自内容决定。
    if (type !== "group") return "groupAppearance 只属于普通组节点";
    const appearance = decodeGroupAppearance(data.groupAppearance);
    if (!appearance.ok) return appearance.reason;
    const execution = await executeSceneIr(appearance.value.model.modelScript, appearance.value.model.modelScriptVersion);
    if (!execution.ok) return execution.message;
  }
  return null;
}
