import type { CanvasCreationPort } from "@woohaa3/contracts";
import { DEFAULT_NODE_DIMS } from "@woohaa3/contracts";
import { bindCanvasGroupEpochStore, canvasGroupEpoch, type CanvasService } from "@woohaa3/canvas-service";

export function createCanvasCreationPort(canvas: CanvasService): CanvasCreationPort {
  const resolve = async (canvasId: string) => {
    const room = await canvas.sync?.registry.resolve(canvasId);
    if (!room) throw new Error("画布权威 room 不可用");
    return room;
  };
  return {
    async capabilities(input) {
      const agent = canvas.mcpServices().agent;
      const script = await agent?.scriptCapability({ principalId: input.owner, canvasId: input.canvasId });
      return script?.ok && script.available && Boolean(agent?.runAdapter)
        ? { ready: true }
        : { ready: false, reason: script?.ok ? script.reason ?? "组工具执行端口未就绪" : script?.message ?? "Canvas 组工具未装配" };
    },
    bindScopeEpochStore: bindCanvasGroupEpochStore,
    async lookupRoot(input) {
      const room = await resolve(input.canvasId);
      const receipt = await room.lookupCommand(input.commandId);
      const snapshot = room.exportCanvas();
      return { exists: Boolean(snapshot.ok && snapshot.canvas.document.nodes.some(n => n.id === input.rootGroupId && n.type === "group")), ...(receipt ? { revision: receipt.revision } : {}), scopeEpoch: canvasGroupEpoch(input.canvasId, input.rootGroupId) };
    },
    async ensureRoot(input) {
      const room = await resolve(input.canvasId);
      const existing = await room.lookupCommand(input.commandId);
      if (existing) {
        const snapshot = room.exportCanvas();
        if (!snapshot.ok || !snapshot.canvas.document.nodes.some(n => n.id === input.rootGroupId && n.type === "group")) throw Object.assign(new Error("原根组已删除"), { code: "group-target-missing" });
        return { revision: existing.revision, scopeEpoch: canvasGroupEpoch(input.canvasId, input.rootGroupId) };
      }
      const result = await room.submitDerived({ commandId: input.commandId, derive: snapshot => ({ ok: true, batch: { protocolVersion: 1, canvasId: input.canvasId, commandId: input.commandId, baseRevision: snapshot.revision, actorId: input.owner, commands: [{ type: "node.add", node: { id: input.rootGroupId, type: "group", position: input.position, ...DEFAULT_NODE_DIMS }, nodeData: { title: "节点搭建", retainWhenEmpty: true } }] } }) }, {
        authorize: async () => (await canvas.mcpServices().agent?.authorizeCanvas({ principalId: input.owner, canvasId: input.canvasId, permission: "write" }))?.ok === true
      });
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      const latest = room.exportCanvas();
      if (!latest.ok || !latest.canvas.document.nodes.some(n => n.id === input.rootGroupId && n.type === "group")) throw Object.assign(new Error("原根组已删除"), { code: "group-target-missing" });
      return { revision: result.revision, scopeEpoch: canvasGroupEpoch(input.canvasId, input.rootGroupId) };
    }
  };
}
