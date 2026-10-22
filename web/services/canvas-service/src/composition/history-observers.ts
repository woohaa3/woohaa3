/**
 * Canvas Service composition：历史观察者与缩略图端口
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 只在 room 提交后由权威命令触发留档；不持有第二份状态。
 */
import { nodeHistoryKindForNodeType, type ServerCanvas } from "@woohaa3/contracts";
import { NodeHistoryThumbnailJob } from "../model-renderer/index.js";
import type { NodeHistoryThumbnailOptions } from "../model-renderer/node-history-thumbnail.js";
import type { RendererClient } from "../model-renderer/index.js";
import type { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import type { PptaskExecutionRecord } from "../sync/index.js";

/**
 * 把成功的任务终态登记为节点历史版本
 * （change: add-canvas-node-generation-history，任务 2.1 / 2.2）。
 */
export async function registerTaskHistoryRecord(
  service: NodeHistoryApplicationService,
  record: PptaskExecutionRecord
): Promise<void> {
  const output = record.output;
  if (!output) return;
  if (output.mediaKind === "text") {
    await service.registerTaskResult({
      canvasId: record.canvasId,
      nodeId: record.nodeId,
      runId: record.runId,
      jobId: record.jobId,
      // 溯源身份：Task worker key + 该次执行的模型（change: l0-generation-provenance）。
      taskKey: record.taskKey,
      ...(record.modelKey ? { modelKey: record.modelKey } : {}),
      kind: "text",
      createdAt: record.terminalAt,
      output: { mediaKind: "text", text: output.text ?? "" }
    });
    return;
  }
  if (!output.asset) return;
  await service.registerTaskResult({
    canvasId: record.canvasId,
    nodeId: record.nodeId,
    runId: record.runId,
    jobId: record.jobId,
    taskKey: record.taskKey,
    ...(record.modelKey ? { modelKey: record.modelKey } : {}),
    kind: output.mediaKind,
    createdAt: record.terminalAt,
    output: {
      mediaKind: output.mediaKind,
      asset: output.asset,
      ...(output.posterAsset ? { posterAsset: output.posterAsset } : {}),
      ...(output.durationSeconds !== undefined ? { durationSeconds: output.durationSeconds } : {})
    }
  });
}

/**
 * 把失败/取消/中断的任务终态登记为不可恢复的历史归档
 * （change: 2026-10-12-unify-generation-history-strip，design D3）。
 *
 * 与成功登记同样以 runId 幂等；失败登记不覆盖当前内容。`kind` 由任务节点类型派生，
 * 无法判定时按 `image` 兜底（历史条目仍按失败归档保存）。
 */
export async function registerTaskFailureRecord(
  service: NodeHistoryApplicationService,
  record: PptaskExecutionRecord
): Promise<void> {
  // 记录里没有直接的节点类型：由画布导出解析；缺失时兜底 image（历史仍可诊断）。
  const baseline = await service.readFailureBaseline(record.canvasId, record.nodeId);
  const kind = record.output?.mediaKind ?? mediaKindForNodeType(baseline?.nodeType) ?? "image";
  const message = (record.error ?? "任务未成功完成").slice(0, 2000);
  const outcome = record.status === "cancelled" ? "cancelled" : "failed";
  await service.registerTaskFailure({
    canvasId: record.canvasId,
    nodeId: record.nodeId,
    runId: record.runId,
    jobId: record.jobId,
    taskKey: record.taskKey,
    ...(record.modelKey ? { modelKey: record.modelKey } : {}),
    kind,
    outcome,
    message,
    createdAt: record.terminalAt,
    ...(baseline ? { baseline } : {}),
    inputSummary: message.slice(0, 200)
  });
}

/** 由规范节点类型派生历史内容种类（失败归档用）。 */
function mediaKindForNodeType(
  nodeType: string | undefined
): "text" | "image" | "video" | "audio" | "model" | undefined {
  switch (nodeType) {
    case "text":
    case "image":
    case "video":
    case "audio":
      return nodeType;
    case "model3d":
    case "composite-asset":
      return "model";
    default:
      return undefined;
  }
}

/**
 * 模型编辑历史登记（change: 模型编辑历史）。
 */
export async function recordModelPlacementHistory(
  nodeHistory: {
    service: {
      recordCurrentModelVersion(input: { canvasId: string; nodeId: string }): Promise<
        { ok: true; status: "inserted" | "duplicate"; entryId: string } | { ok: false; code: string; message: string }
      >;
    };
    /** 会话内操作抑制逐手势用户历史（change: 图片聚焦编辑，design D5/D6）。 */
    hasActiveSession?: (canvasId: string, nodeId: string) => Promise<boolean>;
  } | null,
  input: { canvasId: string; canvas: ServerCanvas; commands: readonly unknown[] }
): Promise<void> {
  if (!nodeHistory) return;
  const targets = new Set<string>();
  for (const command of input.commands) {
    if (!command || typeof command !== "object") continue;
    const record = command as { type?: unknown; nodeId?: unknown; value?: unknown };
    if (record.type !== "nodeData.patch" || typeof record.nodeId !== "string") continue;
    const value = record.value as Record<string, unknown> | undefined;
    if (!value || value.modelPlacement === undefined) continue;
    const node = input.canvas.document.nodes.find((candidate) => candidate.id === record.nodeId);
    if (!node || nodeHistoryKindForNodeType(node.type) !== "model") continue;
    targets.add(record.nodeId);
  }
  for (const nodeId of targets) {
    try {
      // 活跃编辑会话内的中间 patch 只维护 canonical 与最终快照，不逐条登记用户历史。
      if (nodeHistory.hasActiveSession && (await nodeHistory.hasActiveSession(input.canvasId, nodeId))) continue;
      await nodeHistory.service.recordCurrentModelVersion({ canvasId: input.canvasId, nodeId });
    } catch {
      // 留档失败不影响命令结果。
    }
  }
}

/**
 * 模型历史缩略图作业
 * （change: add-canvas-node-generation-history，任务 2.4 / design D5）。
 */
export function createThumbnailPort(
  rendererClient: RendererClient,
  service: NodeHistoryApplicationService,
  prepareCompositeHistory?: NodeHistoryThumbnailOptions["prepareCompositeHistory"]
): { render(input: { canvasId: string; nodeId: string; entryId: string }): Promise<{ ok: true; png: Buffer; cached: boolean } | { ok: false; code: string; message: string }> } {
  const job = new NodeHistoryThumbnailJob({ service, rendererClient, prepareCompositeHistory });
  return { render: (input) => job.render(input) };
}
