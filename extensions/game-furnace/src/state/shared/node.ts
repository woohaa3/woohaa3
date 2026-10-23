import { createModel3DNodeData, model3DNodeDataFields, MODEL_SCRIPT_V2_VERSION, type CanvasNodeData } from "@woohaa3/contracts";

export function createGameFurnaceNodeDataWithScript(modelScript: string, title: string = "游戏炼丹炉"): CanvasNodeData {
  return { extensionId: "game-furnace", scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, ...model3DNodeDataFields(createModel3DNodeData({
    title,
    model: { modelScript, modelScriptVersion: MODEL_SCRIPT_V2_VERSION }
  })) } as CanvasNodeData;
}

/** 仅接受显式业务身份；旧节点由隔离离线迁移识别。 */
export function isGameFurnaceNodeData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record.extensionId === "game-furnace";
}
