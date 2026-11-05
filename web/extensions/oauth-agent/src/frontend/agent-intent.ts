/**
 * ChatGPT 生成面板 → 宿主 Agent 会话的纯派生
 * （change: 2026-10-12-add-agent-conversation-panel，任务 4.1/4.2/4.3 / design D3/D6）。
 *
 * 生成面板主操作仍是首轮启动入口：本模块把「用户当下看到并确认的输入」与当前生成目标身份
 * 组成冻结的 `AgentEntryIntent`，并给出面板状态派生。纯函数、无副作用，便于在不挂载渲染环境
 * 的情况下覆盖目标动作/写范围与状态映射（任务 6.1）。
 *
 * 约束（design D3/任务 4.2）：
 * - camera 动作使用稳定 `cameraId`（不写索引），模型使用稳定 nodeId；
 * - `discuss` 只读，不携带目标写许可。
 */
import type { AgentEntryIntent, AgentEntryAction, AgentTargetMode, ConversationTurnStatus } from "@woohaa3/contracts";

export type GenerationTargetMode = "model3d" | "camera";

/**
 * 由生成面板当前目标派生 entry intent。
 *
 * `camera` 是「调整镜头」，其余是「生成」。
 * 返回值中的 `model` 是**账户目录冻结的模型 id**（design D5：选择失效必须要求用户处理，不自动换）。
 */
export function buildGenerationEntryIntent(input: {
  canvasId: string;
  nodeId: string;
  mode: GenerationTargetMode;
  prompt: string;
  model: string;
  expectedContentHash?: string;
  cameraId?: string | null;
}): AgentEntryIntent {
  const action: AgentEntryAction = input.mode === "camera" ? "modify" : "generate";
  return {
    action,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    mode: input.mode as AgentTargetMode,
    ...(input.model ? { model: input.model } : {}),
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
    ...(input.cameraId ? { cameraId: input.cameraId } : {}),
    prompt: input.prompt
  };
}

/**
 * 目标动作是否可安全发送：camera 必须带 nodeId；其余必须有非空提示词。
 */
export function isEntryIntentSendable(intent: AgentEntryIntent): boolean {
  if (intent.mode === "camera" && intent.nodeId === undefined) return false;
  return intent.prompt.trim() !== "";
}

/** 面板状态派生：终态回合不再轮询（unknown 仍需用户显式查询核对）。 */
export function isTerminalTurnStatus(status: ConversationTurnStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled";
}
