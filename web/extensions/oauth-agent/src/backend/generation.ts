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
import { parseCandidateText } from "./generation/candidate-codec.js";
import { AGENT_READ_ONLY_TOOLS } from "@woohaa3/contracts";
import { preparedPromptText } from "@woohaa3/agent-connections";
import { commitModel, type CommitContext } from "./generation/commit.js";
import { priorToReceipt } from "./generation/receipts.js";
import { identityOf, type GenerateRequest, type GenerationOutcome, type GenerationProgress, type RequestRecord } from "./generation/types.js";

export type { GenerateRequest, GenerationProgress, GenerationOutcome } from "./generation/types.js";
export { modelSchema } from "./generation/schemas.js";
export { parseCandidateText, overwriteGuard } from "./generation/candidate-codec.js";

export type ChatGptGenerationOptions = {
  ports: ChatGptCanvasPorts;
  codex: CodexAdapter;
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
  const journal = options.workJournal;
  const log = options.logger ?? (() => undefined);
  const workIds = new Map<string, string>();

  const markJournal = (requestId: string, patch: Partial<import("./work-journal.js").ChatGptWorkRecord>): void => {
    if (!journal) return;
    const workId = workIds.get(requestId);
    if (!workId) return;
    journal.update(workId, patch);
  };

  const epochValid = (admittedEpoch: number): boolean => !journal || journal.authEpoch() === admittedEpoch;

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

  /** 工具模式回合（design D4b）；模式由角色的输出契约决定，不由部署开关暗中切换。 */
  const runWithTools = async (
    input: GenerateRequest & { prepared: NonNullable<GenerateRequest["prepared"]> },
    record: RequestRecord,
    controller: AbortController,
    onProgress?: GenerationProgress
  ): Promise<GenerationOutcome> => {
    // 写工具 = 角色已准备工具中除去只读工具；角色声明仍是唯一来源。
    const WRITE_TOOLS = new Set(input.prepared.tools.filter((tool) => !tool.startsWith("workspace_") && !AGENT_READ_ONLY_TOOLS.includes(tool)));
    const applied: string[] = [];
    const failed: Array<{ part: string; code: string; message: string }> = [];
    record.receipt = { status: "running", requestId: input.requestId, stage: "reasoning" };
    onProgress?.({ requestId: input.requestId, stage: "reasoning" });
    const prompt = preparedPromptText(input.prepared);
    let grantToken: string | undefined;
    if (options.toolGrants) {
      try {
        const grant = await options.toolGrants.issue({
          delegation: { subject: input.prepared.workspace?.owner ?? input.ownerId, authLevel: "authenticated" },
          workId: input.prepared.workspace?.requestId ?? workIds.get(input.requestId) ?? input.requestId,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          tools: [...input.prepared.tools],
          ...(input.selectedCameraId ? { cameraId: input.selectedCameraId } : {}),
          ...(input.clipId ? { clipId: input.clipId } : {}),
          ...(input.itemId ? { itemId: input.itemId } : {})
        });
        grantToken = grant.token;
      } catch (error) {
        log({ event: "chatgpt-tool-grant-failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      const { finalResponse } = await codex.runStreamed(
        { ownerId: input.ownerId, requestId: input.requestId, prepared: input.prepared, model: input.model, prompt, signal: controller.signal,
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
            // 工具事件是观察：真正的授权与撤销校验在 MCP 工具入口逐次执行，不按累计次数终止回合。
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
        options.toolGrants.revoke(input.prepared.workspace?.requestId ?? workIds.get(input.requestId) ?? input.requestId, input.prepared.workspace ? { subject: input.prepared.workspace.owner, authLevel: "authenticated" } : undefined);
      }
    }
    if (controller.signal.aborted) return fail(record, onProgress, "cancelled", "生成已取消。", 499);
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

    // change: 2026-10-22-remove-agent-execution-limits，任务 3.3 / design D3：删除聚合节点
    // 「已有在途任务」的拒绝与每 owner 串行队列。同一目标上的并发写由 Canvas 权威内容条件与
    // 事务决定：真实冲突返回 version-conflict，不以「节点忙」或排队长度拒绝合法工作。

    return (async (): Promise<GenerationOutcome> => {
      const controller = new AbortController();
      active.set(input.requestId, { controller, ownerId: input.ownerId });
      if (!epochValid(admittedEpoch)) {
        return fail(record, onProgress, "authorization-changed", "授权已变更，已放弃该在途生成。", 409);
      }
      markJournal(input.requestId, { state: "running" });
      try {
        const read = await ports.readNode({ ownerId: input.ownerId, canvasId: input.canvasId, nodeId: input.nodeId });
        if (!read.ok) return fail(record, onProgress, read.code, read.message, 409);
        record.clipId = input.clipId;
        if (input.itemId || input.clipId) return fail(record, onProgress, "invalid-target", "片段或对象动作目标已停用，请改为模型或镜头目标。", 409);
        const prepared = input.prepared;
        if (!prepared) return fail(record, onProgress, "role-not-found", "缺少宿主准备的角色请求，拒绝从 mode 推断业务模板。", 400);
        if (prepared.output.kind === "tool-receipts") {
          return await runWithTools({ ...input, prepared }, record, controller, onProgress);
        }
        const prompt = preparedPromptText(prepared);
        // 候选 schema 来自角色输出契约；领域解码仍用它做严格校验。
        if (prepared.output.kind !== "candidate") return fail(record, onProgress, "role-output-invalid", "目标生成要求候选或工具回执输出", 400);
        const schema = prepared.output.schema;
        record.receipt = { status: "running", requestId: input.requestId, stage: "reasoning" };
        onProgress?.({ requestId: input.requestId, stage: "reasoning" });
        const { finalResponse } = await codex.runStreamed(
          { ownerId: input.ownerId, requestId: input.requestId, prepared, model: input.model, prompt, outputSchema: schema, signal: controller.signal,
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
        return await commitModel(commitCtx, input, read, parsed.value, record, onProgress);
      } catch (error) {
        if (controller.signal.aborted) return fail(record, onProgress, "cancelled", "生成已取消。", 499);
        return fail(record, onProgress, "generation-failed", error instanceof Error ? error.message : String(error), 502);
      } finally {
        active.delete(input.requestId);
      }
    })();
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
