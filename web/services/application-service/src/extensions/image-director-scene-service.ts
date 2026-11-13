import { createHash } from "node:crypto";
import { decodeImageDirectorSceneRequest, stableStringify, type AgentAdapterRunOutcome, type AgentConnectionBinding, type AgentEntryIntent, type ImageDirectorScenePort, type ImageDirectorSceneRequest } from "@woohaa3/contracts";
import type { AgentConversationService, AcceptTurnResult } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import type { ImageDirectorSceneRecord, ImageDirectorSceneStore } from "../repository/image-director-scene-store.js";

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const delivery = (record: ImageDirectorSceneRecord) => ({ purpose: "image-director-scene" as const, domainRequestId: record.request.requestId, attemptId: "1", ...(record.reservation ? { nodeId: record.reservation.nodeId } : {}) });
const finalizeCommand = (record: ImageDirectorSceneRecord) => `image-director-finalize:${digest([record.owner, record.canvasId, record.request.requestId])}`;

/**
 * 图片 → 导演区：先由画布服务预留一个空导演区，再由 scene-director 用世界工具创建模型/镜头。
 * 不再生成整场景 JSON 候选，也不在宿主做模型/镜头放置。
 */
export class ImageDirectorSceneService {
  private readonly pending = new Map<string, Promise<AcceptTurnResult>>();
  private readonly active = new Set<string>();
  constructor(private readonly deps: { store: ImageDirectorSceneStore; canvas: ImageDirectorScenePort; conversations: AgentConversationService; connections: AgentConnectionRegistry; registry: AgentAdapterRegistry; agentRoles?: import("../agent-roles/registry.js").AgentRoleRegistry }) {}

  private prepareRoleTurn(record: ImageDirectorSceneRecord): import("@woohaa3/contracts").PreparedAgentRoleTurn {
    const registry = this.deps.agentRoles;
    const roleId = record.entry?.roleId;
    if (!registry) throw Object.assign(new Error("宿主未启用 Agent 角色注册表"), { code: "role-unavailable" });
    if (!roleId) throw Object.assign(new Error("图片场景请求没有选择角色"), { code: "role-not-found" });
    if (!record.reservation) throw Object.assign(new Error("导演区尚未预留"), { code: "source-unavailable" });
    const result = registry.prepare({
      roleId,
      input: { prompt: record.request.instructions, action: "generate" },
      context: { imageReconstruction: { sourceNodeId: record.source.sourceNodeId, width: record.source.width, height: record.source.height } },
      target: { canvasId: record.canvasId, nodeId: record.reservation.nodeId, mode: "world", worldScope: { kind: "scene-area", areaId: record.reservation.areaId } },
      requestId: record.request.requestId,
      channel: { toolCalling: true, imageInput: true, structuredOutput: "none", nativeCapabilities: [] }
    });
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    const recorded = this.deps.conversations.recordPrepared({ owner: record.owner, requestId: record.request.requestId, prepared: result.turn });
    if (!recorded.ok) throw Object.assign(new Error(recorded.error.message), { code: recorded.error.code });
    return result.turn;
  }

  query(owner: string, canvasId: string, requestId: string) {
    const record = this.deps.store.get(owner, canvasId, requestId);
    return record ? { requestId, stage: record.stage, parentTurnId: record.parentTurnId, conversationId: record.conversationId, input: record.request, source: record.source, reservation: record.reservation, receipt: record.receipt, revision: record.revision, error: record.error } : null;
  }

  async reconcile(owner: string, canvasId: string, requestId: string) {
    const record = this.deps.store.get(owner, canvasId, requestId);
    if (!record) return null;
    const key = JSON.stringify([owner, canvasId, requestId]);
    if (!this.active.has(key) && ["preparing", "generating", "finalizing"].includes(record.stage)) {
      this.deps.conversations.cancelTurn({ owner, requestId });
      let stopError = "";
      if (record.activeAttemptId && record.connection) {
        const resolved = this.deps.registry.resolve(record.connection.adapterId);
        if (!resolved.ok || !resolved.handle.adapter.cancel) stopError = "无法确认关联助手执行已停止";
        else try {
          const childId = `${requestId}:${record.activeAttemptId}`;
          await resolved.handle.adapter.cancel({ owner, requestId: childId, candidateContext: { canvasId, conversationId: childId, connection: record.connection, intent: record.entry ? { ...record.entry, action: "generate" } : { action: "generate", canvasId, prompt: record.request.instructions } } });
        } catch { stopError = "无法确认关联助手执行已停止"; }
      }
      record.stage = "failed";
      record.error = stopError || "执行中断，原结果尚未确认";
      this.deps.store.save(record);
    }
    const result = await this.deps.canvas.lookup({ owner, canvasId, commandId: finalizeCommand(record) });
    if (result.ok) {
      record.receipt = result.receipt;
      record.revision = result.revision;
      record.stage = "delivered";
      delete record.error;
      this.deps.store.save(record);
      this.deps.conversations.reconcileDeliveryTurn({ owner, canvasId, requestId, delivery: delivery(record), outcome: { status: "succeeded", receipt: result.receipt } });
    } else if (record.stage === "failed" && record.reservation) {
      try { await this.deps.canvas.settleReservation({ owner, canvasId, reservation: record.reservation, status: "failed" }); } catch { /* Retry on the next query. */ }
    }
    return this.query(owner, canvasId, requestId);
  }

  private async adapter(owner: string, connection: AgentConnectionBinding, entry: AgentEntryIntent) {
    const view = await this.deps.connections.getConnection({ owner, connectionId: connection.connectionId });
    if (!view || (!view.ready && view.authMode !== "local-login") || view.adapterId !== connection.adapterId || view.configRevision !== connection.configRevision || view.credentialEpoch !== connection.credentialEpoch) throw new Error("助手连接已失效");
    const resolved = this.deps.registry.resolve(connection.adapterId);
    if (!resolved.ok || !resolved.handle.capabilities.tools || !resolved.handle.capabilities.targets.includes("world")) throw new Error("助手不支持导演区工具执行");
    const catalog = await this.deps.conversations.catalog({ owner, adapterId: connection.adapterId });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const model = (view.models.length ? view.models : catalog.models).find(item => item.id === entry.model);
    if (!model || view.modelsError || catalog.error || (entry.reasoningEffort && !model.reasoningEfforts?.includes(entry.reasoningEffort))) throw new Error("助手模型或 Variant 已失效");
    const capabilities = "capabilities" in model ? model.capabilities : undefined;
    const imageCapability = capabilities?.textDelivery ?? view.capabilities.textDelivery;
    if (!imageCapability?.imageInput || imageCapability.maxImages < 1) throw new Error("所选模型不支持参考图片");
    return resolved.handle.adapter;
  }

  async accept(input: { owner: string; canvasId: string; conversationId: string; request: ImageDirectorSceneRequest; connection: AgentConnectionBinding; entry: AgentEntryIntent }): Promise<AcceptTurnResult> {
    if (!decodeImageDirectorSceneRequest(input.request).ok) return { ok: false, error: { code: "malformed-request", message: "图片场景请求无效" } };
    const key = JSON.stringify([input.owner, input.canvasId, input.request.requestId]);
    const inputHash = digest([input.canvasId, input.conversationId, input.request, input.connection, input.entry]);
    const known = this.deps.store.get(input.owner, input.canvasId, input.request.requestId);
    if (known && known.inputHash !== inputHash) return { ok: false, error: { code: "request-id-reused", message: "原请求不能更改输入" } };
    const pending = this.pending.get(key);
    if (pending) { await pending; return this.accept(input); }
    const work = this.acceptOnce(input, inputHash).catch(error => ({ ok: false as const, error: { code: "capability-unsupported" as const, message: error instanceof Error ? error.message : "创建不可用" } }));
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }

  private async acceptOnce(input: Parameters<ImageDirectorSceneService["accept"]>[0], inputHash: string): Promise<AcceptTurnResult> {
    if (input.entry.canvasId !== input.canvasId || input.entry.nodeId !== input.request.sourceNodeId || input.entry.model !== input.request.model || input.connection.connectionId !== input.request.connectionId || input.entry.prompt !== input.request.instructions || (input.entry.reasoningEffort ?? null) !== input.request.variant) throw new Error("请求目标不匹配");
    let record = this.deps.store.get(input.owner, input.canvasId, input.request.requestId);
    if (record?.parentTurnId) {
      const turn = this.deps.conversations.queryTurn({ owner: input.owner, requestId: input.request.requestId });
      return turn.ok ? { ok: true, conversation: turn.conversation, turn: turn.turn, reused: true } : turn;
    }
    await this.adapter(input.owner, input.connection, input.entry);
    if (!record) {
      const prepared = await this.deps.canvas.prepare({ owner: input.owner, canvasId: input.canvasId, sourceNodeId: input.request.sourceNodeId });
      record = this.deps.store.insert({ owner: input.owner, canvasId: input.canvasId, request: input.request, inputHash, source: prepared.source, imageBase64: Buffer.from(prepared.bytes).toString("base64"), beforeNodeIds: prepared.nodeIds, connectionVersion: digest(input.connection), connection: input.connection, conversationId: input.conversationId, entry: input.entry, stage: "preparing" }).record;
    }
    if (!record.reservation) {
      record.reservation = await this.deps.canvas.reserve({ owner: input.owner, canvasId: input.canvasId, operationId: digest([input.owner, input.canvasId, input.request.requestId]), requestId: input.request.requestId, source: record.source });
      this.deps.store.save(record);
    }
    const accepted = this.deps.conversations.acceptDeliveryTurn({
      owner: input.owner,
      conversationId: input.conversationId,
      requestId: input.request.requestId,
      entry: { ...input.entry, nodeId: record.reservation.nodeId, mode: "world", worldScope: { kind: "scene-area", areaId: record.reservation.areaId }, action: "generate" },
      connection: input.connection,
      delivery: delivery(record)
    });
    if (!accepted.ok) {
      record.stage = "failed"; record.error = accepted.error.message; this.deps.store.save(record);
      try { await this.deps.canvas.settleReservation({ owner: input.owner, canvasId: input.canvasId, reservation: record.reservation, status: "failed" }); } catch { /* Preserve the acceptance error. */ }
      return accepted;
    }
    record.parentTurnId = accepted.turn.turnId;
    record.stage = "generating";
    this.deps.store.save(record);
    if (!accepted.reused) {
      const key = JSON.stringify([input.owner, input.canvasId, input.request.requestId]);
      this.active.add(key);
      void this.deps.conversations.dispatchDeliveryTurn(record.parentTurnId, context => this.execute(record!, context)).finally(() => this.active.delete(key));
    }
    return accepted;
  }

  private async execute(record: ImageDirectorSceneRecord, context: Parameters<Parameters<AgentConversationService["dispatchDeliveryTurn"]>[1]>[0]): Promise<AgentAdapterRunOutcome> {
    try {
      if (!record.entry || !record.connection || !record.conversationId || !record.parentTurnId || !record.reservation) throw new Error("执行身份不完整");
      const adapter = await this.adapter(record.owner, record.connection, record.entry);
      const roleTurn = this.prepareRoleTurn(record);
      record.stage = "generating";
      record.activeAttemptId = "1";
      this.deps.store.save(record);
      const outcome = await adapter.run({
        owner: record.owner,
        canvasId: record.canvasId,
        connection: record.connection,
        conversationId: record.conversationId,
        turnId: record.parentTurnId,
        requestId: `${record.request.requestId}:1`,
        prepared: roleTurn,
        intent: { ...record.entry, action: "generate", nodeId: record.reservation.nodeId, mode: "world", worldScope: { kind: "scene-area", areaId: record.reservation.areaId }, prompt: record.request.instructions },
        history: context.history,
        images: [{ bytes: Buffer.from(record.imageBase64, "base64"), contentType: record.source.mimeType }],
        signal: context.signal,
        emit: context.emit
      });
      if (context.signal.aborted || outcome.status === "cancelled") throw new Error("已停止");
      if (outcome.status !== "succeeded") throw new Error(outcome.error?.message ?? "助手执行失败");
      delete record.activeAttemptId;
      record.stage = "finalizing";
      this.deps.store.save(record);
      const result = await this.deps.canvas.finalize({ owner: record.owner, canvasId: record.canvasId, operationId: digest([record.owner, record.canvasId, record.request.requestId]), commandId: finalizeCommand(record), reservation: record.reservation, source: record.source, beforeNodeIds: record.beforeNodeIds });
      if (!result.ok) throw new Error(result.message);
      record.receipt = result.receipt;
      record.revision = result.revision;
      record.stage = "delivered";
      this.deps.store.save(record);
      return { status: "succeeded", receipt: { commandId: finalizeCommand(record) } };
    } catch (error) {
      delete record.activeAttemptId;
      const known = record.reservation ? await this.deps.canvas.lookup({ owner: record.owner, canvasId: record.canvasId, commandId: finalizeCommand(record) }).catch(() => null) : null;
      if (known?.ok) {
        record.receipt = known.receipt;
        record.revision = known.revision;
        record.stage = "delivered";
        this.deps.store.save(record);
        return { status: "succeeded", receipt: { commandId: finalizeCommand(record) } };
      }
      record.stage = context.signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : "执行失败";
      this.deps.store.save(record);
      if (record.reservation) {
        try { await this.deps.canvas.settleReservation({ owner: record.owner, canvasId: record.canvasId, reservation: record.reservation, status: context.signal.aborted ? "cancelled" : "failed" }); } catch { /* Preserve the original failure for reconciliation. */ }
      }
      return { status: context.signal.aborted ? "cancelled" : "failed", error: { code: context.signal.aborted ? "cancelled" : "image-director-failed", message: record.error } };
    }
  }
}
