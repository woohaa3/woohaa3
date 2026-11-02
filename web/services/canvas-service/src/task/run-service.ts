/**
 * Canvas run/cancel application service（change: split-web-runtime-services，任务 5.3）。
 *
 * 浏览器只发 run/cancel；Canvas 从 published Y.Doc 解析权威输入，事务记录
 * activeRunId/job/workerTaskKey 后**异步** submit Task（proposal BREAKING / design D6）：
 *
 * 1. 从权威画布解析 run，提交 begin（nodeData.activeRunId + job）到 room（durable）。
 * 2. 以稳定 `workerTaskKey` 调 Task submit；begin 后崩溃由启动扫描重提。
 * 3. 终态由 projector 从 Task history 消费并投影（不在本模块）。
 */
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/index.js";
import type { CanvasTaskCatalog, CanvasTaskModelType, CanvasRunRequest, CanvasTaskNodeType, CanvasTaskInput, WorldCaptureGenerationBinding } from "@woohaa3/contracts";
import { catalogModelBindings, checkModelCapability, compileVideoEditProviderPrompt, isNodeModelTypeMatch, NODE_TYPE_TO_TASK_KIND, readGenerationMode, readVideoEditIntents, validateGenerationModeInputs, worldCaptureReferenceInput } from "@woohaa3/contracts";
import type { CanvasTaskClient } from "../clients/task-client.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";
import { resolveMentionsAndCompile } from "./mention-resolution.js";
import {
  EMPTY_UPSTREAM_TEXT_CODE,
  EMPTY_UPSTREAM_TEXT_MESSAGE,
  resolveImagePrompt
} from "./prompt-resolution.js";

/** 读取节点的规范 nodeData（不存在的节点返回 undefined）。 */
function nodeDataOf(canvas: { nodeData: Record<string, unknown>; document: { nodes: ReadonlyArray<{ id: string }> } }, nodeId: string): { videoEditIntents?: unknown } | undefined {
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return undefined;
  return canvas.nodeData[nodeId] as { videoEditIntents?: unknown } | undefined;
}

export type RunServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  taskClient: CanvasTaskClient;
  resolveCatalog: () => Promise<CanvasTaskCatalog>;
  /** 生成稳定 workerTaskKey；默认由 runId 派生（同一 run 重试同 key）。 */
  createWorkerTaskKey?: (input: { canvasId: string; nodeId: string; runId: string }) => string;
  /**
   * 判定聚合节点（片场等）。聚合节点同一时间至多一个运行任务，由权威入口保证
   * （change: 2026-10-12-unify-generation-history-strip，design D5）。
   */
  isAggregateNode?: (node: { type: string }) => boolean;
  /** T10 trusted framing claims; absent means capture-bound runs fail closed. */
  worldCapture?: import("../world-authoring/capture-service.js").WorldCaptureService | null;
  now?: () => string;
  logger?: (event: Record<string, unknown>) => void;
};

export type RunOutcome =
  | { ok: true; runId: string; jobId: string; workerTaskKey: string; state: "accepted" }
  | { ok: false; code: string; message: string };

export type CancelOutcome =
  | { ok: true; state: "cancel-requested" }
  | { ok: false; code: string; message: string };

export class CanvasRunService {
  private readonly deps: RunServiceDependencies;

  constructor(deps: RunServiceDependencies) {
    this.deps = deps;
  }

  async run(request: CanvasRunRequest, context?: { owner: string }): Promise<RunOutcome> {
    const selectedSource = request.parameters.serviceConnectionId;
    const sourceOwner = context?.owner;
    if (selectedSource !== undefined && (typeof selectedSource !== "string" || !selectedSource || !sourceOwner)) return { ok: false, code: "source-owner-unavailable", message: "个人来源需要当前可信用户，请重新发起运行" };
    const room = await this.deps.resolveRoom(request.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${request.canvasId} 不存在` };

    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const canvas = exported.canvas;

    const node = canvas.document.nodes.find((entry) => entry.id === request.nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${request.nodeId} 不存在` };

    // T10: validate the exact framing frozen at click time before anything durable is
    // written. A later canvas change must not rewrite this binding, and a forged or
    // expired binding is rejected instead of borrowing the current capture.
    let worldCapture: WorldCaptureGenerationBinding | undefined;
    if (request.worldCapture) {
      const captureService = this.deps.worldCapture;
      if (!captureService) {
        return { ok: false, code: "capture-unavailable", message: "取景服务未装配，不能受理带取景的生成" };
      }
      const claim = captureService.claimForGeneration({
        canvasId: request.canvasId,
        requestId: request.worldCapture.requestId,
        binding: request.worldCapture
      });
      if (!claim.ok) {
        return { ok: false, code: claim.code, message: claim.message };
      }
      worldCapture = claim.binding;
    }

    if (node.type === "text") return { ok: false, code: "assistant-required", message: "文本生成需要助手连接和模型，请从助手文本入口提交" };

    // 聚合节点（片场等）同一时间至多一个运行任务：权威入口保证，而非仅前端禁用
    // （change: 2026-10-12-unify-generation-history-strip，design D5）。
    if (this.deps.isAggregateNode?.(node)) {
      const activeNode = (canvas.nodeData as Record<string, { taskStatus?: string } | undefined>)[request.nodeId];
      const status = activeNode?.taskStatus;
      if (status === "pending" || status === "queued" || status === "processing" || status === "running") {
        return { ok: false, code: "operation-in-progress", message: "该聚合节点已有运行中的任务" };
      }
    }

    // 模型身份只接受 opaque modelKey（change: 2026-10-07-remove-residual-compatibility）。
    const catalog = await this.deps.resolveCatalog();
    if (!catalog.available) {
      return { ok: false, code: "catalog-unavailable", message: catalog.reason ?? "任务目录不可用" };
    }
    const modelKey = request.modelKey;
    if (!modelKey) {
      return { ok: false, code: "unknown-model", message: "请求缺少 modelKey，请重新选择模型" };
    }
    const model = catalog.models.find((entry) => entry.modelKey === modelKey);
    if (!model) return { ok: false, code: "unknown-model", message: `模型 ${modelKey} 不可用` };
    const nodeType: CanvasTaskNodeType =
      node.type === "text" || node.type === "image" || node.type === "video" || node.type === "audio"
        ? node.type
        : "image";
    if (!isNodeModelTypeMatch(nodeType, model.modelType)) {
      return { ok: false, code: "node-model-mismatch", message: `${nodeType} 节点不能使用 ${model.modelType} 模型` };
    }

    // 权威输入解析：只信当前 published 状态。bindings 是 catalog 唯一输入契约（旧图片字段已不再读取）。
    const bindings = catalogModelBindings(model);

    // 权威 prompt 解析（spec「Canvas Service authoritatively resolves text prompts」）：
    // prompt 为空时用连入文字节点的内容当图片任务提示词；空内容在 begin 前拒绝。
    const panelKind = NODE_TYPE_TO_TASK_KIND[nodeType];
    const promptResolution = resolveImagePrompt({
      canvas,
      nodeId: request.nodeId,
      panelKind,
      typed: request.prompt
    });
    if (promptResolution.kind === "empty-upstream-text") {
      return { ok: false, code: EMPTY_UPSTREAM_TEXT_CODE, message: EMPTY_UPSTREAM_TEXT_MESSAGE };
    }
    const resolvedPrompt = promptResolution.text;
    if (resolvedPrompt.trim().length === 0) {
      return { ok: false, code: "empty-prompt", message: "请先输入提示词" };
    }

    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: request.nodeId, bindings });
    if (resolution.blockingReasons.length > 0) {
      return { ok: false, code: "invalid-input", message: resolution.blockingReasons[0] };
    }

    // mention 权威校验与 prompt 编译（change: add-reference-inputs-and-mentions，任务 5.1–5.4）：
    // authored = 用户提交的 token 化原文（保留）；provider = 编译后的可读文本。
    const authored = promptResolution.text;
    const compiled = resolveMentionsAndCompile({
      canvas,
      nodeId: request.nodeId,
      authored,
      bindings,
      directInputs: resolution.inputs
    });
    if (compiled.kind !== "ok") {
      return { ok: false, code: "invalid-mention", message: compiled.message };
    }
    let providerPrompt = compiled.providerText;
    if (providerPrompt.trim().length === 0) {
      return { ok: false, code: "empty-prompt", message: "请先输入提示词" };
    }
    const taskInputs: CanvasTaskInput[] = [...compiled.inputs];

    // T10: a claimed framing is a real provider reference, not just job metadata.
    // Materialize the exact verified media identity and reject models that cannot
    // accept reference_image before any durable begin/job write happens.
    if (worldCapture) {
      const captureInput = worldCaptureReferenceInput(worldCapture);
      if (!captureInput.ok) {
        return { ok: false, code: captureInput.code, message: captureInput.message };
      }
      taskInputs.push(captureInput.input);
      const capability = checkModelCapability(
        {
          modelKey: model.modelKey,
          modelType: model.modelType,
          inputs: taskInputs
        } as never,
        model
      );
      if (!capability.ok) {
        return {
          ok: false,
          code: capability.code,
          message: `模型 ${model.modelKey} 不接受该取景参考图：${capability.message}`
        };
      }
    }

    // edit_video：再次 sanitize/validate intents，确定性地编译进 provider prompt（change:
    // port-video-editing-dialogs，design D8）。只有授权且稳定的 annotation preview 才会在
    // prompt 中生成 `@imageN` 引用标记；缺 prompt、越界、超限或临时媒体使提交以稳定错误失败，
    // 不静默跳过。任务输入的 role/数量约束仍由下方 generationMode 校验统一把关。
    const generationMode = readGenerationMode(request.parameters);
    if (model.modelType === "video" && generationMode === "edit_video") {
      const intentResult = readVideoEditIntents(nodeDataOf(canvas, request.nodeId));
      if (!intentResult.ok) {
        return { ok: false, code: "invalid-video-edit-intent", message: intentResult.error };
      }
      if (intentResult.value.length > 0) {
        const intentPrompt = compileVideoEditProviderPrompt({
          intents: intentResult.value,
          basePrompt: providerPrompt
        });
        if (!intentPrompt.ok) {
          return { ok: false, code: "invalid-video-edit-intent", message: intentPrompt.error };
        }
        providerPrompt = intentPrompt.prompt;
      }
    }

    // 视频生成模式的角色/数量约束（first_last_frame / edit_video）。合并后的 inputs 统一校验。
    if (model.modelType === "video") {
      const modeReasons = validateGenerationModeInputs(
        generationMode,
        taskInputs.map((input) => ({
          role: input.role,
          mediaKind: input.mediaKind
        })),
        bindings
      );
      if (modeReasons.length > 0) {
        return { ok: false, code: "invalid-input", message: modeReasons[0]! };
      }
    }

    const workerTaskKey =
      this.deps.createWorkerTaskKey?.({ canvasId: request.canvasId, nodeId: request.nodeId, runId: request.runId }) ??
      request.runId;

    // 1) 事务提交 begin：durable 之后才发 submit。
    // 身份写入：nodeData.modelKey 与 parameters.model 都写 modelKey（新写入只使用它）。
    const begin = await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: request.canvasId,
      commandId: `run-begin:${workerTaskKey}`,
      baseRevision: canvas.revision,
      actorId: "canvas-run-service",
      commands: [
        {
          type: "nodeData.patch",
          nodeId: request.nodeId,
          value: {
            activeRunId: request.runId,
            modelKey,
            taskStatus: "processing",
            progress: 0,
            // 保存 authored（token 化原文）；不用编译后的 provider 文本覆盖（design D4）。
            prompt: authored,
            panelPrompt: authored,
            parameters: { ...request.parameters, model: modelKey },
            error: null,
            errorMessage: null
          }
        },
        {
          type: "job.upsert",
          job: {
            id: request.jobId,
            nodeId: request.nodeId,
            taskId: workerTaskKey,
            runId: request.runId,
            // 模型身份随 begin 的 job 落盘：产物 → provenance.runId → job 即可读到当时模型
            // （change: l0-generation-provenance）。
            modelKey,
            ...(worldCapture ? { worldCapture } : {}),
            status: "running",
            updatedAt: this.deps.now?.() ?? new Date().toISOString()
          }
        }
      ]
    });
    if (!begin.ok) {
      return { ok: false, code: begin.code, message: begin.message };
    }

    // 2) 异步 submit：accepted 不等待终态；响应丢失时重试复用同 key。
    // 执行时显示快照：只从当前可信 catalog/画布投影；缺省时历史页降级为稳定 ID
    // （change: improve-task-history-experience，任务 1.3）。
    const nodeDataRecord = (canvas.nodeData as Record<string, { title?: unknown } | undefined>)[request.nodeId];
    const nodeTitle =
      typeof nodeDataRecord?.title === "string" && nodeDataRecord.title.trim() !== ""
        ? nodeDataRecord.title.trim()
        : undefined;
    const canvasTitle = typeof canvas.title === "string" && canvas.title.trim() !== "" ? canvas.title.trim() : undefined;
    try {
      await this.deps.taskClient.submit({
        workerTaskKey,
        ...(selectedSource && sourceOwner ? { serviceConnection: { serviceConnectionId: selectedSource, owner: sourceOwner } } : {}),
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        runId: request.runId,
        jobId: request.jobId,
        nodeType,
        modelType: model.modelType as CanvasTaskModelType,
        modelKey: model.modelKey,
        ...(model.interaction ? { interaction: model.interaction } : {}),
        modelTitle: model.title,
        ...(canvasTitle ? { canvasTitle } : {}),
        ...(nodeTitle ? { nodeTitle } : {}),
        prompt: providerPrompt,
        parameters: { ...request.parameters, model: modelKey },
        inputs: taskInputs,
        ...(worldCapture ? { worldCapture } : {})
      });
    } catch (error) {
      // 提交失败当场说清楚：返回 ok:false 让面板立刻显示原因，并把 begin 写下的 processing
      // 结算成 failed。留给投影器会让人一直看到「执行中」——那条路径要等 5s 轮询，而且依赖
      // Task 已经写下失败终态（2026-10-21 现场：节点转了 3 小时）。
      const message = error instanceof Error && error.message !== "" ? error.message : "任务提交失败";
      this.deps.logger?.({
        event: "canvas-run-submit-failed",
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        runId: request.runId,
        workerTaskKey,
        message
      });
      await this.settleSubmitFailure({
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        runId: request.runId,
        jobId: request.jobId,
        workerTaskKey,
        modelKey,
        ...(worldCapture ? { worldCapture } : {}),
        message
      });
      return { ok: false, code: "task-submit-failed", message };
    }

    return { ok: true, runId: request.runId, jobId: request.jobId, workerTaskKey, state: "accepted" };
  }

  /**
   * 把「begin 已落盘、但 provider 调用前就失败」的 run 结算为失败。
   *
   * begin 已经把节点写成 processing；不补偿的话用户会一直看到进度，直到投影器补记（而且那条
   * 路径还要求 Task 已写下失败终态）。这里写入与投影器同一组字段，投影器稍后补记同一终态时
   * 按 commandId 幂等，不会互相覆盖。
   *
   * latest-run-wins：节点 active run 已换成更新的 run 时什么都不写，避免把新运行标成失败。
   */
  private async settleSubmitFailure(input: {
    canvasId: string;
    nodeId: string;
    runId: string;
    jobId: string;
    workerTaskKey: string;
    modelKey: string;
    worldCapture?: WorldCaptureGenerationBinding;
    message: string;
  }): Promise<void> {
    try {
      const room = await this.deps.resolveRoom(input.canvasId);
      if (!room) return;
      const exported = room.exportCanvas();
      if (!exported.ok) return;
      const node = (exported.canvas.nodeData as Record<string, { activeRunId?: unknown } | undefined>)[input.nodeId];
      if (node?.activeRunId !== input.runId) return;
      const result = await room.submit(
        {
          protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          canvasId: input.canvasId,
          commandId: `run-submit-failed:${input.workerTaskKey}`,
          baseRevision: exported.canvas.revision,
          actorId: "canvas-run-service",
          commands: [
            {
              type: "nodeData.patch",
              nodeId: input.nodeId,
              value: {
                taskStatus: "failed",
                progress: 100,
                error: input.message,
                errorMessage: input.message
              }
            },
            {
              type: "job.upsert",
              job: {
                id: input.jobId,
                nodeId: input.nodeId,
                taskId: input.workerTaskKey,
                runId: input.runId,
                modelKey: input.modelKey,
                ...(input.worldCapture ? { worldCapture: input.worldCapture } : {}),
                status: "failed",
                error: input.message,
                updatedAt: this.deps.now?.() ?? new Date().toISOString()
              }
            }
          ]
        }
      );
      if (!result.ok) {
        this.deps.logger?.({
          event: "canvas-run-submit-failed-settle",
          status: "rejected",
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          runId: input.runId,
          code: result.code
        });
      }
    } catch (settleError) {
      // 结算写不进去只影响「多快看到失败」：Task 侧的失败终态仍会由投影器补上。
      this.deps.logger?.({
        event: "canvas-run-submit-failed-settle",
        status: "threw",
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        runId: input.runId,
        message: settleError instanceof Error ? settleError.message : String(settleError)
      });
    }
  }

  async cancel(input: { canvasId: string; nodeId: string; runId: string }): Promise<CancelOutcome> {    const room = await this.deps.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const job = exported.canvas.jobs.find((entry) => entry.runId === input.runId && entry.nodeId === input.nodeId);
    const nodeData = (exported.canvas.nodeData as Record<string, { activeRunId?: string } | undefined>)[input.nodeId];
    if (!nodeData || (!job && nodeData.activeRunId !== input.runId)) {
      return { ok: false, code: "stale-run", message: "未找到该节点的运行任务" };
    }
    const workerTaskKey = typeof job?.taskId === "string" && job.taskId !== "" ? job.taskId : input.runId;
    try {
      await this.deps.taskClient.cancel(workerTaskKey);
    } catch (error) {
      return { ok: false, code: "task-unavailable", message: "任务服务暂时不可用，取消未受理" };
      void error;
    }
    return { ok: true, state: "cancel-requested" };
  }
}
