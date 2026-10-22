import { createHash } from "node:crypto";
import type { CanvasService } from "@woohaa3/canvas-service";
import { YJS_SYNC_PROTOCOL_VERSION, COMPOSITE_ASSET_NODE_TYPE } from "@woohaa3/contracts";
import type { ApplicationExtensionCanvasAccessFacade, ApplicationExtensionNodeFacade, CanvasCommand } from "@woohaa3/contracts";

/**
 * 项目读/写权限授权 facade（任务 6.2）。
 *
 * 只做权威授权判定，**不**解析/加载画布 room：受控 DTO handler 只需知道请求主体是否有权读写
 * 该 canvasId，而不需要返回画布内容。与 `createExtensionNodeFacade` 复用同一 Canvas 授权器，
 * 保证两处判定一致。未配置 Canvas 授权器时 fail closed（返回 unauthorized/unavailable）。
 */
export function createExtensionCanvasAccessFacade(canvas: CanvasService): ApplicationExtensionCanvasAccessFacade {
  return {
    async authorize(input) {
      if (input.subject.trim() === "") return { ok: false, code: "unauthorized", message: "缺少已认证主体" };
      const result = await canvas.mcpServices().agent?.authorizeCanvas({ principalId: input.subject, canvasId: input.canvasId, permission: input.permission });
      if (!result) return { ok: false, code: "unavailable", message: "Canvas 授权不可用" };
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true };
    }
  };
}

/** 扩展只可创建/更新复合资产节点；授权、CAS、幂等与持久化复用 Canvas。 */
export function createExtensionNodeFacade(canvas: CanvasService, extensionId: string): ApplicationExtensionNodeFacade {
  const authorize = async (subject: string, canvasId: string, permission: "read" | "write") => {
    const result = await canvas.mcpServices().agent?.authorizeCanvas({ principalId: subject, canvasId, permission });
    if (!result?.ok) throw Object.assign(new Error(result?.message ?? "Canvas 授权不可用"), { code: result?.code ?? "unavailable" });
    const room = await canvas.sync?.registry.resolve(canvasId);
    if (!room) throw Object.assign(new Error("Canvas published room 不可用"), { code: "unavailable" });
    return room;
  };
  return {
    async read(input) {
      const room = await authorize(input.subject, input.canvasId, input.permission);
      const snapshot = room.exportCanvas();
      if (!snapshot.ok) throw new Error(snapshot.message);
      return snapshot.canvas;
    },
    async commit(input) {
      const room = await authorize(input.subject, input.canvasId, "write");
      const snapshot = room.exportCanvas();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const current = snapshot.canvas;
      const node = current.document.nodes.find(n => n.id === input.nodeId);
      if (node && node.type !== COMPOSITE_ASSET_NODE_TYPE) throw Object.assign(new Error("目标不是复合资产节点"), { code: "unsupported-node" });
      // 严格业务所有权：已有节点必须声明属于本扩展（D11 共享 type + 必填 extensionId），
      // 防止一个业务经通用 facade 写入另一个业务的复合资产节点。
      if (node) {
        const existing = (current.nodeData?.[input.nodeId] ?? {}) as { extensionId?: unknown };
        if (existing.extensionId !== extensionId) throw Object.assign(new Error("目标不属于本扩展"), { code: "unsupported-node" });
      }
      if (!node && !input.create) throw Object.assign(new Error("目标节点不存在"), { code: "target-missing" });
      const commands: CanvasCommand[] = node
        ? [{ type: "nodeData.patch", nodeId: input.nodeId, value: input.value as never }]
        : [{ type: "node.add", node: { id: input.nodeId, type: COMPOSITE_ASSET_NODE_TYPE, position: input.create!.position }, nodeData: input.value as never }];
      const result = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, baseRevision: input.expectedRevision,
        actorId: input.subject, commandId: `extension:${extensionId}:${createHash("sha256").update(`${input.subject}:${input.requestId}`).digest("hex")}`, commands });
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      const saved = room.exportCanvas();
      if (!saved.ok) throw new Error(saved.message);
      return { revision: saved.canvas.revision };
    }
  };
}
