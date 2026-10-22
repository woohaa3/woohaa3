import { createHash } from "node:crypto";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowError, type Artifact, type Operation } from "../../state/shared/workflow.js";
import type { ExecutionContext } from "./service.js";
import { setOutputState } from "./output-jobs.js";
import { imageRequestParameters } from "./image-request.js";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1500));
const failureMessage = (label: string, error?: { code?: string; message: string }): string => {
  if (error?.code === "InputTextSensitiveContentDetected") {
    return `“${label}”的输入提示词触发了生成服务的内容安全检查。已完成项已保留，请调整该产物提示词后重新执行。`;
  }
  return error?.message
    ? `“${label}”制作失败：${error.message}`
    : `“${label}”制作失败，已完成项已保留。`;
};

/** Task facade 提供稳定任务键。恢复使用同一任务身份，未知提交只查询，不生成新候选。 */
export async function task(context: ExecutionContext, services: ApplicationExtensionServices, label: string, modelType: "language" | "image" | "video", prompt: string, inputs: Artifact[], parameters: Record<string, unknown> = {}, options: { modelKey?: string; stableAcrossGates?: boolean } = {}): Promise<Artifact> {
  const stage = context.run.stages[context.stageId];
  const attempt = stage.outputAttempts?.[context.outputKey ?? "main"] ?? 0;
  const key = `creature-${digest([context.run.canvasId, context.run.nodeId, context.run.instanceId, context.stageId, stage.revision, options.stableAcrossGates ? "production" : stage.gate, label, ...(attempt ? [attempt] : [])])}`;
  let operation = stage.operations.find(item => item.key === key);
  if (operation?.artifact) return operation.artifact;
  const modelKey = options.modelKey ?? stage.input.modelKey;
  if(modelType === "image")parameters=imageRequestParameters(modelKey,parameters);
  if (!modelKey) throw new WorkflowError("model-not-configured", "请选择制作模型。");
  if (!services.tasks.result) throw new WorkflowError("task-result-unavailable", "宿主未提供完整任务结果读取能力。");
  if (!operation) {
    operation = { key, modelKey, outputKey: context.outputKey, attempt, state: "prepared", executorVersion: "task-v2", inputDigest: digest({prompt, inputs, parameters, modelKey}) } satisfies Operation;
    stage.operations.push(operation); await context.checkpoint();
  }
  if (operation.state === "unknown") {
    const found = await services.tasks.status(key);
    if (!found) throw new WorkflowError("submit-unknown", "任务提交结果未知，需先核对任务记录。");
    operation.state = "submitted"; await context.checkpoint();
  }
  if (operation.state === "failed") throw new WorkflowError("task-failed", "任务已失败，请重新执行当前步骤创建新候选。");
  if (operation.state === "prepared") {
    await context.assertCurrent();
    const refs = inputs.filter(item => item.storageKey && (item.kind === "image" || item.kind === "video")).map(item => ({ assetId: item.id, role: item.role ?? (item.kind === "video" ? "reference_video" : "reference_image"), storageKey: item.storageKey!, mediaType: item.contentType ?? "image/png", mediaKind: item.kind }));
    operation.state = "unknown"; await context.checkpoint();
    try {
      const receipt = await services.tasks.submit({ workerTaskKey: key, modelKey: operation.modelKey, modelType, prompt, inputs: refs, parameters });
      if (!receipt.ok) { operation.state = "failed"; await context.checkpoint(); throw new WorkflowError(receipt.code, receipt.message); }
      operation.state = "submitted"; await setOutputState(context, receipt.state === "running" ? "running" : "queued"); await context.checkpoint();
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      operation.state = "unknown"; await context.checkpoint();
      throw new WorkflowError("submit-unknown", "任务受理结果未知，不能重复提交。");
    }
  }
  while (!context.isStopped()) {
    await context.assertCurrent();
    const response = await services.tasks.result(key);
    if (response?.state === "queued" || response?.state === "running") await setOutputState(context, response.state);
    if (response?.state === "failed" || response?.state === "cancelled") {
      operation.state = "failed";
      await context.checkpoint();
      throw new WorkflowError(response.error?.code ?? "task-failed", failureMessage(label, response.error));
    }
    if (response?.state === "succeeded") {
      const result = response.result;
      if (!result) throw new WorkflowError("incomplete-result", `“${label}”任务没有返回可读取的结果，当前步骤无法验收。请重新执行当前步骤。`);
      if (result.textTruncated) throw new WorkflowError("incomplete-result", `“${label}”任务返回的文本已被截断，当前步骤无法验收。请重新执行当前步骤。`);
      const artifact: Artifact = { id: key, title: label, kind: modelType === "language" ? "text" : modelType,
        ...(result.storageKey ? { storageKey: result.storageKey, contentType: result.contentType, checksum: result.checksum, size: result.size } : {}), ...(result.text ? { text: result.text } : {}) };
      if (artifact.kind !== "text" && (!artifact.storageKey || !artifact.checksum)) throw new WorkflowError("incomplete-result", `“${label}”任务返回的媒体缺少可读取的内容引用，当前步骤无法验收。请重新执行当前步骤。`);
      await setOutputState(context, "processing");
      operation.state = "succeeded"; operation.artifact = artifact; await context.checkpoint();
      return artifact;
    }
    await pause();
  }
  throw new WorkflowError("executor-stopped", "扩展已暂停，制作记录可恢复。");
}

