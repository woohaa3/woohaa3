/** Run explicit appearance candidates inside the existing bounded script executor before any durable write. */
import { decodeGroupAppearance, type CanvasCommand, type CanvasNodeData, type ServerCanvas } from "@woohaa3/contracts";
import { executeSceneIr } from "../model-mcp/script-executor.js";
export async function validateGroupAppearanceCommands(canvas: ServerCanvas, commands: readonly CanvasCommand[]): Promise<string | null> {
  const candidates: Array<{ nodeId: string; data?: CanvasNodeData | null }> = [];
  for (const command of commands) {
    if (command.type === "nodeData.patch") candidates.push({ nodeId: command.nodeId, data: command.value });
    if (command.type === "node.add") candidates.push({ nodeId: command.node.id, data: command.nodeData });
    if (command.type === "edit.apply") for (const op of command.operations) {
      if (op.kind === "node-add") candidates.push({ nodeId: op.node.id, data: op.nodeData });
      if (op.kind === "node-data-set") candidates.push({ nodeId: op.nodeId, data: op.value });
    }
  }
  for (const { nodeId, data } of candidates) {
    if (data?.groupAppearance === undefined || JSON.stringify(data.groupAppearance) === JSON.stringify(canvas.nodeData[nodeId]?.groupAppearance)) continue;
    const appearance = decodeGroupAppearance(data.groupAppearance);
    if (!appearance.ok) return appearance.reason;
    const execution = await executeSceneIr(appearance.value.model.modelScript, appearance.value.model.modelScriptVersion);
    if (!execution.ok) return execution.message;
  }
  return null;
}
