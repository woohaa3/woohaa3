/**
 * Run State Plugin（canvas page scope）
 * （change: 2026-10-12-unify-generation-history-strip，design D1/D2）。
 *
 * 提供**唯一**统一生成运行状态读模型：
 * - 监听 `task.activity.*` 事件写入 store（server owner）；
 * - 提供 `RUN_STATE_SERVICE`，含本地操作注册（local owner）；
 * - 装配时不拥有 WebSocket（连接由 page-owned Canvas Session 负责）。
 *
 * 该插件只做投影：不写 canonical nodeData，不伪造 taskStatus，也不产生 Canvas 命令。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { RUN_STATE_SERVICE, type RunStateService } from "../service-keys.js";
import { RunStateStore } from "./store.js";
import { projectAgentTurnOperations } from "./agent-turn-projection.js";

export const RUN_STATE_PLUGIN_ID = "run-state";

/** 回合进行中的只读刷新间隔（与生成面板一致）。 */
const AGENT_TURN_POLL_INTERVAL_MS = 1500;

export type RunStateExtensionOptions = {
  canvasId?: string;
};

export function runStateExtension(options: RunStateExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      const store = new RunStateStore({
        canvasId,
        nodeTypeOf: (nodeId) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          return canvas?.document.nodes.find((node) => node.id === nodeId)?.type;
        }
      });

      const disposeStarted = ctx.on("task.activity.started", (payload) => {
        store.applyEvent({ name: "task.activity.started", payload });
      });
      const disposeUpdated = ctx.on("task.activity.updated", (payload) => {
        store.applyEvent({ name: "task.activity.updated", payload });
      });
      const disposeFinished = ctx.on("task.activity.finished", (payload) => {
        store.applyEvent({ name: "task.activity.finished", payload });
      });

      // 权威 `nodeData` 结算：canonical 经 Yjs 通道可靠回流，即使活动通道丢失终态记录，
      // 提交中的灰点也会在画布回流后变为绿/红（change: 2026-12-12，见 notes）。
      const reconcileFromStore = () => {
        store.reconcileCanonical(workingCanvasOf(woohaa3CanvasStore.getState()));
      };
      reconcileFromStore();
      const disposeCanvas = woohaa3CanvasStore.subscribe(reconcileFromStore);

      // Agent 回合投影（change: show-agent-turn-running-state-on-node）：Agent 生成不经
      // `task.activity.*`，但节点同样要有执行中呈现。只读会话读模型，按回合身份幂等同步；
      // 服务缺失（未装配会话能力）时退化为无 Agent 运行态，不影响其它 owner。
      const agentConversations = () => ctx.get("agentConversationService" as never) as
        | import("../../services/agent-conversation-service.js").AgentConversationServiceHandle
        | undefined;

      /**
       * 回合进行中的只读刷新：生成面板关闭后节点仍要能在回合结束时熄灭运行态。
       *
       * 只按确切的 `requestId` 查询（不重新 accept/dispatch），轮询间隔与生成面板一致；
       * 无活动回合或服务缺失时不做任何请求。
       */
      let agentPollDisposed = false;
      let agentPollRunning = false;
      let agentPollTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleAgentPoll = () => {
        if (agentPollDisposed || agentPollRunning) return;
        if (agentPollTimer !== undefined) { clearTimeout(agentPollTimer); agentPollTimer = undefined; }
        const service = agentConversations();
        const snapshot = service?.getSnapshot();
        if (!service?.queryTurn || !snapshot) return;
        const turns = snapshot.turnsByRequest ? Object.values(snapshot.turnsByRequest) : snapshot.active ? [snapshot.active] : [];
        const requests = turns.filter(active => active.turn.target.canvasId === canvasId && ["queued", "running", "committing", "unknown"].includes(active.turn.status));
        if (!requests.length) return;
        agentPollTimer = setTimeout(() => {
          agentPollTimer = undefined;
          agentPollRunning = true;
          void Promise.allSettled(requests.map(active => service.queryTurn(active.requestId))).finally(() => { agentPollRunning = false; scheduleAgentPoll(); });
        }, AGENT_TURN_POLL_INTERVAL_MS);
      };

      const syncAgentTurns = () => {
        const service = agentConversations();
        if (!service) return;
        const snapshot = service.getSnapshot();
        store.syncAgentOperations(projectAgentTurnOperations(snapshot, canvasId));
      };
      syncAgentTurns();
      scheduleAgentPoll();
      const disposeAgentTurns = agentConversations()?.subscribe(() => {
        syncAgentTurns();
        // 有新回合（或回合进度变化）时才挂轮询；终态立即停止，不长期空转。
        scheduleAgentPoll();
      });

      const service: RunStateService = {
        getNodeSummary: (targetCanvasId, nodeId) =>
          targetCanvasId === canvasId ? store.getNodeSummary(nodeId) : null,
        subscribe: store.subscribe,
        snapshot: () => store.getSnapshot(),
        isBusy: (targetCanvasId, nodeId) => targetCanvasId === canvasId && store.isBusy(nodeId),
        currentOperationByNode: () => store.currentOperationIds(),
        subscribeCurrentOperations: (listener) => woohaa3CanvasStore.subscribe(listener),
        beginLocalOperation: (input) => {
          if (input.canvasId !== canvasId) {
            return { operationId: "", finish: () => undefined };
          }
          return store.beginLocalOperation({ nodeId: input.nodeId, kind: input.kind, ...(input.progress !== undefined ? { progress: input.progress } : {}) });
        }
      };
      ctx.provide(RUN_STATE_SERVICE as never, service as never);

      return () => {
        disposeStarted();
        disposeUpdated();
        disposeFinished();
        disposeCanvas();
        agentPollDisposed = true;
        disposeAgentTurns?.();
        if (agentPollTimer !== undefined) clearTimeout(agentPollTimer);
        store.dispose();
      };
    },
    {
      name: RUN_STATE_PLUGIN_ID,
      inject: []
    }
  );
}
