import { createHash } from "node:crypto";
import {
  assistantTextCandidateSchema,
  agentProtocolVersion,
  decodeAssistantTextCandidate,
  stableStringify,
  type AgentEntryIntent,
  type AgentConnectionBinding,
  type AgentAdapterRunOutcome,
  type AssistantTextPort,
  type AssistantExecutionRef,
  type AssistantTextRun,
  type PreparedAgentRoleTurn,
} from "@woohaa3/contracts";
import {
  UNCONFIRMED_RESULT_ERROR_CODE,
  UNCONFIRMED_RESULT_MESSAGE,
  UNCONFIRMED_WRITE_ERROR_CODE,
} from "@woohaa3/contracts";
import type {
  AgentConversationService,
  AcceptTurnResult,
} from "./agent-conversation-service.js";
import { isDefiniteFailureCode } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import type { AgentRoleRegistry } from "../agent-roles/registry.js";
import type {
  AssistantTextStore,
  AssistantTextRecord,
} from "../repository/assistant-text-store.js";
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const delivery = (record: AssistantTextRecord) => ({
  purpose: "text-generation" as const,
  domainRequestId: record.run.domainRequestId!,
  attemptId: record.run.attemptId!,
});
const publicExecution = (run: AssistantTextRun): AssistantExecutionRef => ({
  canvasId: run.canvasId,
  targetNodeId: run.targetNodeId,
  conversationId: run.conversationId,
  turnRequestId: run.turnRequestId,
  domainRequestId: run.domainRequestId,
  attemptId: run.attemptId,
});
export class AssistantTextService {
  private active = new Set<string>();
  private pending = new Map<string, Promise<AcceptTurnResult>>();
  constructor(
    private deps: {
      store: AssistantTextStore;
      conversations: AgentConversationService;
      connections: AgentConnectionRegistry;
      registry: AgentAdapterRegistry;
      canvas?: AssistantTextPort;
      /** 文本业务入口的显式角色绑定（change: 2026-11-07-add-pluggable-agent-roles）。 */
      agentRoles?: AgentRoleRegistry;
      roleId?: string;
    },
  ) {}
  peek(owner: string, requestId: string) {
    const record = this.deps.store.get(owner, requestId);
    return record
      ? {
          canvasId: record.entry.canvasId,
          execution: publicExecution(record.run),
        }
      : null;
  }
  async accept(input: {
    owner: string;
    conversationId: string;
    requestId: string;
    entry: AgentEntryIntent;
    connection?: AgentConnectionBinding | null;
  }): Promise<AcceptTurnResult> {
    const key = JSON.stringify([input.owner, input.requestId]);
    // Validate before sharing an in-flight accept, including changes made during the first request.
    const hash = digest([input.conversationId, input.entry, input.connection]);
    const known = this.deps.store.get(input.owner, input.requestId);
    if (known && known.inputHash !== hash)
      return {
        ok: false,
        error: {
          code: "request-id-reused",
          message: "原请求不能更改目标、模型或输入",
        },
      };
    if (this.pending.has(key)) {
      await this.pending.get(key);
      return this.accept(input);
    }
    const promise = this.advance(input, hash).catch((error) => ({
      ok: false as const,
      error: {
        code: "capability-unsupported" as const,
        message: error instanceof Error ? error.message : "文本生成不可用",
      },
    }));
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
  private async validate(
    record: Pick<AssistantTextRecord, "owner" | "entry" | "connection">,
  ) {
    const { owner, connection, entry } = record;
    const view = await this.deps.connections.getConnection({
      owner,
      connectionId: connection.connectionId,
    });
    if (
      !view ||
      (!view.ready && view.authMode !== "local-login") ||
      view.adapterId !== connection.adapterId ||
      view.configRevision !== connection.configRevision ||
      view.credentialEpoch !== connection.credentialEpoch
    )
      failure("connection-unavailable", "助手连接已失效，请重新选择");
    const resolved = this.deps.registry.resolve(connection.adapterId);
    if (!resolved.ok) failure("adapter-unavailable", resolved.message);
    const catalog = await this.deps.conversations.catalog({
      owner,
      adapterId: connection.adapterId,
    });
    if (!catalog.ok) failure(catalog.error.code, catalog.error.message);
    const models = view.models.length ? view.models : catalog.models;
    const model = models.find((model) => model.id === entry.model);
    if (!entry.model || !model || view.modelsError || catalog.error)
      failure(
        "model-unavailable",
        view.modelsError ?? catalog.error ?? "请选择有效的助手模型",
      );
    const capabilities =
      ("capabilities" in model
        ? model.capabilities?.textDelivery
        : undefined) ?? view.capabilities.textDelivery;
    if (!capabilities || !resolved.handle.capabilities.textDelivery)
      failure("capability-unsupported", "此连接未提供无工具文本交付能力");
    if (
      entry.reasoningEffort &&
      !model.reasoningEfforts?.includes(entry.reasoningEffort)
    )
      failure("variant-unavailable", "所选 Variant 已失效");
    return {
      adapter: resolved.handle.adapter,
      capabilities: {
        imageInput:
          capabilities.imageInput &&
          resolved.handle.capabilities.textDelivery.imageInput,
        maxImages: Math.min(
          capabilities.maxImages,
          resolved.handle.capabilities.textDelivery.maxImages,
        ),
      },
    };
  }
  private async advance(
    input: Parameters<AssistantTextService["accept"]>[0],
    hash: string,
  ): Promise<AcceptTurnResult> {
    const canvas =
      this.deps.canvas ??
      failure("capability-unsupported", "文本交付端口未装配");
    if (
      input.entry.mode !== "text" ||
      input.entry.action === "discuss" ||
      !input.entry.nodeId ||
      !input.connection
    )
      failure("assistant-required", "请连接助手并选择模型");
    const existing = this.deps.store.get(input.owner, input.requestId);
    if (existing && existing.inputHash !== hash)
      failure("request-id-reused", "原请求不能更改输入");
    if (existing?.turnId) {
      await this.reconcile(input.owner, input.requestId);
      const turn = this.deps.conversations.queryTurn(input);
      return turn.ok
        ? {
            ok: true,
            conversation: turn.conversation,
            turn: turn.turn,
            reused: true,
          }
        : turn;
    }
    const { capabilities } = await this.validate({
      owner: input.owner,
      entry: input.entry,
      connection: input.connection,
    });
    const prepared =
      existing?.prepared ??
      (await canvas.prepare({
        owner: input.owner,
        entry: input.entry,
        capabilities,
      }));
    const id = digest([
      input.owner,
      input.entry.canvasId,
      input.conversationId,
      input.requestId,
    ]);
    const record =
      existing ??
      this.deps.store.insert({
        owner: input.owner,
        requestId: input.requestId,
        inputHash: hash,
        entry: input.entry,
        connection: input.connection,
        prepared,
        stage: "prepared",
        run: {
          canvasId: prepared.canvasId,
          targetNodeId: prepared.nodeId,
          conversationId: input.conversationId,
          turnRequestId: input.requestId,
          domainRequestId: `text:${id}`,
          attemptId: "1",
          runId: `text-run:${id}`,
          jobId: `text-job:${id}`,
          commandId: `text-commit:${id}`,
          beginCommandId: `text-begin:${id}`,
        },
      });
    const accepted = this.deps.conversations.acceptDeliveryTurn({
      ...input,
      delivery: delivery(record),
    });
    if (!accepted.ok) return accepted;
    record.turnId = accepted.turn.turnId;
    record.stage = "accepted";
    this.deps.store.save(record);
    this.deps.conversations.linkRun({
      owner: record.owner,
      requestId: record.requestId,
      runId: record.run.runId,
    });
    this.active.add(record.run.runId);
    try {
      await canvas.begin({ owner: record.owner, prepared, run: record.run });
    } catch (error) {
      this.active.delete(record.run.runId);
      record.error =
        error instanceof Error ? error.message : "提交结果无法确认";
      this.deps.store.save(record);
      this.deps.conversations.reconcileDeliveryTurn({
        owner: record.owner,
        requestId: record.requestId,
        canvasId: prepared.canvasId,
        delivery: delivery(record),
        outcome: {
          status: "failed",
          runId: record.run.runId,
          error: { code: UNCONFIRMED_RESULT_ERROR_CODE, message: record.error },
        },
      });
      await canvas
        .settle({
          owner: record.owner,
          prepared,
          run: record.run,
          status: "failed",
          message: record.error,
        })
        .catch(() => undefined);
      record.stage = "failed";
      this.deps.store.save(record);
      const queried = this.deps.conversations.queryTurn({
        owner: record.owner,
        requestId: record.requestId,
      });
      return queried.ok ? { ...accepted, turn: queried.turn } : queried;
    }
    record.stage = "begun";
    this.deps.store.save(record);
    const current = this.deps.conversations.queryTurn({
      owner: record.owner,
      requestId: record.requestId,
    });
    if (current.ok && current.turn.status === "cancelled") {
      this.active.delete(record.run.runId);
      record.stage = "cancelled";
      this.deps.store.save(record);
      await canvas.settle({
        owner: record.owner,
        prepared,
        run: record.run,
        status: "cancelled",
        message: "已停止本次文本生成",
      });
      return { ...accepted, turn: current.turn };
    }
    if (accepted.reused) {
      this.active.delete(record.run.runId);
      await this.reconcile(record.owner, record.requestId);
      const queried = this.deps.conversations.queryTurn({
        owner: record.owner,
        requestId: record.requestId,
      });
      return queried.ok ? { ...accepted, turn: queried.turn } : queried;
    }
    if (!accepted.reused)
      void this.deps.conversations
        .dispatchDeliveryTurn(record.turnId, (context) =>
          this.execute(record, context),
        )
        .finally(() => this.active.delete(record.run.runId));
    return { ...accepted, turn: { ...accepted.turn, runId: record.run.runId } };
  }
  /** 准备冻结的文本角色回合；无注册表/角色失配时返回明确原因。 */
  private prepareRoleTurn(
    record: AssistantTextRecord,
    capabilities: { imageInput: boolean; maxImages: number },
  ): PreparedAgentRoleTurn {
    const registry = this.deps.agentRoles;
    const roleId = record.entry.roleId;
    if (!registry) failure("role-unavailable", "宿主未启用 Agent 角色注册表");
    if (!roleId) failure("role-not-found", "文本请求没有选择角色");
    const result = registry.prepare({
      roleId,
      input: { prompt: record.prepared.prompt, action: "generate", mode: "text" },
      context: { prompt: record.prepared.prompt, baseline: record.prepared.baseline },
      target: { canvasId: record.prepared.canvasId, nodeId: record.prepared.nodeId, mode: "text" },
      requestId: record.requestId,
      channel: {
        toolCalling: false,
        imageInput: capabilities.imageInput,
        structuredOutput: "validated-json",
        nativeCapabilities: [],
      },
    });
    if (!result.ok) failure(result.code, result.message);
    const recorded = this.deps.conversations.recordPrepared({
      owner: record.owner,
      requestId: record.requestId,
      prepared: result.turn,
    });
    if (!recorded.ok) failure(recorded.error.code, recorded.error.message);
    return result.turn;
  }

  private async execute(
    record: AssistantTextRecord,
    context: Parameters<
      Parameters<AgentConversationService["dispatchDeliveryTurn"]>[1]
    >[0],
  ): Promise<AgentAdapterRunOutcome> {
    try {
      const { adapter, capabilities } = await this.validate(record);
      const roleTurn = this.prepareRoleTurn(record, capabilities);
      const images = await this.deps.canvas!.readImages({
        owner: record.owner,
        prepared: record.prepared,
      });
      if (context.signal.aborted) failure("cancelled", "已停止本次文本生成");
      record.stage = "calling";
      this.deps.store.save(record);
      const result = await adapter.run({
        owner: record.owner,
        connection: record.connection,
        canvasId: record.entry.canvasId,
        // A fresh native identity per candidate prevents inheriting prior write grants.
        conversationId: record.run.runId,
        turnId: record.turnId!,
        requestId: record.requestId,
        prepared: roleTurn,
        history: context.history,
        intent: {
          ...record.entry,
          action: "discuss",
          prompt: record.prepared.prompt,
        },
        candidate: {
          images,
          outputSchema: roleTurn.output.kind === "candidate"
            ? roleTurn.output.schema
            : assistantTextCandidateSchema,
        },
        signal: context.signal,
        emit: context.emit,
      });
      if (context.signal.aborted || result.status === "cancelled")
        failure("cancelled", "已停止本次文本生成");
      if (result.status !== "succeeded")
        failure(
          result.error?.code ?? "generation-failed",
          result.error?.message ?? "助手未完成文本生成",
        );
      let value: unknown;
      const raw = result.assistantText ?? "";
      try {
        value = JSON.parse(
          /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw.trim())?.[1] ?? raw,
        );
      } catch {
        failure("candidate-invalid", "助手未返回结构化文本正文");
      }
      const candidate = decodeAssistantTextCandidate(value);
      if (!candidate.ok) failure(candidate.code, candidate.message);
      record.candidate = {
        ...candidate.value,
        checksum: digest(candidate.value.text),
      };
      record.stage = "candidate";
      this.deps.store.save(record);
      context.emit({ type: "stage", stage: "committing" });
      return await this.save(record, context.signal);
    } catch (error) {
      return this.failed(record, error, context.signal.aborted);
    }
  }
  private async save(
    record: AssistantTextRecord,
    signal?: AbortSignal,
  ): Promise<AgentAdapterRunOutcome> {
    const canvas = this.deps.canvas!;
    // Receipt wins over a racing stop, including response loss after durable commit.
    const known = await canvas.lookup({ owner: record.owner, run: record.run });
    if (!known) {
      if (signal?.aborted) failure("cancelled", "已停止本次文本生成");
      await this.validate(record);
      if (
        signal?.aborted ||
        this.deps.store.get(record.owner, record.requestId)?.stage ===
          "cancelled"
      )
        failure("cancelled", "已停止本次文本生成");
    }
    if (
      !record.candidate ||
      record.candidate.checksum !== digest(record.candidate.text)
    )
      failure("candidate-invalid", "保存的候选不完整");
    record.stage = "committing";
    this.deps.store.save(record);
    // commit is idempotent and also repairs history after a lost acknowledgement.
    const receipt = await canvas.commit({
      owner: record.owner,
      prepared: record.prepared,
      run: record.run,
      text: record.candidate.text,
    });
    record.stage = "done";
    this.deps.store.save(record);
    return {
      status: "succeeded",
      assistantText: record.candidate.text,
      runId: record.run.runId,
      receipt,
    };
  }
  private async failed(
    record: AssistantTextRecord,
    error: unknown,
    cancelled = false,
  ): Promise<AgentAdapterRunOutcome> {
    const rawCode = (error as { code?: string })?.code;
    // 有明确失败原因（权限、连接、内容冲突等）时不再尝试保存：这不是「回执丢失」，而是
    // 可以证明的失败；只有无法归类的错误才复用候选并重试权威提交。
    const definite = isDefiniteFailureCode(rawCode);
    const known = !definite
      ? await this.deps.canvas
          ?.lookup({ owner: record.owner, run: record.run })
          .catch(() => null)
      : null;
    if (known && record.candidate) {
      try {
        return await this.save(record);
      } catch (saveError) {
        record.stage = "failed";
        record.error =
          saveError instanceof Error ? saveError.message : "保存结果无法确认，候选已保留";
        this.deps.store.save(record);
        await this.deps.canvas
          ?.settle({
            owner: record.owner,
            prepared: record.prepared,
            run: record.run,
            status: "failed",
            message: record.error,
          })
          .catch(() => undefined);
        return {
          status: "failed",
          runId: record.run.runId,
          error: { code: UNCONFIRMED_WRITE_ERROR_CODE, message: record.error },
        };
      }
    }
    const message =
      error instanceof Error ? error.message : UNCONFIRMED_RESULT_MESSAGE;
    const status = cancelled || rawCode === "cancelled" ? "cancelled" : "failed";
    // 有候选却没有具体错误码，说明推理已完成、缺的是权威写入回执 → write-unconfirmed；
    // 其余无法归类的错误（上游/查询不可证）才是 result-unconfirmed。
    const code = rawCode ?? (status === "cancelled"
      ? "cancelled"
      : record.candidate
        ? UNCONFIRMED_WRITE_ERROR_CODE
        : UNCONFIRMED_RESULT_ERROR_CODE);
    record.stage = status;
    record.error = message;
    this.deps.store.save(record);
    await this.deps.canvas
      ?.settle({
        owner: record.owner,
        prepared: record.prepared,
        run: record.run,
        status,
        message,
      })
      .catch(() => undefined);
    return { status, runId: record.run.runId, error: { code, message } };
  }
  async reconcile(owner: string, requestId: string) {
    const record = this.deps.store.get(owner, requestId);
    if (!record?.turnId) return;
    const turn = this.deps.conversations.queryTurn({ owner, requestId });
    if (record.stage === "done" && turn.ok && turn.turn.status === "succeeded")
      return;
    const known = await this.deps.canvas?.lookup({ owner, run: record.run });
    if (known && record.candidate) {
      const outcome = await this.save(record).catch((error) =>
        this.failed(record, error),
      );
      this.deps.conversations.reconcileDeliveryTurn({
        owner,
        requestId,
        canvasId: record.entry.canvasId,
        delivery: delivery(record),
        outcome,
      });
    } else if (
      !this.active.has(record.run.runId) &&
      !["done", "failed", "cancelled"].includes(record.stage)
    ) {
      const outcome: AgentAdapterRunOutcome = {
        status: "failed",
        runId: record.run.runId,
        error: {
          code: UNCONFIRMED_RESULT_ERROR_CODE,
          message: record.candidate
            ? "候选已保留，可重试保存；原提交回执无法确认"
            : UNCONFIRMED_RESULT_MESSAGE,
        },
      };
      record.stage = "failed";
      record.error = outcome.error!.message;
      this.deps.store.save(record);
      this.deps.conversations.reconcileDeliveryTurn({
        owner,
        requestId,
        canvasId: record.entry.canvasId,
        delivery: delivery(record),
        outcome,
      });
      await this.deps.canvas
        ?.settle({
          owner,
          prepared: record.prepared,
          run: record.run,
          status: "failed",
          message: outcome.error!.message,
        })
        .catch(() => undefined);
    }
  }
  async cancel(owner: string, requestId: string) {
    const record =
      this.deps.store.get(owner, requestId) ??
      failure("not-found", "文本执行不存在");
    await this.reconcile(owner, requestId);
    const turn = this.deps.conversations.queryTurn({ owner, requestId });
    if (turn.ok && turn.turn.status === "succeeded")
      return { ok: true as const };
    const result = this.deps.conversations.cancelTurn({ owner, requestId });
    // Active dispatch observes its AbortSignal. A recovered turn has no controller.
    if (turn.ok && ["queued", "running", "committing"].includes(turn.turn.status)) {
      record.stage = "cancelled";
      this.deps.store.save(record);
      await this.deps.canvas?.settle({
        owner,
        prepared: record.prepared,
        run: record.run,
        status: "cancelled",
        message: "已停止本次文本生成",
      });
    }
    return result;
  }
  gateway(): import("@woohaa3/contracts").AssistantTextRunGateway {
    return {
      run: async (input) => {
        if (!input.assistant)
          return {
            ok: false,
            code: "assistant-required",
            message: "文本节点需要显式助手连接和模型，不接受 Provider modelKey",
          };
        const selected = input.assistant;
        const found = this.deps.conversations.findConversationForTarget({
          owner: input.owner,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          connectionId: selected.connection.connectionId,
        });
        const created = found.conversation
          ? { ok: true as const, conversation: found.conversation }
          : this.deps.conversations.createConversation({
              owner: input.owner,
              canvasId: input.canvasId,
              nodeId: input.nodeId,
              adapterId: selected.connection.adapterId,
              connectionId: selected.connection.connectionId,
            });
        if (!created.ok) return { ok: false, ...created.error };
        const accepted = await this.accept({
          owner: input.owner,
          conversationId: created.conversation.conversationId,
          requestId: input.requestId,
          connection: selected.connection,
          entry: {
            action: "generate",
            mode: "text",
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            prompt: input.prompt,
            connectionId: selected.connection.connectionId,
            connection: selected.connection,
            model: selected.model,
            ...(this.deps.roleId ? { roleId: this.deps.roleId } : {}),
            ...(selected.reasoningEffort
              ? { reasoningEffort: selected.reasoningEffort }
              : {}),
          },
        });
        if (!accepted.ok) return { ok: false, ...accepted.error };
        const record = this.deps.store.get(input.owner, input.requestId)!;
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          runId: record.run.runId,
          jobId: record.run.jobId,
          execution: publicExecution(record.run),
          state: "accepted",
        };
      },
      status: async (input) => {
        const record = this.deps.store.findRun(
          input.owner,
          input.canvasId,
          input.nodeId,
          input.runId,
        );
        if (!record)
          return { ok: false, code: "not-found", message: "未找到此文本执行" };
        await this.reconcile(input.owner, record.requestId);
        const result = this.deps.conversations.queryTurn({
          owner: input.owner,
          requestId: record.requestId,
        });
        if (!result.ok) return { ok: false, ...result.error };
        const status = result.turn.status;
        const terminal = !["queued", "running", "committing"].includes(status);
        return {
          ok: true,
          view: {
            protocolVersion: agentProtocolVersion(),
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            runId: input.runId,
            jobId: record.run.jobId,
            execution: publicExecution(record.run),
            phase: terminal
              ? "terminal"
              : status === "queued"
                ? "queued"
                : "running",
            stale: false,
            ...(terminal
              ? {
                  state:
                    status === "succeeded"
                      ? "succeeded"
                      : status === "cancelled"
                        ? "cancelled"
                        : "failed",
                }
              : {}),
            ...(result.turn.error ? { error: result.turn.error.message } : {}),
          },
        };
      },
      cancel: async (input) => {
        const record = this.deps.store.findRun(
          input.owner,
          input.canvasId,
          input.nodeId,
          input.runId,
        );
        if (!record)
          return { ok: false, code: "not-found", message: "未找到此文本执行" };
        const result = await this.cancel(input.owner, record.requestId);
        if (!result.ok) return { ok: false, ...result.error };
        const turn = this.deps.conversations.queryTurn({
          owner: input.owner,
          requestId: record.requestId,
        });
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          runId: input.runId,
          state:
            turn.ok && turn.turn.status === "succeeded"
              ? "already-terminal"
              : "cancel-requested",
        };
      },
    };
  }
  async retry(owner: string, requestId: string) {
    const record =
      this.deps.store.get(owner, requestId) ??
      failure("not-found", "文本执行不存在");
    if (!record.candidate)
      failure("retry-unavailable", "该执行没有可复用的候选正文，请显式重新生成");
    const outcome = await this.save(record).catch((error) =>
      this.failed(record, error),
    );
    this.deps.conversations.reconcileDeliveryTurn({
      owner,
      requestId,
      canvasId: record.entry.canvasId,
      delivery: delivery(record),
      outcome,
    });
    return this.deps.conversations.queryTurn({ owner, requestId });
  }
}
