import type { CanvasGroupAction, AgentAdapterRunOutcome } from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { ToolGrantRegistry } from "./authoring-adapters.js";

type Input = { owner?: string; requestId: string; actions: CanvasGroupAction[]; outcome: AgentAdapterRunOutcome; signal: AbortSignal; recovery?: boolean };
const activeStates = new Set(["queued", "pending", "running", "processing"]);
const successStates = new Set(["succeeded", "successed", "success"]);

/** Resolve only explicitly linked runs. No node-latest lookup can cancel a newer run. */
export function createGroupEffects(canvas: CanvasService, grants: ToolGrantRegistry, options: { now?: () => number; wait?: () => Promise<void>; maxWaitMs?: number } = {}) {
  const cancel = (input: { owner?: string; requestId: string; actions: CanvasGroupAction[] }) => {
    grants.revoke(input.requestId, input.owner);
    for (const action of input.actions) if (action.runId && action.nodeId) {
      void canvas.runService?.cancel({ canvasId: action.canvasId, nodeId: action.nodeId, runId: action.runId }).catch(() => undefined);
    }
  };
  return {
    cancel,
    async settle(input: Input): Promise<AgentAdapterRunOutcome> {
      const now = options.now ?? Date.now;
      const started = now();
      const runs = input.actions.filter(a => a.runId && a.nodeId);
      if (!input.actions.length) {
        if (input.signal.aborted || input.outcome.status === "cancelled") return { ...input.outcome, status: "cancelled" };
        return { ...input.outcome, status: input.outcome.status === "failed" ? "failed" : "unknown", error: input.outcome.error ?? { code: "write-unconfirmed", message: "没有可核对的结构或运行回执" } };
      }
      while (true) {
        const outcomes: { runId: string; nodeId: string; state: string; outputAssetIds: string[] }[] = [];
        let active = false;
        let failed = false;
        let uncertain = false;
        for (const action of runs) {
          const room = await canvas.sync?.registry.resolve(action.canvasId);
          const snapshot = room?.exportCanvas();
          if (!snapshot?.ok) { uncertain = true; continue; }
          const job = snapshot.canvas.jobs.find(j => j.runId === action.runId && j.nodeId === action.nodeId);
          const data = snapshot.canvas.nodeData[action.nodeId!];
          const state = String(job?.status ?? (data?.activeRunId === action.runId ? data.taskStatus : "unknown"));
          // Stable asset provenance also proves older runs after a newer run replaces activeRunId.
          const outputs = snapshot.canvas.assets.filter(a => a.provenance?.runId === action.runId && (a.nodeId === action.nodeId || a.provenance?.taskNodeId === action.nodeId));
          const currentOutput = data?.activeRunId === action.runId && data.taskStatus === "successed" && data.result?.kind === "text" && typeof data.result.text === "string";
          const confirmedOutput = outputs.length > 0 || Boolean(currentOutput);
          outcomes.push({ runId: action.runId!, nodeId: action.nodeId!, state, outputAssetIds: outputs.map(a => a.id) });
          if (activeStates.has(state)) active = true;
          else if (state === "unknown") uncertain = true;
          else if (!successStates.has(state)) failed = true;
          else if (!confirmedOutput) uncertain = true;
        }
        const receipt = { kind: "canvas-group", actions: input.actions, outcomes };
        if (input.signal.aborted) { cancel(input); return { ...input.outcome, status: "cancelled", receipt }; }
        if (active && !input.recovery && now() - started < (options.maxWaitMs ?? 30 * 60_000)) {
          await (options.wait?.() ?? new Promise(resolve => setTimeout(resolve, 300)));
          continue;
        }
        // Recovery reads evidence once. It cannot prove an interrupted inference finished.
        const status = input.outcome.status === "cancelled" ? "cancelled"
          : active || uncertain || input.outcome.status === "unknown" ? "unknown"
          : failed || ["failed", "partial"].includes(input.outcome.status) ? "partial" : "succeeded";
        return { ...input.outcome, status, receipt };
      }
    }
  };
}
