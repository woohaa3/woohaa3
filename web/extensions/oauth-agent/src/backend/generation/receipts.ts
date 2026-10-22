/**
 * ChatGPT 生成编排：durable 日志 → 回执重建
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import type { ChatGptGenerationMode, ChatGptGenerationReceipt } from "@woohaa3/contracts";
import type { ChatGptWorkRecord } from "../work-journal.js";

/** 由 durable 日志记录重建确定回执；admitted/running/outcome-unknown 返回 null（需按不确定处理）。 */
export function priorToReceipt(record: ChatGptWorkRecord): ChatGptGenerationReceipt | null {
  switch (record.state) {
    case "committed":
      return {
        status: "succeeded",
        llmOutput: record.llmOutput,
        requestId: record.requestId,
        mode: record.mode as ChatGptGenerationMode,
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        clipId: record.clipId,
        commandId: record.commandId ?? `chatgpt-work:${record.workId}`,
        ...(record.revision !== undefined ? { revision: record.revision } : {})
      };
    case "partial":
      return {
        status: "partial",
        llmOutput: record.llmOutput,
        requestId: record.requestId,
        mode: record.mode as ChatGptGenerationMode,
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        clipId: record.clipId,
        applied: record.applied ?? [],
        failed: record.failed ?? []
      };
    case "cancelled":
      return { status: "cancelled", requestId: record.requestId, mode: record.mode as ChatGptGenerationMode };
    case "failed":
      return { status: "failed", requestId: record.requestId, mode: record.mode as ChatGptGenerationMode, clipId: record.clipId, code: record.code ?? "failed", message: record.message ?? "生成失败", ...(record.llmOutput ? { llmOutput: record.llmOutput } : {}) };
    default:
      return null;
  }
}
