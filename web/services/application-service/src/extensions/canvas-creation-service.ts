import { createHash } from "node:crypto";
import { stableStringify, UNCONFIRMED_RESULT_ERROR_CODE, UNCONFIRMED_RESULT_MESSAGE, type CanvasCreationPort, type CanvasCreationRequest, type CanvasCreationView } from "@woohaa3/contracts";
import type { CanvasCreationStore, CanvasCreationRecord } from "../repository/canvas-creation-store.js";
import type { AgentConversationService } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";

export class CanvasCreationService {
  private readonly pending = new Map<string, Promise<CanvasCreationView>>();
  constructor(private readonly deps: { store: CanvasCreationStore; conversations: AgentConversationService; connections: AgentConnectionRegistry; canvas?: CanvasCreationPort; preflight?: (owner: string, canvasId: string) => Promise<boolean>; discoverTools?: () => Promise<{ ready: boolean; tools: { name: string }[]; reason?: string }> }) {}
  peek(owner: string, requestId: string) { return this.deps.store.get(owner, requestId)?.view ?? null; }
  async retry(owner: string, requestId: string) { const record = this.deps.store.get(owner, requestId); if (!record) throw failure("not-found", "创建请求不存在"); return this.accept(owner, record.input); }
  async list(owner: string, canvasId: string) { return Promise.all(this.deps.store.list(owner, canvasId).map(record => this.query(owner, record.input.requestId))); }
  async query(owner: string, requestId: string): Promise<CanvasCreationView | null> {
    await this.pending.get(JSON.stringify([owner, requestId]));
    return this.inspect(owner, requestId);
  }
  private async inspect(owner: string, requestId: string): Promise<CanvasCreationView | null> {
    const record = this.deps.store.get(owner, requestId);
    if (!record) return null;
    // Recovery is read-only: query command/turn receipts; never dispatch on GET or startup.
    if (this.deps.canvas) {
      const root = await this.deps.canvas.lookupRoot({ owner, ...record.view });
      if (!root.exists && (root.revision !== undefined || record.view.rootRevision !== undefined)) {
        const latest = this.deps.store.get(owner, requestId)!;
        if (latest.view.error?.code !== "group-target-missing") this.deps.store.invalidate(record.input.canvasId, record.view.rootGroupId);
        record.view = latest.view;
        record.view = { ...record.view, stage: "failed", error: { code: "group-target-missing", message: "原根组已删除；历史保留，不能重建" } };
        this.deps.store.save({ ...latest, view: record.view });
      } else if (root.revision !== undefined) {
        record.view.rootRevision = root.revision;
        const turn = this.deps.conversations.queryTurn({ owner, requestId: record.view.turnRequestId });
        if (turn.ok) record.view = { ...record.view, stage: "accepted", conversationId: turn.conversation.conversationId, turnId: turn.turn.turnId };
        else if (record.view.stage === "preparing") record.view.stage = "root-created";
      } else if (record.view.stage === "preparing") {
        record.view = { ...record.view, stage: "failed", error: { code: UNCONFIRMED_RESULT_ERROR_CODE, message: UNCONFIRMED_RESULT_MESSAGE } };
        this.deps.store.save(record);
      }
      // Read recovery must not overwrite a concurrently advancing durable phase.
    }
    return record.view;
  }
  async accept(owner: string, input: CanvasCreationRequest): Promise<CanvasCreationView> {
    const hash = createHash("sha256").update(stableStringify(input)).digest("hex");
    const existing = this.deps.store.get(owner, input.requestId);
    if (existing && existing.inputHash !== hash) throw failure("request-id-reused", "同一请求身份不能更改输入、位置或连接");
    const key = JSON.stringify([owner, input.requestId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = this.advance(owner, input, hash, existing);
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }
  private async advance(owner: string, input: CanvasCreationRequest, hash: string, existing: CanvasCreationRecord | null) {
    if (!this.deps.canvas) throw failure("capability-unsupported", "组创作权威端口未装配");
    if (this.deps.preflight && !await this.deps.preflight(owner, input.canvasId)) throw failure("unauthorized", "画布不可写");
    if (existing?.view.stage === "accepted") return (await this.inspect(owner, input.requestId))!;
    const connection = await this.deps.connections.getConnection({ owner, connectionId: input.connection.connectionId });
    // 本机来源（authMode local-login）的账号证据只能在真实执行时采集：把 ready 当成首次创作的
    // 前置条件会让新连接永远无法执行。这里仍校验连接身份/版本与能力，账号问题由执行回合返回
    // 真实失败；OAuth / API Key 等可在配置期确认的来源继续要求就绪。
    const localLogin = connection?.authMode === "local-login";
    if (!connection || (!connection.ready && !localLogin) || connection.adapterId !== input.connection.adapterId || connection.configRevision !== input.connection.configRevision || connection.credentialEpoch !== input.connection.credentialEpoch) throw failure("connection-unavailable", "助手连接已失效或版本已变化");
    const catalog = await this.deps.conversations.catalog({ owner, adapterId: connection.adapterId });
    if (!catalog.ok || !catalog.capabilities.targets.includes("canvas-group") || !catalog.capabilities.tools || !connection.capabilities.tools) throw failure("capability-unsupported", "此助手尚未支持节点搭建");
    if (catalog.authState !== "ready" && !localLogin) throw failure("connection-unavailable", "助手连接尚未就绪");
    const discovery = await this.deps.discoverTools?.();
    const requiredTools = ["get_canvas_graph", "get_canvas_script_api", "validate_canvas_script", "submit_canvas_script", "run_canvas_node", "get_node_output"];
    if (!discovery?.ready || requiredTools.some(name => !discovery.tools.some(tool => tool.name === name))) throw failure("tools-unavailable", discovery?.reason ?? "受控 Canvas 工具尚未完整就绪");
    const capability = await this.deps.canvas.capabilities({ owner, canvasId: input.canvasId });
    if (!capability.ready) throw failure("tools-unavailable", capability.reason ?? "Canvas 组工具不可执行");
    const models = connection.models.length ? connection.models : catalog.models;
    if (connection.authMode !== "local-login" && !input.model) throw failure("malformed-request", "请明确选择助手模型");
    const model = models.find(m => m.id === input.model);
    if (connection.models.find(m => m.id === input.model)?.capabilities?.tools === false) throw failure("capability-unsupported", "所选模型不支持工具执行");
    if (input.model && !model) throw failure("malformed-request", "所选模型已失效");
    if (input.reasoningEffort && !model?.reasoningEfforts?.includes(input.reasoningEffort)) throw failure("malformed-request", "所选模型不支持此 Variant");
    const digest = createHash("sha256").update(JSON.stringify([owner, input.canvasId, input.requestId])).digest("hex");
    const record = existing ?? this.deps.store.insert({ owner, inputHash: hash, input, view: { requestId: input.requestId, canvasId: input.canvasId, rootGroupId: `agent-group-${digest}`, commandId: `agent-root-${digest}`, turnRequestId: `agent-first-${digest}`, scopeEpoch: 0, stage: "preparing" } });
    if (record.inputHash !== hash) throw failure("request-id-reused", "请求身份冲突");
    try {
      const known = await this.deps.canvas.lookupRoot({ owner, ...record.view });
      if (!known.exists && (known.revision !== undefined || record.view.rootRevision !== undefined)) throw failure("group-target-missing", "原根组已删除，不会重建");
      const root = known.revision === undefined ? await this.deps.canvas.ensureRoot({ owner, ...record.view, position: input.position }) : { revision: known.revision, scopeEpoch: known.scopeEpoch };
      record.view = { ...record.view, rootRevision: root.revision, scopeEpoch: root.scopeEpoch, stage: "root-created", error: undefined };
      this.deps.store.save(record);
      let conversationId = record.view.conversationId;
      if (!conversationId) {
        const found = this.deps.conversations.findConversationForTarget({ owner, canvasId: input.canvasId, nodeId: record.view.rootGroupId, connectionId: connection.connectionId });
        const created = found.conversation ? { ok: true as const, conversation: found.conversation } : this.deps.conversations.createConversation({ owner, canvasId: input.canvasId, nodeId: record.view.rootGroupId, adapterId: connection.adapterId, connectionId: connection.connectionId });
        if (!created.ok) throw failure(created.error.code, created.error.message);
        conversationId = created.conversation.conversationId;
        record.view.conversationId = conversationId;
        this.deps.store.save(record);
      }
      const accepted = this.deps.conversations.acceptTurn({ owner, conversationId, requestId: record.view.turnRequestId, connection: input.connection, entry: { action: "generate", canvasId: input.canvasId, nodeId: record.view.rootGroupId, mode: "canvas-group", connectionId: connection.connectionId, prompt: input.prompt, ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) } });
      if (!accepted.ok) throw failure(accepted.error.code, accepted.error.message);
      record.view = { ...record.view, stage: "accepted", turnId: accepted.turn.turnId };
      this.deps.store.save(record);
      if (!accepted.reused) void this.deps.conversations.dispatchTurn(accepted.turn.turnId);
    } catch (error) {
      record.view = { ...record.view, stage: "failed", error: { code: (error as { code?: string }).code ?? UNCONFIRMED_RESULT_ERROR_CODE, message: error instanceof Error ? error.message : UNCONFIRMED_RESULT_MESSAGE } };
      this.deps.store.save(record);
    }
    return record.view;
  }
}
function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }
