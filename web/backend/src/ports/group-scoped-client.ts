/**
 * 2D 组作用域下的 MCP 客户端代理。
 *
 * 旧普通组版本的同一文件随 `f510576d` 删除；这里保留其核心职责，并把成员解析换成
 * `workflow-group-2d.memberNodeIds`：
 *
 * - 读取、执行、停止与脚本提交都只能碰根组与成员；
 * - 写入仍然经过 Canvas 的 `validateCanvasGroupChange` 写膜，代理只是第一道可诊断的门；
 * - 新建节点允许出现在 `node.add` 里，最终归属由提交后的成员表同步保证。
 *
 * 代理只包住宿主注入的受信客户端，不改变任何业务实现。
 */
import { canvasGroupMembers, type CanvasCommand } from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import { currentCanvasGroupScope } from "@woohaa3/canvas-service";

type ScopedInput = Record<string, unknown> & { canvasId?: string };

function nodeIdsOf(input: ScopedInput): string[] {
  const ids: string[] = [];
  for (const value of [input.nodeId, input.aroundNodeId]) if (typeof value === "string") ids.push(value);
  if (Array.isArray(input.nodeIds)) ids.push(...input.nodeIds.filter((id): id is string => typeof id === "string"));
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (item && typeof item === "object" && typeof (item as { nodeId?: unknown }).nodeId === "string") ids.push((item as { nodeId: string }).nodeId);
    }
  }
  return ids;
}

/** 命令批次里会碰到既有节点的 id；新增节点与根组成员补丁另行放行。 */
function existingCommandNodeIds(commands: readonly CanvasCommand[], rootGroupId: string): string[] {
  const ids: string[] = [];
  for (const command of commands) {
    switch (command.type) {
      case "node.add":
        break;
      case "nodeData.patch":
        if (command.nodeId !== rootGroupId) ids.push(command.nodeId);
        break;
      case "node.update":
      case "node.remove":
      case "edge.add":
      case "edge.remove":
        if ("nodeId" in command && command.nodeId !== rootGroupId) ids.push(command.nodeId);
        if ("nodeIds" in command) ids.push(...command.nodeIds.filter((id) => id !== rootGroupId));
        if (command.type === "edge.add" || command.type === "edge.remove") {
          const edge = command.type === "edge.add" ? command.edge : command.edgeId;
          if (typeof edge === "object") ids.push(edge.source, edge.target);
        }
        break;
    }
  }
  return ids;
}

async function groupMembers(canvas: CanvasService, canvasId: string, rootGroupId: string): Promise<Set<string> | null> {
  if (!canvas.sync) return null;
  const room = await canvas.sync.registry.resolve(canvasId);
  const snapshot = room.exportCanvas();
  if (!snapshot.ok) return null;
  try {
    return canvasGroupMembers(snapshot.canvas, rootGroupId);
  } catch {
    return null;
  }
}

export function groupScopedClient<T extends object>(client: T, canvas: CanvasService): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return async (input: ScopedInput = {}) => {
        const scope = currentCanvasGroupScope();
        if (!scope) return (method as (value: ScopedInput) => Promise<unknown>).call(target, input);
        if (!scope.valid() || (input.canvasId !== undefined && input.canvasId !== scope.canvasId)) {
          return { ok: false, code: "group-scope-revoked", message: "组创作授权已失效" };
        }
        if (scope.authorize && !(await scope.authorize("read"))) {
          return { ok: false, code: "forbidden", message: "画布读取权限已撤销" };
        }
        const members = await groupMembers(canvas, scope.canvasId, scope.rootGroupId);
        if (!members) return { ok: false, code: "group-target-missing", message: "2D 组已删除或数据无效" };
        const requested = nodeIdsOf(input);
        if (requested.some((id) => !members.has(id))) {
          return { ok: false, code: "group-scope-forbidden", message: "目标不在当前 2D 组内" };
        }
        if (property === "applyPlan" && Array.isArray(input.commands)) {
          const touched = existingCommandNodeIds(input.commands as CanvasCommand[], scope.rootGroupId);
          if (touched.some((id) => !members.has(id))) {
            return { ok: false, code: "group-scope-forbidden", message: "命令会修改当前 2D 组之外的对象" };
          }
        }
        if (property === "runNode" || property === "getRun" || property === "cancelRun" || property === "getOutput") {
          const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
          if (!nodeId || !members.has(nodeId)) {
            return { ok: false, code: "group-run-forbidden", message: "运行不属于当前 2D 组内节点" };
          }
        }
        const scopedInput = { ...input, canvasId: scope.canvasId };
        const result = await (method as (value: ScopedInput) => Promise<unknown>).call(target, scopedInput);
        if (property === "runNode" && result && typeof result === "object" && (result as { ok?: boolean }).ok) {
          scope.onAction?.({
            canvasId: scope.canvasId,
            nodeId: (result as { nodeId?: string }).nodeId,
            runId: (result as { runId?: string }).runId,
            jobId: (result as { jobId?: string }).jobId
          });
        }
        return result;
      };
    }
  });
}
