/**
 * 模型 MCP 服务：应用结果上报与历史 reconciliation
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";
import { hashModelScript, isModelAuthoringNodeType, isSupportedModelScript } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { registerModelHistorySafely } from "./script-submission.js";
import { hashText, type ModelMcpServiceDependencies, type ReportScriptOutcome } from "./service-types.js";

/**
 * 上报运行时应用脚本的结果。
 */
export async function reportScript(
  deps: ModelMcpServiceDependencies,
  actorId: string,
  input: { canvasId: string; nodeId: string; status: "ok" | "failed"; message?: string }
): Promise<ReportScriptOutcome> {
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

  const commandId = `model-script-report:${nodeId}:${input.status}:${hashText(input.message ?? "")}`;
  const value: CanvasNodeData =
    input.status === "ok"
      ? { modelScriptStatus: "ok", modelScriptError: null }
      : {
          modelScriptStatus: "failed",
          modelScriptError: input.message ?? "模型脚本应用失败"
        };
  const result = await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId,
    commandId,
    baseRevision: exported.canvas.revision,
    actorId,
    commands: [{ type: "nodeData.patch", nodeId, value }]
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true, canvasId, nodeId, commandId };
}

/**
 * 补齐模型历史登记（reconciliation）。
 */
export async function reconcileModelHistory(
  deps: ModelMcpServiceDependencies,
  input: { canvasId: string; nodeId: string }
): Promise<{ ok: boolean; recorded: boolean }> {
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  if (canvasId === "" || nodeId === "") return { ok: false, recorded: false };
  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, recorded: false };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, recorded: false };
  const node = exported.canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node || !isModelAuthoringNodeType(node.type)) return { ok: false, recorded: false };
  const data = exported.canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const source = typeof data?.modelScript === "string" ? data.modelScript : "";
  if (source.trim() === "") return { ok: false, recorded: false };
  const descriptor = { language: data?.modelScriptLanguage, version: data?.modelScriptVersion };
  if (!isSupportedModelScript(descriptor)) return { ok: false, recorded: false };
  const recorded = await registerModelHistorySafely(deps, {
    canvasId,
    nodeId,
    sourceHash: hashModelScript(source),
    modelScript: source,
    language: descriptor.language as string,
    version: descriptor.version as string,
    createdAt: deps.now?.() ?? new Date().toISOString()
  });
  return { ok: true, recorded };
}
