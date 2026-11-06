/**
 * 未提交视频节点的状态派生
 * （change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 现场 N12：视频节点创建后从未提交 prompt/model 或 provider 任务，`taskStatus` 仍是
 * `idle`，节点卡片却是空的——用户既看不出「还没提交」，也容易把它读成生成失败。这里只做
 * 一次纯派生：没有 active run、没有产出、也没进入终态的视频节点，统一显示「未提交 · 待配置」。
 */
import type { CanvasNodeData } from "./domain/index.js";

/** 未提交视频节点的统一文案（节点卡片与执行面板共用）。 */
export const UNSUBMITTED_VIDEO_LABEL = "未提交 · 待配置";

/** 执行入口的补充提示：让空节点下一步做什么一目了然。 */
export const UNSUBMITTED_VIDEO_HINT = "选择模型并填写提示词后提交";

/**
 * 该节点是否是「从未提交过任务」的视频节点。
 *
 * 判定只看规范 `nodeData`：有 active run、有产出或已经是终态（successed/failed/cancelled）
 * 都不算未提交。`pending` / `processing` 属于运行态，同样不算。
 */
export function isUnsubmittedVideoNode(
  type: string | undefined,
  data: CanvasNodeData | undefined
): boolean {
  if (type !== "video") return false;
  if (!data) return true;
  if (typeof data.outputAssetId === "string" && data.outputAssetId !== "") return false;
  if (typeof data.activeRunId === "string" && data.activeRunId !== "") return false;
  const status = data.taskStatus;
  return status === undefined || status === "idle";
}
