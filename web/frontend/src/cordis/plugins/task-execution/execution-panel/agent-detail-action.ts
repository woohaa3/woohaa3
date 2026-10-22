/**
 * Agent 对话详情的按状态入口映射
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.2 / design D6 状态入口表）。
 *
 * 生成面板状态区域**只**根据权威回合状态派生入口文案与显著程度；本模块是纯函数、无副作用，
 * 不打开详情、不发起查询、不重试。idle 且无既往会话时返回 `null`，避免制造空对话记录。
 *
 * 入口与阶段/错误/结果摘要一同可见，不能只靠颜色或 hover；`strong` 表示运行/终态时提升为
 * 清楚的带文字动作，`low` 表示 idle 时有既往会话时的低强调入口。
 */
import type { ConversationTurnStatus } from "@woohaa3/contracts";

/** 生成面板投影的入口状态：权威回合状态加上「尚无回合」的 idle。 */
export type AgentDetailStatus = ConversationTurnStatus | "idle";

export type AgentDetailActionEmphasis = "low" | "strong";

export type AgentDetailAction = {
  /** 具名动作文案（MUST NOT 仅为图标）。 */
  label: string;
  /** 与入口同排的摘要（阶段/结果/待核对）。 */
  summary: string;
  /** 显著程度：运行与终态为 strong，idle 既往会话为 low。 */
  emphasis: AgentDetailActionEmphasis;
};

/**
 * 由权威状态派生详情入口。
 *
 * `hasConversation` 为 false（首次、尚无任何既往会话）时返回 `null`：不制造空记录，
 * 用户仍可从提示词/模型/生成主操作启动。
 */
export function resolveAgentDetailAction(input: {
  status: AgentDetailStatus;
  hasConversation: boolean;
}): AgentDetailAction | null {
  if (!input.hasConversation) return null;
  switch (input.status) {
    case "idle":
      return { label: "对话详情", summary: "查看既往会话", emphasis: "low" };
    case "queued":
      return { label: "查看执行与对话", summary: "排队中", emphasis: "strong" };
    case "running":
      return { label: "查看执行与对话", summary: "执行中", emphasis: "strong" };
    case "committing":
      return { label: "查看执行与对话", summary: "提交中", emphasis: "strong" };
    case "failed":
      return { label: "查看原因与对话", summary: "生成失败", emphasis: "strong" };
    case "succeeded":
      return { label: "查看结果与对话", summary: "已完成", emphasis: "strong" };
    case "partial":
      return { label: "查看未完成项与对话", summary: "部分完成", emphasis: "strong" };
    case "unknown":
      return { label: "查看执行状态与对话", summary: "执行状态未知，可查看已有结果", emphasis: "strong" };
    case "cancelled":
      return { label: "查看已执行内容", summary: "已停止，可核对已提交内容", emphasis: "strong" };
    default:
      return null;
  }
}
