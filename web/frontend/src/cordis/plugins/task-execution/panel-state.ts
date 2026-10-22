/**
 * 节点面板状态派生（change: split-web-runtime-services，任务 6.2）。
 *
 * 浏览器不再承担任务终态：面板状态一律从**权威派生**的 `nodeData` 读取，本模块只做
 * 一次安全映射，不写任何状态。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";

/** 未提交草稿的最小读取面（`NodeExecutionDraft` 的结构子集）。 */
export type PanelDraftInput = {
  prompt?: string;
  parameters?: Record<string, unknown>;
};

/**
 * 面板受控 draft 派生。
 *
 * 草稿只在浏览器内存中存活、刷新即丢；**已提交**的 prompt/parameters 由 Canvas Service
 * 写入权威 `nodeData`（见 run-service 的 begin 事务）。因此刷新后必须回落到 `nodeData`，
 * 与批量执行、宿主自身 blocking 检查使用同一「草稿覆盖规范值」顺序，否则面板会丢掉
 * 上次执行记录并把参数重置为目录默认值。
 */
export function derivePanelDraft(
  nodeData: CanvasNodeData,
  draft: PanelDraftInput | undefined
): { prompt: string; parameters: Record<string, unknown> } {
  return {
    prompt: draft?.prompt ?? (typeof nodeData.prompt === "string" ? nodeData.prompt : ""),
    parameters: {
      ...(nodeData.parameters ?? {}),
      ...(draft?.parameters ?? {})
    }
  };
}

/** 面板状态派生：nodeData → `ExecutionPanelData` 里的受控字段（任务 6.5）。 */
export function derivePanelTaskState(nodeData: CanvasNodeData): {
  taskStatus: "idle" | "pending" | "processing" | "successed" | "failed";
  progress?: number;
  errorMessage?: string;
} {
  const status = nodeData.taskStatus;
  if (status === "cancelled") {
    return {
      taskStatus: "failed",
      progress: nodeData.progress,
      errorMessage: nodeData.errorMessage ?? "任务已取消"
    };
  }
  if (
    status === "idle" ||
    status === "pending" ||
    status === "processing" ||
    status === "successed" ||
    status === "failed"
  ) {
    return {
      taskStatus: status,
      progress: nodeData.progress,
      // `null` 是"显式清除错误"，面板要看到 undefined 而不是 null。
      errorMessage: nodeData.errorMessage ?? undefined
    };
  }
  return { taskStatus: "idle" };
}
