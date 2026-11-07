import { createHash } from "node:crypto";
import { decodeImageDirectorSceneCandidate, decodeImageDirectorSceneRequest, imageDirectorSceneCandidateSchema, imageDirectorSceneModelGuide, stableStringify, type AgentConnectionBinding, type AgentEntryIntent, type AgentAdapterRunOutcome, type ImageDirectorScenePort, type ImageDirectorSceneRequest } from "@woohaa3/contracts";
import type { AgentConversationService, AcceptTurnResult } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import type { ImageDirectorSceneRecord, ImageDirectorSceneStore } from "../repository/image-director-scene-store.js";

const MAX_CANDIDATE_ATTEMPTS = 3;

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const delivery = (record: ImageDirectorSceneRecord) => ({ purpose: "image-director-scene" as const, domainRequestId: record.request.requestId, attemptId: "1", ...(record.reservation ? { nodeId: record.reservation.nodeId } : {}) });

export class ImageDirectorSceneService {
  private readonly pending = new Map<string, Promise<AcceptTurnResult>>();
  private readonly retries = new Set<string>();
  private readonly active = new Set<string>();
  constructor(private readonly deps: { store: ImageDirectorSceneStore; canvas: ImageDirectorScenePort; conversations: AgentConversationService; connections: AgentConnectionRegistry; registry: AgentAdapterRegistry }) {}

  query(owner: string, canvasId: string, requestId: string) {
    const record = this.deps.store.get(owner, canvasId, requestId);
    return record ? { requestId, stage: record.stage, parentTurnId: record.parentTurnId, conversationId: record.conversationId, input: record.request, source: record.source, reservation: record.reservation, receipt: record.receipt, revision: record.revision, error: record.error, canRetryPlacement: record.stage === "failed" && !!record.candidate && (!record.placement || record.placement.state === "rejected"), canRetrySave: record.stage === "failed" && record.placement?.state === "not-committed" } : null;
  }

  async reconcile(owner: string, canvasId: string, requestId: string) {
    const record = this.deps.store.get(owner, canvasId, requestId);
    if (!record) return null;
    const key = JSON.stringify([owner, canvasId, requestId]);
    if (!this.active.has(key) && ["preparing", "generating", "repairing", "validating", "placing", "saving"].includes(record.stage)) {
      this.deps.conversations.cancelTurn({ owner, requestId });
      let stopError = "";
      if (record.activeAttemptId && record.connection) {
        const resolved = this.deps.registry.resolve(record.connection.adapterId);
        if (!resolved.ok || !resolved.handle.adapter.cancel) stopError = "无法确认关联助手执行已停止";
        else try {
          if (!record.entry) throw new Error("missing candidate context");
          const childId = `${requestId}:${record.activeAttemptId}`;
          await resolved.handle.adapter.cancel({ owner, requestId: childId, candidateContext: { canvasId, conversationId: childId, connection: record.connection, intent: { ...record.entry, action: "discuss" } } });
        } catch { stopError = "无法确认关联助手执行已停止"; }
      }
      record.stage = "failed";
      record.error = stopError || "执行中断，原结果尚未确认";
      if (record.placement?.state === "pending") record.placement.state = "unknown";
      this.deps.store.save(record);
    }
    if (!record.placement) {
      if (record.stage === "failed" && record.reservation) {
        try { await this.deps.canvas.settleReservation({ owner, canvasId, reservation: record.reservation, status: "failed" }); } catch { /* Retain the failure and retry settlement on the next query. */ }
      }
      return this.query(owner, canvasId, requestId);
    }
    const result = await this.deps.canvas.lookup({ owner, canvasId, commandId: record.placement.commandId });
    if (result.ok) {
      record.receipt = result.receipt;
      record.revision = result.revision;
      record.stage = "delivered";
      delete record.error;
      this.deps.store.save(record);
      this.deps.conversations.reconcileDeliveryTurn({ owner, canvasId, requestId, delivery: delivery(record), outcome: { status: "succeeded", receipt: result.receipt } });
    } else if (result.code === "receipt-not-found" && record.stage === "failed" && record.placement.state === "unknown") {
      record.placement.state = "not-committed";
      this.deps.store.save(record);
    }
    if (!result.ok && result.code === "receipt-not-found" && record.stage === "failed" && record.reservation) {
      try { await this.deps.canvas.settleReservation({ owner, canvasId, reservation: record.reservation, status: "failed" }); } catch { /* Retry on the next query. */ }
    }
    return this.query(owner, canvasId, requestId);
  }

  async retryPlacement(owner: string, canvasId: string, requestId: string) {
    const key = JSON.stringify([owner, canvasId, requestId]);
    if (this.retries.has(key)) throw new Error("放置重试正在进行");
    this.retries.add(key);
    try { return await this.retryPlacementOnce(owner, canvasId, requestId); }
    finally { this.retries.delete(key); }
  }

  async retrySave(owner: string, canvasId: string, requestId: string) {
    const key = JSON.stringify([owner, canvasId, requestId]);
    if (this.retries.has(key)) throw new Error("保存重试正在进行");
    this.retries.add(key);
    try {
      const record = this.deps.store.get(owner, canvasId, requestId);
      if (!record?.candidate || !record.placement || record.stage !== "failed" || record.placement.state !== "not-committed") throw new Error("原提交结果尚未确认");
      if (!record.connection || !record.entry) throw new Error("助手连接身份不可用");
      await this.adapter(owner, record.connection, record.entry);
      const known = await this.deps.canvas.lookup({ owner, canvasId, commandId: record.placement.commandId });
      if (known.ok) return this.reconcile(owner, canvasId, requestId);
      if (known.code !== "receipt-not-found") throw new Error("原提交结果无法确认");
      const placement = record.placement.plan as { delta: import("@woohaa3/contracts").GroundPoint; bounds: import("@woohaa3/contracts").GroundAabb };
      record.placement.state = "pending"; record.stage = "saving"; this.deps.store.save(record);
      try {
        const result = await this.deps.canvas.commit({ owner, canvasId, operationId: digest([owner, canvasId, requestId]), commandId: record.placement.commandId, source: record.source, candidate: record.candidate, reservation: record.reservation, ...placement });
        if (!result.ok) { record.placement.state = result.code === "placement-conflict" ? "rejected" : "unknown"; record.stage = "failed"; record.error = result.message; this.deps.store.save(record); return this.reconcile(owner, canvasId, requestId); }
        record.receipt = result.receipt; record.revision = result.revision; record.stage = "delivered"; delete record.error; this.deps.store.save(record);
        this.deps.conversations.reconcileDeliveryTurn({ owner, canvasId, requestId, delivery: delivery(record), outcome: { status: "succeeded", receipt: result.receipt } });
        return this.query(owner, canvasId, requestId);
      } catch (error) { record.placement.state = "unknown"; record.stage = "failed"; record.error = error instanceof Error ? error.message : "保存结果未确认"; this.deps.store.save(record); return this.reconcile(owner, canvasId, requestId); }
    } finally { this.retries.delete(key); }
  }

  private async retryPlacementOnce(owner: string, canvasId: string, requestId: string) {
    const record = this.deps.store.get(owner, canvasId, requestId);
    if (!record?.candidate || record.stage !== "failed" || (record.placement && record.placement.state !== "rejected")) throw new Error("原提交尚未确认拒绝，不能重新放置");
    if (!record.connection || !record.entry) throw new Error("助手连接身份不可用");
    await this.adapter(owner, record.connection, record.entry);
    if (record.placement) {
      const known = await this.deps.canvas.lookup({ owner, canvasId, commandId: record.placement.commandId });
      if (known.ok) return this.reconcile(owner, canvasId, requestId);
      if (known.code !== "receipt-not-found") throw new Error("原提交结果无法确认");
      (record.placementHistory ??= []).push(record.placement);
    }
    const placement = await this.deps.canvas.plan({ owner, canvasId, source: record.source, candidate: record.candidate, reservation: record.reservation });
    const attemptId = String(Number(record.placement?.attemptId ?? "0") + 1);
    const commandId = `image-director:${digest([owner, canvasId, requestId, `placement-${attemptId}`])}`;
    record.placement = { attemptId, commandId, plan: placement, state: "pending" };
    record.stage = "saving";
    this.deps.store.save(record);
    try {
      const result = await this.deps.canvas.commit({ owner, canvasId, operationId: digest([owner, canvasId, requestId]), commandId, source: record.source, candidate: record.candidate, reservation: record.reservation, ...placement });
      if (!result.ok) {
        record.placement.state = result.code === "placement-conflict" ? "rejected" : "unknown";
        record.stage = "failed"; record.error = result.message; this.deps.store.save(record);
        return this.query(owner, canvasId, requestId);
      }
      record.receipt = result.receipt; record.revision = result.revision; record.stage = "delivered"; delete record.error; this.deps.store.save(record);
      this.deps.conversations.reconcileDeliveryTurn({ owner, canvasId, requestId, delivery: delivery(record), outcome: { status: "succeeded", receipt: result.receipt } });
      return this.query(owner, canvasId, requestId);
    } catch (error) {
      record.placement.state = "unknown"; record.stage = "failed"; record.error = error instanceof Error ? error.message : "保存结果未确认"; this.deps.store.save(record);
      return this.reconcile(owner, canvasId, requestId);
    }
  }

  private async adapter(owner: string, connection: AgentConnectionBinding, entry: AgentEntryIntent) {
    const view = await this.deps.connections.getConnection({ owner, connectionId: connection.connectionId });
    if (!view || (!view.ready && view.authMode !== "local-login") || view.adapterId !== connection.adapterId || view.configRevision !== connection.configRevision || view.credentialEpoch !== connection.credentialEpoch) throw new Error("助手连接已失效");
    const resolved = this.deps.registry.resolve(connection.adapterId);
    if (!resolved.ok || !resolved.handle.capabilities.candidateGeneration?.imageInput || resolved.handle.capabilities.candidateGeneration.maxImages < 1) throw new Error("助手不支持图片候选");
    const catalog = await this.deps.conversations.catalog({ owner, adapterId: connection.adapterId });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const model = (view.models.length ? view.models : catalog.models).find(item => item.id === entry.model);
    if (!model || view.modelsError || catalog.error || (entry.reasoningEffort && !model.reasoningEfforts?.includes(entry.reasoningEffort))) throw new Error("助手模型或 Variant 已失效");
    const capabilities = "capabilities" in model ? model.capabilities : undefined;
    const candidateCapability = capabilities?.textDelivery ?? view.capabilities.textDelivery;
    if (!candidateCapability?.imageInput || candidateCapability.maxImages < 1) throw new Error("所选模型不支持图片结构化候选");
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
      record = this.deps.store.insert({ owner: input.owner, canvasId: input.canvasId, request: input.request, inputHash, source: prepared.source, imageBase64: Buffer.from(prepared.bytes).toString("base64"), connectionVersion: digest(input.connection), connection: input.connection, conversationId: input.conversationId, entry: input.entry, stage: "preparing", attempts: [] }).record;
    }
    if (!record.reservation) {
      record.reservation = await this.deps.canvas.reserve({ owner: input.owner, canvasId: input.canvasId, operationId: digest([input.owner, input.canvasId, input.request.requestId]), requestId: input.request.requestId, source: record.source });
      this.deps.store.save(record);
    }
    const accepted = this.deps.conversations.acceptDeliveryTurn({ owner: input.owner, conversationId: input.conversationId, requestId: input.request.requestId, entry: { ...input.entry, nodeId: record.reservation.nodeId, action: "discuss" }, connection: input.connection, delivery: delivery(record) });
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
      if (!record.entry || !record.connection || !record.conversationId || !record.parentTurnId) throw new Error("执行身份不完整");
      let feedback = "";
      while (!context.signal.aborted) {
        const adapter = await this.adapter(record.owner, record.connection, record.entry);
        const attemptId = String(record.attempts.length + 1);
        record.stage = feedback ? "repairing" : "generating";
        record.activeAttemptId = attemptId;
        this.deps.store.save(record);
        const outcome = await adapter.run({ owner: record.owner, canvasId: record.canvasId, connection: record.connection, conversationId: `${record.request.requestId}:${attemptId}`, turnId: record.parentTurnId, requestId: `${record.request.requestId}:${attemptId}`, intent: { ...record.entry, action: "discuss", prompt: `${record.request.instructions}\n只创建静态几何，不使用动画。模型脚本使用 Y-up 米制；世界变换及相机使用 u/v/h 米制和单位四元数。镜头应覆盖全部主要模型。\n${imageDirectorSceneModelGuide()}\nReturn only JSON matching this scene candidate schema (the model API above describes models[].script only): ${JSON.stringify(imageDirectorSceneCandidateSchema)}\n${feedback}` }, history: context.history, candidate: { images: [{ bytes: Buffer.from(record.imageBase64, "base64"), contentType: record.source.mimeType }], outputSchema: imageDirectorSceneCandidateSchema }, signal: context.signal, emit: context.emit });
        if (context.signal.aborted || outcome.status === "cancelled") throw new Error("已停止");
        if (outcome.status !== "succeeded") throw new Error(outcome.error?.message ?? "助手执行失败");
        delete record.activeAttemptId;
        let parsed: unknown;
        try { parsed = JSON.parse(/^```(?:json)?\s*([\s\S]*?)\s*```$/.exec((outcome.assistantText ?? "").trim())?.[1] ?? outcome.assistantText ?? ""); } catch { parsed = null; }
        const decoded = decodeImageDirectorSceneCandidate(parsed, { width: record.source.width, height: record.source.height });
        record.stage = "validating";
        const valid = await this.deps.canvas.validate({ owner: record.owner, canvasId: record.canvasId, candidate: parsed, source: record.source, signal: context.signal });
        if (!decoded.ok || !valid.ok) {
          feedback = `Previous candidate: ${JSON.stringify(parsed)}\nDiagnostic: ${!valid.ok ? valid.diagnostic : "invalid candidate"}. Repair it.`;
          record.attempts.push({ id: attemptId, diagnostic: !valid.ok ? valid.diagnostic : "invalid candidate", raw: parsed, ...(decoded.ok ? { candidate: decoded.value } : {}) });
          this.deps.store.save(record);
          if (record.attempts.length >= MAX_CANDIDATE_ATTEMPTS) throw new Error(`候选格式或内容连续 ${MAX_CANDIDATE_ATTEMPTS} 次未通过校验：${record.attempts.at(-1)?.diagnostic}`);
          continue;
        }
        record.attempts.push({ id: attemptId, candidate: decoded.value });
        record.candidate = decoded.value;
        record.stage = "placing";
        this.deps.store.save(record);
        const placement = await this.deps.canvas.plan({ owner: record.owner, canvasId: record.canvasId, source: record.source, candidate: decoded.value, reservation: record.reservation, signal: context.signal });
        const commandId = `image-director:${digest([record.owner, record.canvasId, record.request.requestId, "placement-1"])}`;
        record.placement = { attemptId: "1", commandId, plan: placement, state: "pending" };
        record.stage = "saving";
        this.deps.store.save(record);
        const result = await this.deps.canvas.commit({ owner: record.owner, canvasId: record.canvasId, operationId: digest([record.owner, record.canvasId, record.request.requestId]), commandId, source: record.source, candidate: decoded.value, reservation: record.reservation, ...placement, signal: context.signal });
        if (!result.ok) { record.placement.state = result.code === "placement-conflict" ? "rejected" : "unknown"; this.deps.store.save(record); throw new Error(result.message); }
        record.receipt = result.receipt;
        record.revision = result.revision;
        record.stage = "delivered";
        this.deps.store.save(record);
        return { status: "succeeded", receipt: result.receipt };
      }
      throw new Error("已停止");
    } catch (error) {
      if (record.placement) {
        if (record.placement.state === "pending") record.placement.state = "unknown";
        try {
          const known = await this.deps.canvas.lookup({ owner: record.owner, canvasId: record.canvasId, commandId: record.placement.commandId });
          if (known.ok) {
            record.receipt = known.receipt;
            record.revision = known.revision;
            record.stage = "delivered";
            this.deps.store.save(record);
            return { status: "succeeded", receipt: known.receipt };
          }
          if (known.code === "receipt-not-found" && record.placement.state === "unknown") record.placement.state = "not-committed";
        } catch { /* Preserve the original command identity for later reconciliation. */ }
      }
      record.stage = context.signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : "执行失败";
      this.deps.store.save(record);
      if (record.reservation && record.placement?.state !== "unknown") {
        try { await this.deps.canvas.settleReservation({ owner: record.owner, canvasId: record.canvasId, reservation: record.reservation, status: context.signal.aborted ? "cancelled" : "failed" }); } catch { /* Preserve the original failure for reconciliation. */ }
      }
      return { status: context.signal.aborted ? "cancelled" : "failed", error: { code: context.signal.aborted ? "cancelled" : "image-director-failed", message: record.error } };
    }
  }
}
