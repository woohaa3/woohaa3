/** Group appearance uses the same durable model receipt and room authority as model batches. */
import { createHash } from "node:crypto";
import {
  decodeGroupAppearance, deriveModelContentVersion, isFilmSetNode,
  MODEL_SCRIPT_LANGUAGE, PREFERRED_MODEL_SCRIPT_VERSION, readGroupAppearanceForNode,
  isSupportedModelScriptVersion,
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { currentCanvasGroupScope } from "../agent-authoring/group-scope.js";
import { executeSceneIr } from "./script-executor.js";
import { statisticsFromOps } from "./model-statistics.js";
import { MODEL_SCRIPT_MAX_CHARS, type ModelMcpServiceDependencies, type SubmitScriptInput, type SubmitScriptOutcome } from "./service-types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function submitGroupAppearance(
  deps: ModelMcpServiceDependencies, actorId: string, input: SubmitScriptInput,
): Promise<SubmitScriptOutcome> {
  if (!input.canvasId?.trim() || !input.nodeId?.trim() || !input.requestId?.trim() || !input.expectedContentHash?.trim() || !input.source?.trim())
    return { ok: false, code: "malformed-request", message: "组形象提交必须提供 canvasId、nodeId、requestId、expectedContentHash 和 source" };
  if (input.source.length > MODEL_SCRIPT_MAX_CHARS) return { ok: false, code: "limit-exceeded", message: "脚本超过长度上限" };
  const version = input.version ?? PREFERRED_MODEL_SCRIPT_VERSION;
  if (!isSupportedModelScriptVersion(version)) return { ok: false, code: "unsupported-version", message: "不支持的模型脚本版本" };
  const scope = currentCanvasGroupScope();
  const authorized = async () => !scope || (scope.valid() && scope.canvasId === input.canvasId && (!scope.authorize || await scope.authorize("write")));
  if (!await authorized()) return { ok: false, code: "group-scope-revoked", message: "组创作授权已失效" };
  const room = await deps.resolveRoom(input.canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: "画布不存在" };
  const principal = scope?.owner ?? actorId;
  const commandId = `group-appearance:${digest([principal, input.canvasId, input.nodeId, input.resource, input.requestId])}`;
  const submissionHash = digest([input.source, version, input.expectedContentHash]);
  // Retry before execution/preconditions: a later manual edit must not invalidate the first receipt.
  const prior = await room.lookupCommand(commandId);
  if (prior) return prior.modelBatch?.submissionHash === submissionHash
    ? { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId, idempotent: true, ...(prior.modelBatch.statistics ? { statistics: prior.modelBatch.statistics, breakdown: prior.modelBatch.breakdown } : {}) }
    : { ok: false, code: "request-id-reused", message: "同一 requestId 不能提交不同组形象" };
  const validation = await executeSceneIr(input.source, version, deps.scriptExecutor ?? {});
  if (!validation.ok) return { ok: false, code: `model-script-${validation.stage}`, message: validation.message };
  const result = await room.submitDerived({
    commandId, expectedModelBatchHash: submissionHash,
    derive(canvas) {
      const node = canvas.document.nodes.find(n => n.id === input.nodeId);
      if (!node || (node.type !== "group" && !isFilmSetNode(node.type, canvas.nodeData[node.id])))
        return { ok: false, code: "invalid-node-type", message: "目标不是组或片场" };
      const current = readGroupAppearanceForNode(canvas.nodeData[node.id]);
      if (current.value.model.contentVersion.contentHash !== input.expectedContentHash)
        return { ok: false, code: "stale-source", message: "组形象已被并发修改，请重新读取" };
      const model = { ...current.value.model, modelScript: input.source, modelScriptLanguage: MODEL_SCRIPT_LANGUAGE, modelScriptVersion: version };
      model.contentVersion = deriveModelContentVersion({ ...model, revision: model.contentVersion.revision + 1 });
      const decoded = decodeGroupAppearance({ schemaVersion: 1, model });
      if (!decoded.ok) return { ok: false, code: "invalid-group-appearance", message: decoded.reason };
      return {
        ok: true,
        modelBatch: { submissionHash, ...statisticsFromOps(validation.ops), nodes: [{ nodeId: node.id, modelContentVersion: model.contentVersion,
          validation: "passed", geometry: { min: null, max: null, operationCount: validation.ops.length }, cameraCount: 0, camerasHash: digest([]) }] },
        batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: canvas.id, commandId, actorId,
          baseRevision: canvas.revision, commands: [{ type: "nodeData.patch", nodeId: node.id, value: { groupAppearance: decoded.value } }] },
      };
    },
  }, { authorize: authorized });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId, idempotent: result.status === "duplicate" || result.noop, ...statisticsFromOps(validation.ops) };
}
