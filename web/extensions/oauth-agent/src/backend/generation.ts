import { resolveFilmSetClip } from "@woohaa3/contracts";
/**
 * ChatGPT 3D 生成编排公共入口
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.3–3.6、4.1–4.4 / design D4/D5；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R09 —— 拆分为
 *  schema/codec/prompt/commit/receipt 子模块，本文件保留唯一 request lifecycle）。
 *
 * 编排顺序：按可信 owner 读取授权 → 读取权威目标上下文 → 构造明确目标的提示词 → 用户隔离的
 * SDK 推理 → 结构化候选校验 → 经 Canvas 权威端口幂等提交。稳定 requestId 关联推理结果与权威
 * 回执：重复的成功请求不再推理计费。
 *
 * 同 owner 初期串行推理；进度经回调发出，由 HTTP 层转同源 SSE。取消/断连中止尚未提交的工作；
 * durable commit 已发生后取消不宣称撤回已写入版本。
 */
import type { ChatGptGenerationMode, ChatGptGenerationReceipt } from "@woohaa3/contracts";
import type { ChatGptCanvasPorts } from "./ports.js";
import type { CodexAdapter, CodexRunEvent } from "./codex-adapter.js";
import type { ChatGptWorkJournal } from "./work-journal.js";
import { animationSchema, cameraSchema, modelSchema } from "./generation/schemas.js";
import { parseCandidateText } from "./generation/candidate-codec.js";
import { buildPrompt, buildToolsPrompt } from "./generation/prompts.js";
import { commitAnimation, commitCameras, commitModel, type CommitContext } from "./generation/commit.js";
import { priorToReceipt } from "./generation/receipts.js";
import { isAggregateRunNode } from "@woohaa3/contracts";
import { identityOf, type GenerateRequest, type GenerationOutcome, type GenerationProgress, type RequestRecord } from "./generation/types.js";

export type { GenerateRequest, GenerationProgress, GenerationOutcome } from "./generation/types.js";
export { modelSchema, animationSchema, cameraSchema } from "./generation/schemas.js";
export { parseCandidateText, overwriteGuard, normalizeCameraMutations, toFlatAnimation } from "./generation/candidate-codec.js";
export { buildPrompt, buildToolsPrompt } from "./generation/prompts.js";

export type ChatGptGenerationOptions = {
  ports: ChatGptCanvasPorts;
  codex: CodexAdapter;
  /** 每 owner 串行：同一 owner 的推理排队执行。 */
  maxConcurrency?: number;
  turnTimeoutMs?: number;
  /** 每 owner 最大排队深度（超出即拒绝；design D6 有界排队）。 */
  maxQueueDepth?: number;
  /** 受控 MCP 工具面（design D4b）。 */
  toolsEnabled?: boolean;
  /** 单回合允许的最大 MCP 工具调用次数（超出即终止回合）。 */
  maxToolCalls?: number;
  toolGrants?: import("@woohaa3/contracts").ApplicationToolDelegationFacade;
  workJournal?: ChatGptWorkJournal;
  logger?: (event: Record<string, unknown>) => void;
};

export type ChatGptGenerationService = {
  generate: (input: GenerateRequest, onProgress?: GenerationProgress) => Promise<GenerationOutcome>;
  cancel: (ownerId: string, requestId: string) => boolean;
  cancelOwner: (ownerId: string) => void;
  receipt: (requestId: string, ownerId?: string) => ChatGptGenerationReceipt;
  recoverInterrupted: () => void;
  dispose: () => void;
};

export function createChatGptGenerationService(options: ChatGptGenerationOptions): ChatGptGenerationService {
  const ports = options.ports;
  const codex = options.codex;
  const records = new Map<string, RequestRecord>();
  const active = new Map<string, { controller: AbortController; ownerId: string }>();
  const ownerQueues = new Map<string, Promise<unknown>>();
  const turnTimeoutMs = options.turnTimeoutMs ?? 0;
  const toolsEnabled = options.toolsEnabled === true;
  const maxToolCalls = options.maxToolCalls ?? 40;
  const journal = options.workJournal;
  const log = options.logger ?? (() => undefined);
  const workIds = new Map<string, string>();

  const markJournal = (requestId: string, patch: Partial<import("./work-journal.js").ChatGptWorkRecord>): void => {
    if (!journal) return;
    const workId = workIds.get(requestId);
    if (!workId) return;
    journal.update(workId, patch);
  };

  const enqueue = <T>(ownerId: string, task: () => Promise<T>): Promise<T> => {
    const previous = ownerQueues.get(ownerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    ownerQueues.set(ownerId, next.catch(() => undefined));
    return next;
  };

  const maxQueueDepth = options.maxQueueDepth ?? 8;
  const queuedCounts = new Map<string, number>();

  const epochValid = (admittedEpoch: number): boolean => !journal || journal.authEpoch() === admittedEpoch;

  // 聚合节点（片场）单任务门禁：同一 owner 同一节点在途生成只允许一个。
  const aggregateNodeIds = new Map<string, { nodeId: string; requestId: string }>();
  const activeKey = (ownerId: string, nodeId: string): string => `${ownerId}\u0000${nodeId}`;
  const isAggregateNodeType = (nodeType: string): boolean => isAggregateRunNode({ type: nodeType });
  const hasOtherActiveForNode = (ownerId: string, nodeId: string, requestId: string): boolean => {
    const current = aggregateNodeIds.get(activeKey(ownerId, nodeId));
    return current !== undefined && current.requestId !== requestId;
  };
  const clearAggregate = (ownerId: string, nodeId: string, requestId: string): void => {
    const key = activeKey(ownerId, nodeId);
    if (aggregateNodeIds.get(key)?.requestId === requestId) aggregateNodeIds.delete(key);
  };

  const fail = (record: RequestRecord, onProgress: GenerationProgress | undefined, code: string, message: string, status: number): GenerationOutcome => {
    record.receipt = { status: "failed", requestId: record.requestId, mode: record.mode, code, message, ...(record.llmOutput ? { llmOutput: record.llmOutput } : {}), ...(record.clipId ? { clipId: record.clipId } : {}) };
    markJournal(record.requestId, code === "cancelled" ? { state: "cancelled", code, message } : { state: "failed", code, message, llmOutput: record.llmOutput });
    onProgress?.({ requestId: record.requestId, stage: "failed", detail: message });
    return { ok: false, status, code, message };
  };

  const succeed = (record: RequestRecord, onProgress: GenerationProgress | undefined, receipt: ChatGptGenerationReceipt): GenerationOutcome => {
    receipt = { ...receipt, llmOutput: record.llmOutput, clipId: record.clipId };
    record.receipt = receipt;
    if (receipt.status === "succeeded") {
      markJournal(receipt.requestId, {
        state: "committed",
        llmOutput: record.llmOutput,
        commandId: receipt.commandId,
        ...(receipt.revision !== undefined ? { revision: receipt.revision } : {})
      });
    }
    onProgress?.({ requestId: receipt.requestId, stage: "succeeded" });
    return { ok: true, receipt };
  };

  const partial = (
    record: RequestRecord,
    onProgress: GenerationProgress | undefined,
    input: GenerateRequest,
    applied: string[],
    failed: Array<{ part: string; code: string; message: string }>
  ): GenerationOutcome => {
    const receipt: ChatGptGenerationReceipt = {
      status: "partial",
      llmOutput: record.llmOutput, clipId: input.clipId,
      requestId: input.requestId,
      mode: input.mode,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      applied,
      failed
    };
    record.receipt = receipt;
    markJournal(input.requestId, { state: "partial", applied, failed, llmOutput: record.llmOutput });
    onProgress?.({ requestId: input.requestId, stage: "partial" });
    return { ok: true, receipt };
  };

  const commitCtx: CommitContext = { ports, fail, succeed, partial };

  /** 工具模式回合（design D4b）。 */
  const runWithTools = async (
    input: GenerateRequest,
    read: Extract<Awaited<ReturnType<ChatGptCanvasPorts["readNode"]>>, { ok: true }>,
    record: RequestRecord,
    controller: AbortController,
    onProgress?: GenerationProgress
  ): Promise<GenerationOutcome> => {
    const WRITE_TOOLS = new Set(input.mode === "camera" ? (input.selectedCameraId ? ["update_model_camera", "reset_model_camera"] : ["create_model_camera"]) : input.clipId && input.mode === "film-set" ? ["mutate_film_set_clip", "export_film_set_clip"] : [
      ...(input.mode === "film-set" ? ["submit_film_set", "add_film_set_media", "export_film_set_clip", "mutate_film_set_item", "mutate_film_set_clip"] : ["submit_model_script"]),
      "create_model_camera",
      "update_model_camera",
      "delete_model_camera",
      "rename_model_camera",
      "reset_model_camera",
      "set_model_camera",
      "create_film_set_node",
      "add_film_set_media",
      "export_film_set_clip",
      "import_model_snapshot"
    ]);
    const applied: string[] = [];
    const failed: Array<{ part: string; code: string; message: string }> = [];
    let toolCalls = 0;
    record.receipt = { status: "running", requestId: input.requestId, stage: "reasoning" };
    onProgress?.({ requestId: input.requestId, stage: "reasoning" });
    const prompt = buildToolsPrompt(input, read);
    let grantToken: string | undefined;
    if (options.toolGrants) {
      try {
        const grant = await options.toolGrants.issue({
          delegation: { subject: input.ownerId, authLevel: "authenticated" },
          workId: workIds.get(input.requestId) ?? input.requestId,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          tools: [...WRITE_TOOLS, "get_model_api", "get_model_node", "get_model_statistics", "get_model_cameras", "get_film_set_clips"],
          ...(input.selectedCameraId ? { cameraId: input.selectedCameraId } : {}),
          ...(input.clipId ? { clipId: input.clipId } : {}),
          ...(input.itemId ? { itemId: input.itemId } : {}),
          maxCalls: maxToolCalls
        });
        grantToken = grant.token;
      } catch (error) {
        log({ event: "chatgpt-tool-grant-failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      const { finalResponse } = await codex.runStreamed(
        { ownerId: input.ownerId, model: input.model, prompt, signal: controller.signal,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          ...(grantToken ? { mcpGrantToken: grantToken } : {}) },
        (event: CodexRunEvent) => {
          if (event.type === "progress") {
            onProgress?.({ requestId: input.requestId, stage: event.stage, ...(event.detail ? { detail: event.detail } : {}) });
          } else if (event.type === "final") {
            onProgress?.({ requestId: input.requestId, stage: "message", message: event.text });
          } else if (event.type === "tool-started") {
            onProgress?.({ requestId: input.requestId, stage: `tool:${event.tool}`, tool: { name: event.tool, callId: event.callId, status: "started" } });
          } else if (event.type === "tool") {
            toolCalls += 1;
            if (toolCalls > maxToolCalls) {
              controller.abort();
              return;
            }
            onProgress?.({ requestId: input.requestId, stage: `tool:${event.tool}`, ...(event.status ? { detail: event.status } : {}), tool: { name: event.tool, callId: event.callId, status: event.ok ? "completed" : "failed", ok: event.ok, summary: event.message } });
            if (!WRITE_TOOLS.has(event.tool)) return;
            if (event.ok) applied.push(event.tool);
            else failed.push({ part: event.tool, code: "tool-failed", message: event.message ?? "工具调用失败" });
          }
        }
      );
      record.llmOutput = finalResponse;
    } finally {
      if (options.toolGrants && (grantToken || workIds.has(input.requestId))) {
        options.toolGrants.revoke(workIds.get(input.requestId) ?? input.requestId);
      }
    }
    if (controller.signal.aborted) return fail(record, onProgress, "cancelled", "生成已取消（或超出工具预算）。", 499);
    if (applied.length === 0 && failed.length === 0) {
      return fail(record, onProgress, "no-change", "推理完成但未对画布做出任何改动。", 422);
    }
    if (applied.length > 0 && failed.length > 0) {
      return partial(record, onProgress, input, [...new Set(applied)], failed);
    }
    if (failed.length > 0) {
      const first = failed[0]!;
      return fail(record, onProgress, first.code, first.message, 422);
    }
    const commandId = `chatgpt-tools:${input.requestId}`;
    return succeed(record, onProgress, { status: "succeeded", requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId });
  };

  const generate: ChatGptGenerationService["generate"] = async (input, onProgress) => {
    const identity = identityOf(input);
    if (journal) {
      const prior = journal.find(input.requestId, input.ownerId);
      if (prior && (prior.state === "outcome-unknown" || prior.state === "running" || prior.state === "admitted")) {
        const receipt: ChatGptGenerationReceipt = { status: "unknown", requestId: input.requestId };
        records.set(input.requestId, { requestId: input.requestId, identity, mode: input.mode, receipt });
        return { ok: true, receipt };
      }
      if (prior && prior.inputIdentity === identity) {
        const receipt = priorToReceipt(prior);
        if (receipt) {
          records.set(input.requestId, { requestId: input.requestId, identity, mode: input.mode, receipt });
          return { ok: true, receipt };
        }
      }
    }
    const existing = records.get(input.requestId);
    if (existing) {
      if (existing.identity !== identity) {
        return { ok: false, status: 409, code: "request-id-conflict", message: "相同 requestId 的输入不一致，拒绝复用。" };
      }
      if (existing.receipt.status !== "running") return { ok: true, receipt: existing.receipt };
    }
    const record: RequestRecord = existing ?? { requestId: input.requestId, identity, mode: input.mode, receipt: { status: "running", requestId: input.requestId, stage: "queued" } };
    records.set(input.requestId, record);
    record.receipt = { status: "running", requestId: input.requestId, stage: "queued" };
    const queued = queuedCounts.get(input.ownerId) ?? 0;
    if (queued >= maxQueueDepth) {
      return { ok: false, status: 429, code: "queue-full", message: "该账户的生成队列已满，请稍后重试。" };
    }
    queuedCounts.set(input.ownerId, queued + 1);
    let admittedEpoch = journal ? journal.authEpoch() : 0;
    if (journal) {
      const admitted = journal.admit({
        requestId: input.requestId,
        ownerId: input.ownerId,
        authEpoch: admittedEpoch,
        inputIdentity: identity,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        mode: input.mode,
        clipId: input.clipId,
        itemId: input.itemId
      });
      workIds.set(input.requestId, admitted.workId);
      admittedEpoch = admitted.authEpoch;
    }
    onProgress?.({ requestId: input.requestId, stage: "queued" });

    // 聚合节点（片场）单任务门禁在**权威受理点**保证：3D 生成按 (ownerId,nodeId) 预留，
    // 已有在途任务时直接拒绝（change: 2026-10-12-unify-generation-history-strip，design D5）。
    // 非 3D 模式不参与预留；预留后若读到的节点不是聚合节点则立即释放（见下）。
    const is3dMode = input.mode === "model3d" || input.mode === "film-set" || input.mode === "camera";
    if (is3dMode) {
      if (hasOtherActiveForNode(input.ownerId, input.nodeId, input.requestId)) {
        return { ok: false, status: 409, code: "operation-in-progress", message: "该聚合节点已有运行中的生成任务" };
      }
      aggregateNodeIds.set(activeKey(input.ownerId, input.nodeId), { nodeId: input.nodeId, requestId: input.requestId });
    }

    return enqueue(input.ownerId, async (): Promise<GenerationOutcome> => {
      queuedCounts.set(input.ownerId, Math.max(0, (queuedCounts.get(input.ownerId) ?? 1) - 1));
      const controller = new AbortController();
      active.set(input.requestId, { controller, ownerId: input.ownerId });
      const timeout = turnTimeoutMs > 0 ? setTimeout(() => controller.abort(), turnTimeoutMs) : undefined;
      if (!epochValid(admittedEpoch)) {
        return fail(record, onProgress, "authorization-changed", "授权已变更，已放弃该在途生成。", 409);
      }
      markJournal(input.requestId, { state: "running" });
      try {
        const read = await ports.readNode({ ownerId: input.ownerId, canvasId: input.canvasId, nodeId: input.nodeId });
        if (!read.ok) return fail(record, onProgress, read.code, read.message, 409);
        record.clipId = input.clipId;
        if (input.mode === "camera" && input.selectedCameraId && !read.cameras.some(camera => camera.id === input.selectedCameraId)) return fail(record, onProgress, "unknown-camera", "Selected camera no longer exists", 409);
        if (input.mode === "camera" && input.clipId && read.animation && !resolveFilmSetClip(read.animation, input.clipId)) return fail(record, onProgress, "unknown-clip", "Selected clip no longer exists", 409);
        // 预留针对的是「3D 目标」；读到的节点不是聚合节点时释放预留，不误伤普通模型节点。
        if (is3dMode && !isAggregateNodeType(read.nodeType)) clearAggregate(input.ownerId, input.nodeId, input.requestId);
        if (input.itemId && (!read.animation?.filmSetContent.items.some(item => item.id === input.itemId) || !input.clipId)) return fail(record, onProgress, "unknown-item", "生成目标对象或片段不存在", 409);
        if (input.itemId && !toolsEnabled) return fail(record, onProgress, "tools-required", "对象动作生成需要启用片段工具能力", 409);
        if (input.mode === "film-set" && read.animation) {
          // 片场生成按片段定位：captured clipId 必须仍存在；不把视图回写到 read（items-only 完整节点保留）。
          if (input.clipId && !resolveFilmSetClip(read.animation, input.clipId)) {
            return fail(record, onProgress, "unknown-clip", "生成目标片段不存在", 409);
          }
          if (input.itemId && !input.clipId) return fail(record, onProgress, "clip-required", "对象动作生成必须指定目标片段", 409);
        }
        if (toolsEnabled) {
          return await runWithTools(input, read, record, controller, onProgress);
        }
        const prompt = buildPrompt(input, read);
        const schema = input.mode === "model3d" ? modelSchema() : input.mode === "film-set" ? animationSchema() : cameraSchema();
        record.receipt = { status: "running", requestId: input.requestId, stage: "reasoning" };
        onProgress?.({ requestId: input.requestId, stage: "reasoning" });
        const { finalResponse } = await codex.runStreamed(
          { ownerId: input.ownerId, model: input.model, prompt, outputSchema: schema, signal: controller.signal,
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) },
          (event: CodexRunEvent) => {
            if (event.type === "progress") onProgress?.({ requestId: input.requestId, stage: event.stage, ...(event.detail ? { detail: event.detail } : {}) });
          }
        );
        record.llmOutput = finalResponse;
        if (controller.signal.aborted) return fail(record, onProgress, "cancelled", "生成已取消。", 499);
        const parsed = parseCandidateText(finalResponse);
        if (!parsed.ok) return fail(record, onProgress, "invalid-candidate", parsed.message, 422);

        onProgress?.({ requestId: input.requestId, stage: "committing" });
        if (input.mode === "model3d") return await commitModel(commitCtx, input, read, parsed.value, record, onProgress);
        if (input.mode === "film-set") return await commitAnimation(commitCtx, input, read, parsed.value, record, onProgress);
        return await commitCameras(commitCtx, input, read, parsed.value, record, onProgress);
      } catch (error) {
        if (controller.signal.aborted) return fail(record, onProgress, "cancelled", "生成已取消。", 499);
        return fail(record, onProgress, "generation-failed", error instanceof Error ? error.message : String(error), 502);
      } finally {
        clearTimeout(timeout);
        active.delete(input.requestId);
        clearAggregate(input.ownerId, input.nodeId, input.requestId);
      }
    });
  };

  return {
    generate,
    cancel: (ownerId, requestId) => {
      const entry = active.get(requestId);
      if (!entry || entry.ownerId !== ownerId) return false;
      entry.controller.abort();
      codex.cancel(ownerId);
      return true;
    },
    cancelOwner: (ownerId) => {
      for (const [requestId, entry] of active) {
        if (entry.ownerId !== ownerId) continue;
        entry.controller.abort();
        active.delete(requestId);
      }
      codex.disposeOwner(ownerId);
    },
    receipt: (requestId, ownerId) => {
      const local = records.get(requestId)?.receipt;
      if (local && local.status !== "unknown") return local;
      if (journal && ownerId) {
        const record = journal.find(requestId, ownerId);
        if (record) return priorToReceipt(record) ?? { status: "unknown", requestId };
      }
      return local ?? { status: "unknown", requestId };
    },
    recoverInterrupted: () => {
      const interrupted = journal?.recoverInterrupted() ?? [];
      for (const record of interrupted) {
        records.set(record.requestId, {
          requestId: record.requestId,
          identity: record.inputIdentity,
          mode: record.mode as ChatGptGenerationMode,
          receipt: { status: "unknown", requestId: record.requestId }
        });
      }
      if (interrupted.length > 0) log({ event: "chatgpt-generation-recovered", count: interrupted.length });
    },
    dispose: () => {
      for (const entry of active.values()) entry.controller.abort();
      active.clear();
      codex.dispose();
    }
  };
}
