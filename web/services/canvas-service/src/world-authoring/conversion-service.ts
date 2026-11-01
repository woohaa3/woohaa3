import { createHash } from "node:crypto";
import { decodeModelPlacement, effectiveCanvasNodeSize, isGlbModelNodeData, legacyModelGroundTransform, v2SceneAabb,
  type WorldConversionPrepareInput, type WorldConversionPrepareOutcome } from "@woohaa3/contracts";
import type { CanvasRoom } from "../sync/room.js";
import { executeSceneIr } from "../model-mcp/script-executor.js";

const failure = (code: string, message: string): WorldConversionPrepareOutcome => ({ ok: false, code, message });
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return item;
});
export const worldConversionNodeVersion = (node: unknown, nodeData: unknown): string =>
  createHash("sha256").update(stable({ node, nodeData: nodeData ?? null })).digest("hex");

export function createWorldConversionService(resolveRoom: (id: string) => Promise<CanvasRoom | null>) {
  return { async prepare(input: WorldConversionPrepareInput, options?: { signal?: AbortSignal }): Promise<WorldConversionPrepareOutcome> {
    if (!input || typeof input.canvasId !== "string" || !input.canvasId.trim() || !Array.isArray(input.nodeIds) ||
      !input.nodeIds.length || input.nodeIds.some(id => typeof id !== "string" || !id.trim()) || new Set(input.nodeIds).size !== input.nodeIds.length)
      return failure("malformed-request", "需要非空画布和不重复的节点列表");
    const room = await resolveRoom(input.canvasId);
    if (!room) return failure("canvas-not-found", "画布不存在");
    const snapshot = await room.inspectPublished(value => value);
    if (!snapshot.ok) return failure("canvas-unavailable", snapshot.message);
    const canvas = snapshot.canvas;
    const byId = new Map(canvas.document.nodes.map(node => [node.id, node]));
    const nodes: Extract<WorldConversionPrepareOutcome, { ok: true }>["nodes"] = [];
    for (const nodeId of input.nodeIds) {
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
    return { ok: true, canvasId: input.canvasId, sourceVersion: String(canvas.revision), nodes };
  } };
}
