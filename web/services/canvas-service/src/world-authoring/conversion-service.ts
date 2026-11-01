import { createHash } from "node:crypto";
import { decodeModelPlacement, effectiveCanvasNodeSize, isGlbModelNodeData, legacyModelGroundTransform, v2SceneAabb, planCanvasEdit, SHARED_WORLD_VERSION,
  type ServerCanvas, type WorldConversionCommitInput, type WorldConversionCommitOutcome, type WorldConversionPrepareInput, type WorldConversionPrepareOutcome } from "@woohaa3/contracts";
import type { CanvasRoom } from "../sync/room.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { executeSceneIr } from "../model-mcp/script-executor.js";

const failure = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return item;
});
export const worldConversionNodeVersion = (node: unknown, nodeData: unknown): string =>
  createHash("sha256").update(stable({ node, nodeData: nodeData ?? null })).digest("hex");

export function createWorldConversionService(resolveRoom: (id: string) => Promise<CanvasRoom | null>) {
  return { async commit(input: WorldConversionCommitInput, options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }): Promise<WorldConversionCommitOutcome> {
    const validString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
    if (!input || Object.keys(input).sort().join(",") !== "canvasId,operationId,sourceVersion,targets" || !validString(input.canvasId) || !validString(input.operationId) || !validString(input.sourceVersion) || !Array.isArray(input.targets) || !input.targets.length || input.targets.some(t => !t || Object.keys(t).sort().join(",") !== "instanceId,nodeId,nodeVersion" || !validString(t.nodeId) || !validString(t.nodeVersion) || !validString(t.instanceId)) || new Set(input.targets.map(t => t.nodeId)).size !== input.targets.length || new Set(input.targets.map(t => t.instanceId)).size !== input.targets.length)
      return failure("malformed-request", "转换请求无效");
    const targets = [...input.targets].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
    const hash = createHash("sha256").update(stable({ canvasId: input.canvasId, sourceVersion: input.sourceVersion, targets })).digest("hex");
    const commandId = `world-conversion:${input.operationId}`;
    const room = await resolveRoom(input.canvasId);
    if (!room) return failure("canvas-not-found", "画布不存在");
    const result = await room.submitDerived({ commandId, expectedModelBatchHash: hash, async derive(canvas) {
      if (String(canvas.revision) !== input.sourceVersion) return failure("version-conflict", "画布版本已变化");
      if (options?.signal?.aborted) return failure("cancelled", "提交已取消");
      const byId = new Map(canvas.document.nodes.map(node => [node.id, node]));
      if (targets.some(target => worldConversionNodeVersion(byId.get(target.nodeId), canvas.nodeData[target.nodeId]) !== target.nodeVersion)) return failure("version-conflict", "节点版本已变化");
      const existingIds = new Set(Object.values(canvas.nodeData).map(data => {
        const value = data?.sharedWorldInstance;
        return value && typeof value === "object" && !Array.isArray(value) ? value.instanceId : undefined;
      }).filter(Boolean));
      if (targets.some(t => existingIds.has(t.instanceId))) return failure("instance-id-conflict", "实例身份已存在");
      const prepared = await prepareCanvas(canvas, input.canvasId, targets.map(t => t.nodeId), options);
      if (!prepared.ok) return prepared;
      if (prepared.nodes.some((node, i) => node.nodeVersion !== targets[i]!.nodeVersion)) return failure("version-conflict", "节点版本已变化");
      const frozen = targets.map((target, i) => ({ ...target, transform: prepared.nodes[i]!.transform }));
      const commands = frozen.map(target => ({ type: "nodeData.patch" as const, nodeId: target.nodeId, value: { sharedWorldInstance: JSON.parse(JSON.stringify({ kind: "world-instance", version: SHARED_WORLD_VERSION, instanceId: target.instanceId, transform: target.transform })) } }));
      const plan = planCanvasEdit(canvas, commands);
      if (!plan.ok) return failure("invalid-edit", plan.reason);
      const sourceFields = ["modelScript", "modelScriptLanguage", "modelScriptVersion", "modelSourceKind", "modelAssetId", "modelPlacement"] as const;
      for (const target of targets) {
        const data = canvas.nodeData[target.nodeId]!;
        const fields = sourceFields.map(field => data[field] === undefined
          ? { field, present: false as const }
          : { field, present: true as const, value: structuredClone(data[field]) });
        for (const side of [plan.forward, plan.inverse]) side.preconditions.push({ kind: "node-data-fields", nodeId: target.nodeId, fields });
      }
      const receipt = { targets: frozen, forward: plan.forward, inverse: plan.inverse };
      return { ok: true as const, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, commandId, actorId: "world-conversion", baseRevision: canvas.revision, commands: [{ type: "edit.apply" as const, ...plan.forward }] }, modelBatch: { submissionHash: hash, nodes: [], worldConversion: receipt } };
    } }, options);
    if (!result.ok) return failure(result.code, result.message);
    const receipt = result.modelBatch?.worldConversion;
    if (!receipt) return failure("receipt-unavailable", "转换回执不可用");
    return { ok: true, canvasId: input.canvasId, commandId, revision: result.revision, duplicate: result.status === "duplicate", receipt };
  }, async prepare(input: WorldConversionPrepareInput, options?: { signal?: AbortSignal }): Promise<WorldConversionPrepareOutcome> {
    if (!input || typeof input.canvasId !== "string" || !input.canvasId.trim() || !Array.isArray(input.nodeIds) ||
      !input.nodeIds.length || input.nodeIds.some(id => typeof id !== "string" || !id.trim()) || new Set(input.nodeIds).size !== input.nodeIds.length)
      return failure("malformed-request", "需要非空画布和不重复的节点列表");
    const room = await resolveRoom(input.canvasId);
    if (!room) return failure("canvas-not-found", "画布不存在");
    const snapshot = await room.inspectPublished(value => value);
    if (!snapshot.ok) return failure("canvas-unavailable", snapshot.message);
    return prepareCanvas(snapshot.canvas, input.canvasId, input.nodeIds, options);
  } };
}

async function prepareCanvas(canvas: ServerCanvas, canvasId: string, nodeIds: string[], options?: { signal?: AbortSignal }): Promise<WorldConversionPrepareOutcome> {
    const byId = new Map(canvas.document.nodes.map(node => [node.id, node]));
    const nodes: Extract<WorldConversionPrepareOutcome, { ok: true }>["nodes"] = [];
    for (const nodeId of nodeIds) {
      if (options?.signal?.aborted) return failure("cancelled", "准备已取消");
      const node = byId.get(nodeId), data = canvas.nodeData[nodeId];
      if (!node || node.type !== "model3d" || !data || data.sharedWorldInstance || isGlbModelNodeData(data) || typeof data.modelScript !== "string" || !data.modelScript.trim())
        return failure("not-ready", `节点 ${nodeId} 不是可转换的旧脚本模型`);
      const placement = data.modelPlacement === undefined ? { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } : decodeModelPlacement(data.modelPlacement);
      if (!placement) return failure("not-ready", `节点 ${nodeId} 的摆放无效`);
      let x = node.position.x, y = node.position.y, parentId = node.parentId;
      const seen = new Set([nodeId]);
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent || seen.has(parentId)) return failure("not-ready", "父节点链无效");
        seen.add(parentId); x += parent.position.x; y += parent.position.y; parentId = parent.parentId;
      }
      try {
        const execution = await executeSceneIr(data.modelScript, data.modelScriptVersion, { signal: options?.signal });
        if (options?.signal?.aborted) return failure("cancelled", "准备已取消");
        if (!execution.ok) return failure("not-ready", execution.message);
        const bounds = v2SceneAabb(execution.ops);
        if (!bounds) return failure("not-ready", `节点 ${nodeId} 没有有效 bounds`);
        const transform = legacyModelGroundTransform({ x, y, ...effectiveCanvasNodeSize(node), bounds, placement });
        nodes.push({ nodeId, nodeVersion: worldConversionNodeVersion(node, data), bounds, transform });
      } catch {
        return failure("not-ready", `节点 ${nodeId} 准备失败`);
      }
    }
    return { ok: true, canvasId, sourceVersion: String(canvas.revision), nodes };
}
