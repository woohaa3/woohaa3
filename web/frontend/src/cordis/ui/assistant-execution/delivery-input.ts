import { useEffect, useState } from "react";
import { assistantExecutionKey } from "@woohaa3/contracts";
import type { AgentReasoningEffort, AssistantExecutionRef } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";

type DeliveryInput = {
  requestId: string;
  prompt: string;
  connectionId?: string;
  adapterId: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
};

/** Recover the exact accepted input without navigating to detail or dispatching another turn. */
export function useAssistantDeliveryInput(service: AgentConversationService | undefined, execution: AssistantExecutionRef | undefined) {
  const [input, setInput] = useState<{ service: AgentConversationService; scope: string | null | undefined; key: string; value: DeliveryInput } | null>(null);
  const scope = service?.getDataScopeId?.();
  const key = execution ? assistantExecutionKey(execution) : null;
  useEffect(() => {
    if (!execution || !key || !service?.queryTurn) return;
    let cancelled = false;
    void service.queryTurn(execution.turnRequestId).then(result => {
      if (cancelled || !result.ok || service.getDataScopeId?.() !== scope) return;
      const { turn, conversation, snapshot } = result.value;
      if (turn.requestId !== execution.turnRequestId || turn.target.canvasId !== execution.canvasId ||
          turn.target.nodeId !== execution.targetNodeId || conversation.conversationId !== execution.conversationId) return;
      setInput({ service, scope, key, value: {
        requestId: execution.turnRequestId,
        prompt: snapshot.messages.find(message => message.turnId === turn.turnId && message.role === "user")?.content ?? "",
        connectionId: turn.connection?.connectionId ?? turn.target.connectionId ?? conversation.connectionId,
        adapterId: turn.connection?.adapterId ?? conversation.adapterId,
        model: turn.target.model,
        reasoningEffort: turn.target.reasoningEffort,
      } });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [service, scope, key]);
  return input?.service === service && input?.scope === scope && input?.key === key ? input.value : null;
}
