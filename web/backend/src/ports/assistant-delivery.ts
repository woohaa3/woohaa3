import type { ContentConversionExecutionPort } from "@woohaa3/contracts";
import type { AgentConversationService } from "@woohaa3/application-service";

/** Bind the content coordinator to the existing host ledger, resolving services only at explicit execution. */
export function createAssistantDeliveryPort(resolve: () => AgentConversationService,
  providers: () => readonly import("@woohaa3/contracts").FilmSetConversionProvider[]): ContentConversionExecutionPort {
  return {
    readStatus(record) {
      if (!record.execution) return undefined;
      const result = resolve().queryTurn({ owner: record.subject ?? record.ownerId ?? "", requestId: record.execution.turnRequestId });
      return result.ok ? result.turn.status : undefined;
    },
    cancel(record) {
      if (record.execution) resolve().cancelTurn({ owner: record.subject ?? record.ownerId ?? "", requestId: record.execution.turnRequestId });
    },
    reconcile(record, outcome) {
      if (record.execution) resolve().reconcileDeliveryTurn({ owner: record.subject ?? record.ownerId ?? "",
        requestId: record.execution.turnRequestId, canvasId: record.canvasId,
        delivery: { purpose: "film-set-conversion", domainRequestId: record.requestId, attemptId: String(record.attempt) }, outcome });
    },
    async run(record, execute, onAccepted) {
      const service = resolve();
      const owner = record.subject ?? record.ownerId;
      if (!owner) throw new Error("缺少可信助手执行主体");
      const modelKey = record.resolvedModelKey ?? record.settings.modelKey ?? "";
      const separator = modelKey.indexOf(":");
      if (separator < 1) throw new Error("转换模型缺少执行来源身份");
      const provider = providers().find(candidate => candidate.providerId === modelKey.slice(0, separator));
      const adapterId = provider?.assistantAdapterId;
      if (!adapterId) throw new Error("此转换来源尚未接入助手会话执行");
      const model = modelKey.slice(separator + 1);
      const catalog = await service.catalog({ owner, adapterId });
      if (!catalog.ok) throw new Error(catalog.error.message);
      if (catalog.authState !== "ready") throw new Error("助手授权尚未就绪");
      if (catalog.capabilities.models === "remote") {
        const selected = catalog.models.find(candidate => candidate.id === model);
        if (!selected || catalog.error) throw new Error(catalog.error ?? "所选模型已不在当前账号目录中");
        if (record.settings.reasoningEffort && !selected.reasoningEfforts?.includes(record.settings.reasoningEffort)) throw new Error("原 Variant 已失效，请重新选择");
      }
      const requestId = `conversion:${record.requestId}:${record.attempt}${record.saveAttempt ? `:save:${record.saveAttempt}` : ""}`;
      const existing = service.queryTurn({ owner, requestId });
      let conversationId: string;
      if (existing.ok) conversationId = existing.conversation.conversationId;
      else {
        const current = service.findConversationForTarget({ owner, canvasId: record.canvasId, nodeId: record.targetNodeId }).conversation;
        const created = current ? { ok: true as const, conversation: current } : service.createConversation({ owner,
          canvasId: record.canvasId, nodeId: record.targetNodeId, adapterId,
          ...(record.settings.connection ? { connectionId: record.settings.connection.connectionId } : {}) });
        if (!created.ok) throw new Error(created.error.message);
        conversationId = created.conversation.conversationId;
      }
      const binding = await service.resolveConnectionBinding({ owner, adapterId, ...(record.settings.connection ? { connectionId: record.settings.connection.connectionId } : {}) });
      if (!binding.ok) throw new Error(binding.error.message);
      if (record.settings.connection && (!binding.binding ||
        binding.binding.connectionId !== record.settings.connection.connectionId || binding.binding.adapterId !== record.settings.connection.adapterId ||
        binding.binding.configRevision !== record.settings.connection.configRevision || binding.binding.credentialEpoch !== record.settings.connection.credentialEpoch)) throw new Error("助手连接版本已变更，请重新选择");
      const accepted = service.acceptDeliveryTurn({ owner, conversationId, requestId, connection: binding.binding,
        entry: { action: "generate", canvasId: record.canvasId, nodeId: record.targetNodeId, mode: "film-set", model,
          ...(record.settings.reasoningEffort ? { reasoningEffort: record.settings.reasoningEffort } : {}),
          prompt: record.settings.instruction?.trim() || `根据${record.sourceKind === "image" ? "图片" : "视频"}创建片场` },
        delivery: { purpose: "film-set-conversion", domainRequestId: record.requestId, attemptId: String(record.attempt) },
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      const execution = { canvasId: record.canvasId, targetNodeId: record.targetNodeId, conversationId,
        turnRequestId: requestId, domainRequestId: record.requestId, attemptId: String(record.attempt) };
      await onAccepted?.(execution);
      // Replayed accepted turns remain read-only. In-memory dispatch deduplicates concurrent explicit starts.
      await service.dispatchDeliveryTurn(accepted.turn.turnId, context => execute({ ...context, execution }));
    },
  };
}
