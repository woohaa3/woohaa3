/**
 * Agent 回合 → 统一运行状态记录投影
 * （change: show-agent-turn-running-state-on-node）。
 *
 * Agent 回合（`queued`/`running`/`committing`）此前只体现在生成面板的主按钮上，画布节点本身
 * 没有任何执行中提示；图片/视频等 Task 链路则经 `task.activity.*` 进入统一运行状态并显示进度环。
 * 本模块把宿主会话读模型里的活动回合转成**同一身份形状**的 `CanvasOperationRecord`，让节点获得
 * 与其它生成节点一致的运行态呈现。
 *
 * 边界：
 * - 纯函数，不读写 store、不发请求、不写 canonical；
 * - 只读 `active`（最后一次提交/查询得到的权威回合）：会话快照里的 `detail` 可能是更早打开的
 *   历史快照，过期后会让节点永久停在"执行中"，因此不参与投影；
 * - 操作身份用回合的 `requestId`（`agent:` 前缀避免与 Task runId 冲突）；
 * - 终态（succeeded/failed/cancelled/partial）不产生运行记录：结果仍由领域链路与详情
 *   呈现，节点不应长期停留在"执行中"。
 */
import type {
  CanvasOperationRecord,
  CanvasOperationState,
  ConversationTurn,
  ConversationTurnStatus
} from "@woohaa3/contracts";
import type { AgentConversationSnapshotView } from "../../contract/agent-conversation.js";

export const AGENT_TURN_OPERATION_PREFIX = "agent:";

/** Agent 回合的节点运行种类：片场与镜头复用既有种类，其余按 3D 模型处理。 */
function operationKindForTurn(turn: ConversationTurn): CanvasOperationRecord["kind"] {
  switch (turn.target.mode) {
    case "text":
      return "text";
    case "film-set":
      return "film-set";
    case "camera":
      return "camera";
    default:
      return "model";
  }
}

/**
 * 回合状态 → 统一运行状态。
 *
 * 只有非终态回合产生记录；失败与取消是终态，不在节点上继续显示执行中。
 */
export function operationStateForTurn(status: ConversationTurnStatus): CanvasOperationState | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "committing":
      return "running";
    default:
      return null;
  }
}

/**
 * 从会话读模型派生该画布当前运行中的 Agent 记录。
 *
 * 缺失 `nodeId` 的目标（无节点归属）不投影，避免把记录挂到不存在的节点上。
 */
export function projectAgentTurnOperations(
  snapshot: Pick<AgentConversationSnapshotView, "active" | "turnsByRequest">,
  canvasId: string
): CanvasOperationRecord[] {
  const turns = snapshot.turnsByRequest ? Object.values(snapshot.turnsByRequest) : snapshot.active ? [snapshot.active] : [];
  return turns.flatMap(({ turn }) => {
  const nodeId = turn.target.nodeId;
  if (!nodeId || turn.target.canvasId !== canvasId) return [];
  const state = operationStateForTurn(turn.status);
  if (!state) return [];
  return [
    {
      operationId: turn.target.mode === "text" && turn.runId ? turn.runId : `${AGENT_TURN_OPERATION_PREFIX}${turn.requestId}`,
      canvasId,
      nodeId,
      kind: operationKindForTurn(turn),
      state,
      owner: "server",
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt
    }
  ];
  });
}
