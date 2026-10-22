/**
 * ChatGPT 生成面板 → 宿主 Agent 会话的纯派生
 * （change: 2026-10-12-add-agent-conversation-panel，任务 4.1/4.2/4.3 / design D3/D6）。
 *
 * 生成面板主操作仍是首轮启动入口：本模块把「用户当下看到并确认的输入」与当前生成目标身份
 * 组成冻结的 `AgentEntryIntent`，并给出面板状态派生。纯函数、无副作用，便于在不挂载渲染环境
 * 的情况下覆盖目标动作/写范围与状态映射（任务 6.1）。
 *
 * 约束（design D3/任务 4.2）：
 * - 对象动作（片场片段内对象）必须带显式 `clipId`，否则不发送，MUST NOT 退化成整体片场修改；
 * - camera 动作使用稳定 `cameraId`（不写索引），模型/片场/镜头使用稳定 nodeId；
 * - `discuss` 只读，不携带目标写许可。
 */
import type { AgentEntryIntent, AgentEntryAction, AgentTargetMode, ConversationTurnStatus } from "@woohaa3/contracts";

export type GenerationTargetMode = "model3d" | "film-set" | "camera";

/**
 * 由生成面板当前目标派生 entry intent。
 *
 * `camera` 是「调整镜头」，其余是「生成」；片场片段内对象的修改通过 `itemId`/`clipId` 声明。
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
  clipId?: string | null;
  itemId?: string | null;
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
    ...(input.clipId ? { clipId: input.clipId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    prompt: input.prompt
  };
}

/**
 * 对象动作是否可安全发送：声明了片段内对象（itemId）却没有 clipId 时必须阻止，
 * MUST NOT 扩大成整体片场修改（design D3 / 任务 4.2）。
 */
export function isEntryIntentSendable(intent: AgentEntryIntent): boolean {
  if (intent.itemId !== undefined && intent.clipId === undefined) return false;
  if (intent.mode === "camera" && intent.nodeId === undefined) return false;
  return intent.prompt.trim() !== "";
}

/** 面板状态派生：终态回合不再轮询（unknown 仍需用户显式查询核对）。 */
export function isTerminalTurnStatus(status: ConversationTurnStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled";
}
