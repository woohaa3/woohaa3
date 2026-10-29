/**
 * 模型 MCP 服务：脚本提交与通用命令
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 *
 * 权威 room 写入方；不改动外部状态。历史登记失败不阻断权威写入（由 reconciliation 补齐）。
 */
import { submitGroupAppearance } from "./group-appearance-submission.js";
import type { CanvasRoom } from "../sync/index.js";
import type { CanvasNodeData } from "@woohaa3/contracts";
import {
  hashModelScript,
  isSupportedModelScriptVersion,
  isFilmSetNode,
  isCompositeAssetNodeType,
  isModelAuthoringNodeType,
  MODEL_SCRIPT_LANGUAGE,
  PREFERRED_MODEL_SCRIPT_VERSION,
  decodeAnimationPayload,
  decodeModelPlacement,
  isGlbModelNodeData
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { executeSceneIr } from "./script-executor.js";
import { statisticsFromOps } from "./model-statistics.js";
import { readModelContentVersion } from "./model-reader.js";
import {
  hashText,
  MODEL_SCRIPT_MAX_CHARS,
  type ApplyCommandsInput,
  type ApplyCommandsOutcome,
  type ModelMcpServiceDependencies,
  type SubmitScriptInput,
  type SubmitScriptOutcome
} from "./service-types.js";

/** 稳定 commandId：同一 `(canvasId,nodeId,requestId)` 得到同一个 id。 */
export function defaultCommandId(input: SubmitScriptInput): string {
  return `model-script:${input.nodeId}:${hashText(`${input.canvasId}\u0000${input.requestId}`)}`;
}

export async function submitScript(
  deps: ModelMcpServiceDependencies,
  actorId: string,
  input: SubmitScriptInput
): Promise<SubmitScriptOutcome> {
  if (input.resource === "group-appearance") return submitGroupAppearance(deps, actorId, input);
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
  if (input.source.trim() === "") return { ok: false, code: "malformed-request", message: "脚本不能为空" };
  if (input.source.length > MODEL_SCRIPT_MAX_CHARS) {
    return { ok: false, code: "limit-exceeded", message: "脚本超过长度上限" };
  }

  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };

  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const node = exported.canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
  if (!isModelAuthoringNodeType(node.type)) {
    return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是可提交模型脚本的节点` };
  }
  // D8：片场不保存顶层 authored 模型；节点级脚本提交必须拒绝（几何经 item / 导入路径写入）。
  if (isFilmSetNode(node.type, exported.canvas.nodeData[nodeId] as CanvasNodeData | undefined)) {
    return { ok: false, code: "film-set-top-level-model", message: "片场节点不保存顶层模型，请提交到指定 model item" };
  }
  // 文件模型（GLB）以原始文件为唯一权威内容，不接受脚本写入
  // （change: 2026-10-28-support-glb-model-nodes）：混源会让展示内容不再对应原文件。
  if (isGlbModelNodeData(exported.canvas.nodeData[nodeId])) {
    return { ok: false, code: "model-source-glb", message: "文件模型不接受脚本提交；请上传新的 GLB 或使用脚本模型节点" };
  }
  if (!input.requestId || input.requestId.trim() === "") {
    return { ok: false, code: "malformed-request", message: `${node.type} 提交必须提供 requestId` };
  }

  const targetVersion = input.version ?? PREFERRED_MODEL_SCRIPT_VERSION;
  if (!isSupportedModelScriptVersion(targetVersion)) {
    return { ok: false, code: "unsupported-version", message: `不支持的模型脚本版本 ${String(targetVersion)}` };
  }
  const validation = await executeSceneIr(input.source, targetVersion, deps.scriptExecutor ?? {});
  if (!validation.ok) {
    return {
      ok: false,
      code: `model-script-${validation.stage}`,
      message: validation.message
    };
  }
  // 与聚焦信息面板同一统计口径：随提交结果返回，Agent 直接引用而不自行估算
  // （change: 2026-10-18-align-model-statistics-with-agent）。
  const { statistics, breakdown } = statisticsFromOps(validation.ops);

  const commandId = (deps.createCommandId ?? defaultCommandId)({
    canvasId,
    nodeId,
    source: input.source,
    requestId: input.requestId
  });
  const batch: CanvasCommandBatch = {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId,
    commandId,
    baseRevision: exported.canvas.revision,
    actorId,
    commands: [{
      type: "nodeData.patch",
      nodeId,
      value: {
        modelScript: input.source,
        modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
        modelScriptVersion: targetVersion
      }
    }]
  };

  const result = await room.submitDerived({
    commandId,
    derive: (canvas) => {
      const currentNode = canvas.document.nodes.find((entry) => entry.id === nodeId);
      if (!currentNode) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
      if (!isModelAuthoringNodeType(currentNode.type)) {
        return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点` };
      }
      if (isGlbModelNodeData(canvas.nodeData[nodeId])) {
        return { ok: false, code: "model-source-glb", message: "文件模型不接受脚本提交" };
      }
      if (input.expectedModelContentHash !== undefined) {
        const current = readModelContentVersion((canvas.nodeData[nodeId] as CanvasNodeData | undefined)?.modelContentVersion);
        if (input.expectedModelContentHash !== current?.contentHash) {
          return { ok: false, code: "stale-source", message: "模型内容已被并发修改" };
        }
      }
      return { ok: true, batch: { ...batch, baseRevision: canvas.revision } };
    }
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  await registerModelHistorySafely(deps, {
    canvasId,
    nodeId,
    sourceHash: hashModelScript(input.source),
    modelScript: input.source,
    language: MODEL_SCRIPT_LANGUAGE,
    version: targetVersion,
    createdAt: deps.now?.() ?? new Date().toISOString()
  });
  return {
    ok: true,
    canvasId,
    nodeId,
    commandId,
    idempotent: result.status === "duplicate" || result.noop,
    statistics,
    breakdown
  };
}

/**
 * 通用语义命令提交（change: split-model-mcp-into-mcp-service）。
 */
export async function applyCommands(
  deps: ModelMcpServiceDependencies,
  actorId: string,
  input: ApplyCommandsInput
): Promise<ApplyCommandsOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (input.commandId.trim() === "") return { ok: false, code: "malformed-request", message: "commandId 不能为空" };
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    return { ok: false, code: "malformed-request", message: "baseRevision 必须是非负整数" };
  }
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    return { ok: false, code: "malformed-request", message: "commands 必须是非空数组" };
  }

  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };

  const batch: CanvasCommandBatch = {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId,
    commandId: input.commandId,
    baseRevision: input.baseRevision,
    actorId,
    commands: input.commands
  };
  const result = await room.submit(batch);
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return {
    ok: true,
    canvasId,
    commandId: input.commandId,
    duplicate: result.status === "duplicate",
    noop: result.noop
  };
}

/** 历史登记：失败只记录、不阻断权威写入（由 reconciliation 补齐）。 */
export async function registerModelHistorySafely(
  deps: ModelMcpServiceDependencies,
  input: {
    canvasId: string;
    nodeId: string;
    sourceHash: string;
    modelScript: string;
    language: string;
    version: string;
    createdAt: string;
  }
): Promise<boolean> {
  const register = deps.registerModelHistory;
  if (!register) return false;
  try {
    const room = await deps.resolveRoom(input.canvasId);
    const exported = room?.exportCanvas();
    const node = exported?.ok ? exported.canvas.document.nodes.find((entry) => entry.id === input.nodeId) : undefined;
    const data = exported?.ok ? exported.canvas.nodeData[input.nodeId] as CanvasNodeData | undefined : undefined;
    const placement = decodeModelPlacement(data?.modelPlacement);
    const animation = isFilmSetNode(node?.type, data) ? decodeAnimationPayload(data) : null;
    await register({
      ...input,
      ...(node && (node.type === "model3d" || isCompositeAssetNodeType(node.type)) && data ? {
        modelScript: data.modelScript as string,
        sourceHash: hashModelScript(data.modelScript as string),
        language: data.modelScriptLanguage as string,
        version: data.modelScriptVersion as string
      } : {}),
      ...(node ? { nodeType: node.type } : {}),
      ...(placement ? { placement } : {}),
      ...(animation ? { animation } : {})
    });
    return true;
  } catch {
    return false;
  }
}

/** 供 facade 复用：room 端口类型。 */
export type { CanvasRoom };
