import { canvasGroupMembers, canvasGroupAssetIds, hasExternalCanvasReference } from "@woohaa3/contracts";
import { currentCanvasGroupScope, type CanvasService } from "@woohaa3/canvas-service";

/** Covers reads and run submission as well as the room's independent write membrane. */
export function groupScopedClient<T extends object>(client: T, canvas: CanvasService): T {
  return new Proxy(client, { get(target, property, receiver) {
    const method = Reflect.get(target, property, receiver);
    if (typeof method !== "function") return method;
    return async (input: Record<string, unknown> = {}) => {
      const scope = currentCanvasGroupScope();
      if (!scope) return method.call(target, input);
      if (!scope.valid() || (input.canvasId !== undefined && input.canvasId !== scope.canvasId)) return { ok: false, code: "group-scope-revoked", message: "组创作授权失效" };
      if (scope.authorize && !await scope.authorize("read")) return { ok: false, code: "forbidden", message: "画布读取权限已撤销" };
      const room = await canvas.sync?.registry.resolve(scope.canvasId);
      const snapshot = room?.exportCanvas();
      if (!snapshot?.ok) return { ok: false, code: "group-target-missing", message: "根组不可读取" };
      let members: Set<string>;
      try { members = canvasGroupMembers(snapshot.canvas, scope.rootGroupId); } catch { return { ok: false, code: "group-target-missing", message: "根组已删除" }; }
      const nodeIds = [input.nodeId, input.aroundNodeId, ...(Array.isArray(input.nodeIds) ? input.nodeIds : []), ...(Array.isArray(input.items) ? input.items.map(i => (i as { nodeId?: string }).nodeId) : [])].filter((id): id is string => typeof id === "string");
      if (nodeIds.some(id => !members.has(id))) return { ok: false, code: "group-scope-forbidden", message: "目标不在当前根组内" };
      if (["getRun", "cancelRun", "getOutput"].includes(String(property))) {
        if (!snapshot.canvas.jobs.some(job => job.nodeId === input.nodeId && job.runId === input.runId)) return { ok: false, code: "group-run-forbidden", message: "运行不属于当前组内节点" };
      }
      if (property === "cancelRun" && !scope.ownsRun?.(String(input.nodeId), String(input.runId))) return { ok: false, code: "group-run-forbidden", message: "只能停止当前回合明确关联的运行" };
      // Existing upstream references are not implicitly made available to this turn.
      if (input.resource !== "group-appearance" && ["getModelNode", "getModelStatistics", "runNode"].includes(String(property)) && snapshot.canvas.document.edges.some(e => nodeIds.includes(e.target) && !members.has(e.source))) return { ok: false, code: "group-external-input", message: "目标有组外输入，请先明确处理跨组连接" };
      if (input.resource !== "group-appearance" && ["getModelNode", "getModelStatistics", "runNode"].includes(String(property)) && nodeIds.some(id => hasExternalCanvasReference(snapshot.canvas.nodeData[id], members, canvasGroupAssetIds(snapshot.canvas, members)))) return { ok: false, code: "group-external-input", message: "目标引用了组外输入" };
      const result = await method.call(target, { ...input, canvasId: scope.canvasId });
      if (property === "runNode" && result?.ok) scope.onAction?.({ canvasId: scope.canvasId, nodeId: result.nodeId, runId: result.runId, jobId: result.jobId });
      return result;
    };
  } });
}
