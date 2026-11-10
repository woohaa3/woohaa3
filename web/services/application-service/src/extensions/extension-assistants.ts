import { createHash } from "node:crypto";
import type { ApplicationExtensionAssistantFacade, ApplicationExtensionServices } from "@woohaa3/contracts";
import type { AgentConversationService } from "./agent-conversation-service.js";
import type { AgentRoleRegistry } from "../agent-roles/registry.js";

/** One ledger identity per extension request; no transport, credentials or agent loop lives here. */
export function createExtensionAssistants(extensionId: string, services: ApplicationExtensionServices,
  conversations: () => AgentConversationService, agentRoles?: () => AgentRoleRegistry | undefined): ApplicationExtensionAssistantFacade {
  const key = (id: string) => `extension-${createHash("sha256").update(JSON.stringify([extensionId, id])).digest("hex")}`;
  type Identity = Parameters<ApplicationExtensionAssistantFacade["query"]>[0];
  const authorize = async (input: Identity) => {
    const allowed = await services.canvasAccess?.authorize({ subject: input.subject, canvasId: input.canvasId, permission: "write" });
    return allowed?.ok === true;
  };
  const query = (input: Identity) => {
    const found = conversations().queryTurn({ owner: input.subject, requestId: key(input.requestId) });
    return found.ok && found.turn.target.canvasId === input.canvasId && found.turn.target.nodeId === input.nodeId ? found : null;
  };
  return {
    async submitRole(input) {
      if (!await authorize(input)) return { ok: false, code: "authorization-unavailable", message: "无法授权助手访问当前画布。" };
      if (!agentRoles?.()) return { ok: false, code: "role-unavailable", message: "宿主未启用 Agent 角色注册表" };
      const service = conversations();
      const resolved = await service.resolveConnectionBinding({ owner: input.subject, adapterId: input.connection.adapterId, connectionId: input.connection.connectionId });
      if (!resolved.ok) return { ok: false, ...resolved.error };
      const binding = resolved.binding;
      if (!binding || binding.configRevision !== input.connection.configRevision || binding.credentialEpoch !== input.connection.credentialEpoch) {
        return { ok: false, code: "connection-unavailable", message: "助手连接已更新，请重新选择助手。" };
      }
      const images = [];
      for (const ref of input.references ?? []) {
        if (!services.media.resources || !services.media.verify) return { ok: false, code: "media-unavailable", message: "宿主无法读取助手参考图。" };
        const verified = await services.media.verify(ref.storageKey, input.canvasId);
        if (!verified.exists || verified.metadata.checksum !== ref.checksum || !verified.metadata.contentType.startsWith("image/")) {
          return { ok: false, code: "reference-conflict", message: "参考图内容已改变，请重新拖入。" };
        }
        images.push(await services.media.resources.read(ref.storageKey, input.canvasId));
      }
      const requestId = key(input.requestId);
      const previous = service.queryTurn({ owner: input.subject, requestId });
      if (previous.ok && (previous.turn.target.canvasId !== input.canvasId || previous.turn.target.nodeId !== input.nodeId)) {
        return { ok: false, code: "request-id-reused", message: "助手请求已绑定其他目标。" };
      }
      const conversation = previous.ok ? { ok: true as const, conversation: previous.conversation }
        : service.createConversation({ owner: input.subject, canvasId: input.canvasId, nodeId: input.nodeId,
          adapterId: binding.adapterId, connectionId: binding.connectionId });
      if (!conversation.ok) return { ok: false, ...conversation.error };
      const candidate = { images, outputSchema: {}, referenceIdentity: input.references ?? [] };
      const accepted = service.acceptStructuredTurn({
        owner: input.subject,
        conversationId: conversation.conversation.conversationId,
        requestId,
        connection: binding,
        candidate,
        trustedRole: { input: input.roleInput, context: input.roleContext },
        entry: {
          action: "discuss",
          roleId: input.roleId,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          prompt: typeof (input.roleInput as { prompt?: unknown })?.prompt === "string" ? (input.roleInput as { prompt: string }).prompt : JSON.stringify(input.roleInput ?? null),
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
        }
      });
      if (!accepted.ok) return { ok: false, ...accepted.error };
      if (!accepted.reused) void service.dispatchStructuredTurn(accepted.turn.turnId, candidate);
      return { ok: true, conversation: { conversationId: accepted.turn.conversationId, requestId: accepted.turn.requestId } };
    },
    async query(input) {
      if (!await authorize(input)) throw new Error("无法授权助手访问当前画布。");
      const found = query(input);
      return found ? { state: found.turn.status, text: found.turn.assistantText, conversation: { conversationId: found.turn.conversationId, requestId: found.turn.requestId }, ...(found.turn.error ? { error: found.turn.error } : {}) } : null;
    },
    async cancel(input) {
      if (!await authorize(input)) throw new Error("无法授权助手访问当前画布。");
      if (query(input)) conversations().cancelTurn({ owner: input.subject, requestId: key(input.requestId) });
    }
  };
}
