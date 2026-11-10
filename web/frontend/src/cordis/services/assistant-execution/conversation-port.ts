import { generationIdentity, recordAcceptedGeneration } from "./recent.js";
import type { AgentConversationService, AgentConversationSubmitInput, AgentConversationSubmitResult } from "../../contract/agent-conversation.js";
import type { AssistantSubmissionPort } from "./controller.js";

export function assistantConversationPort(service: AgentConversationService): AssistantSubmissionPort<AgentConversationSubmitInput, AgentConversationSubmitResult> {
  return {
    async submit(input, requestId) {
      const namespace = service.getDataScopeId?.() ?? "page";
      const result = await service.submitTurn({ ...input, requestId });
      if (result.ok) recordAcceptedGeneration(namespace, input.entry.mode ?? "reply", generationIdentity(input.connectionId ?? input.entry.connectionId ?? "", input.entry.model ?? ""));
      return result.ok ? { kind: "accepted", value: result.value } : {
        kind: ["network", "timeout", "network-error", "transport-error", "storage-failed", "unavailable", "internal-error", "identity-changed"].includes(result.code) ? "unknown" : "rejected", message: result.error,
      };
    },
    async query(input, requestId) {
      const namespace = service.getDataScopeId?.() ?? "page";
      const result = await service.queryTurn(requestId);
      if (!result.ok) return { kind: "unknown", message: result.error };
      if (result.value.turn.target.canvasId !== input.canvasId || result.value.turn.target.nodeId !== input.entry.nodeId ||
          (input.conversationId && result.value.conversation.conversationId !== input.conversationId)) {
        return { kind: "unknown", message: "执行响应与原目标不一致，请核对原请求。" };
      }
      recordAcceptedGeneration(namespace, input.entry.mode ?? "reply", generationIdentity(input.connectionId ?? input.entry.connectionId ?? "", input.entry.model ?? ""));
      return { kind: "accepted", value: { conversationId: result.value.conversation.conversationId, requestId, turn: result.value.turn, reused: true } };
    },
  };
}
