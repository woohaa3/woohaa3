import type { CanvasCreationView } from "@woohaa3/contracts";
import type { CanvasGroupRun, CanvasGroupRunsService, CanvasGroupRunsSnapshot } from "../contract/canvas-group-runs.js";
import type { ApplicationRemoteTransport } from "../contract/remote.js";
import type { AgentConversationService } from "../contract/agent-conversation.js";
import type { CurrentUserService } from "./current-user.js";

const PATH = "/api/agent-conversations/canvas-creations";
const labels: Record<string, string> = {
  preparing: "正在准备", "root-created": "等待开始", accepted: "已接受", queued: "等待助手", running: "创作中",
  committing: "核对结果中", succeeded: "已完成", partial: "部分完成", failed: "创作失败", unknown: "结果待核对", cancelled: "已停止"
};

/** One page-owned poller for all group runs, independent of selection and panel visibility. */
export function createCanvasGroupRuns(options: {
  canvasId: string;
  transport: ApplicationRemoteTransport;
  conversations: Pick<AgentConversationService, "readConversation" | "cancelTurn">;
  user: Pick<CurrentUserService, "getSnapshot" | "subscribe">;
  writable(): boolean;
}): CanvasGroupRunsService & { dispose(): void } {
  let snapshot: CanvasGroupRunsSnapshot = { rows: [], error: "" };
  const listeners = new Set<() => void>();
  let generation = 0;
  let namespace: string | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  const publish = (next: CanvasGroupRunsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = (): Promise<void> => {
    if (disposed || !namespace) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    const epoch = generation;
    const current = () => !disposed && epoch === generation && options.user.getSnapshot()?.dataScopeId === namespace;
    pending = Promise.resolve().then(async () => {
      try {
        const result = await options.transport.request({ path: `${PATH}?canvasId=${encodeURIComponent(options.canvasId)}` });
        if (!current()) return;
        if (!result.ok) throw new Error(result.error);
        const creations = (result.data as { creations?: CanvasCreationView[] }).creations ?? [];
        const errors: string[] = [];
        const rows = await Promise.all(creations.filter(c => c.canvasId === options.canvasId).map(async creation => {
          const previous = snapshot.rows.find(row => row.creation.requestId === creation.requestId);
          let turn = previous?.turn;
          try {
            const detail = creation.conversationId ? await options.conversations.readConversation(creation.conversationId, 0) : null;
            if (detail && !detail.ok) throw new Error(detail.error);
            turn = detail?.ok ? [...detail.value.turns].reverse().find(t =>
            t.target.mode === "canvas-group" && t.target.canvasId === options.canvasId && t.target.nodeId === creation.rootGroupId && t.action !== "discuss"
            ) : undefined;
          } catch (error) {
            errors.push(error instanceof Error ? error.message : "对话状态读取失败");
          }
          const status = turn?.status ?? creation.stage;
          return {
            creation, turn, requestId: turn?.requestId ?? creation.turnRequestId,
            status, label: labels[status] ?? status,
            active: ["preparing", "root-created", "accepted", "queued", "running", "committing", "unknown"].includes(status),
            error: turn?.error?.message ?? creation.error?.message,
            createdAt: turn?.createdAt ?? previous?.createdAt ?? new Date().toISOString()
          } satisfies CanvasGroupRun;
        }));
        if (current()) publish({ rows, error: [...new Set(errors)].join("；") });
      } catch (error) {
        if (current()) publish({ ...snapshot, error: error instanceof Error ? error.message : "运行状态读取失败" });
      } finally {
        if (current()) {
          pending = null;
          timer = setTimeout(() => void refresh(), 2000);
        }
      }
    });
    return pending;
  };
  const syncIdentity = () => {
    const next = options.user.getSnapshot()?.dataScopeId;
    if (namespace === next) return;
    namespace = next; generation++; pending = null; clearTimeout(timer);
    publish({ rows: [], error: "" });
    void refresh();
  };
  const unsubscribeUser = options.user.subscribe(syncIdentity);
  syncIdentity();
  const act = async (run: () => Promise<{ ok: boolean; error?: string }>) => {
    if (disposed || !namespace || !options.writable()) throw new Error("画布当前不可写");
    const epoch = generation;
    const result = await run();
    if (disposed || epoch !== generation) return;
    if (!result.ok) throw new Error(result.error ?? "请求未确认，请核对运行状态");
    if (pending) await pending;
    if (disposed || epoch !== generation) return;
    await refresh();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    stop: requestId => act(() => options.conversations.cancelTurn(requestId)),
    retry: requestId => act(() => options.transport.request({ path: `${PATH}/${encodeURIComponent(requestId)}/retry`, method: "POST", body: {} })),
    dispose() { disposed = true; generation++; clearTimeout(timer); unsubscribeUser(); listeners.clear(); }
  };
}
