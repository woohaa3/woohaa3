/**
 * 模型 MCP 服务：模型规模统计读取与候选预检
 * （change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * 权威读：从 published 节点数据取当前 `modelScript`，用与提交相同的 executor 运行后统计；
 * 候选：只运行传入 source，不写画布、不占 requestId、不推进 revision。
 *
 * 数值与模型聚焦信息面板共用 `modelSceneStatistics`，因此 Agent 报出的点数/面数与面板一致。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";
import {
  isModelAuthoringNodeType,
  isSupportedModelScriptVersion,
  PREFERRED_MODEL_SCRIPT_VERSION
} from "@woohaa3/contracts";
import { statisticsForSource } from "./model-statistics.js";
import type {
  ModelMcpServiceDependencies,
  ModelStatisticsInput,
  ModelStatisticsOutcome
} from "./service-types.js";

/** 读取当前脚本或候选脚本的模型规模；只读，不写画布。 */
export async function getModelStatistics(
  deps: ModelMcpServiceDependencies,
  input: ModelStatisticsInput
): Promise<ModelStatisticsOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };

  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const node = exported.canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
  if (!isModelAuthoringNodeType(node.type)) {
    return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点` };
  }

  const data = exported.canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const currentVersion = data?.modelScriptVersion;
  const candidate = typeof input.source === "string";
  const source = candidate
    ? input.source as string
    : typeof data?.modelScript === "string"
      ? data.modelScript
      : "";
  if (source.trim() === "") {
    return {
      ok: false,
      code: "no-model-script",
      message: candidate ? "候选脚本不能为空" : `节点 ${nodeId} 尚无模型脚本`
    };
  }
  // 候选默认沿用节点当前版本；节点无版本时用首选版本。
  const version = isSupportedModelScriptVersion(currentVersion)
    ? currentVersion
    : PREFERRED_MODEL_SCRIPT_VERSION;

  const outcome = await statisticsForSource(deps, source, version);
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  return {
    ok: true,
    canvasId,
    nodeId,
    source: candidate ? "candidate" : "current",
    statistics: outcome.detail.statistics,
    breakdown: outcome.detail.breakdown
  };
}
