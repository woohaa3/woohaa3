import type { CanvasCreationView, ConversationTurn } from "@woohaa3/contracts";
import type { CanvasGroupRun, CanvasGroupRunsService, CanvasGroupRunsSnapshot } from "../contract/canvas-group-runs.js";
import type { ApplicationRemoteTransport } from "../contract/remote.js";
import type { AgentConversationService } from "../contract/agent-conversation.js";
import type { CurrentUserService } from "./current-user.js";

const PATH = "/api/agent-conversations/canvas-creations";
const labels: Record<string, string> = {
  preparing: "正在准备", "root-created": "等待开始", accepted: "已接受", queued: "等待助手", running: "创作中",
  committing: "正在保存", succeeded: "已完成", partial: "部分完成", failed: "创作失败", cancelled: "已停止"
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
        const creationResult = await options.transport.request({ path: `${PATH}?canvasId=${encodeURIComponent(options.canvasId)}` });
        if (!current()) return;
        if (!creationResult.ok) throw new Error(creationResult.error);
        const creations = ((creationResult.data as { creations?: CanvasCreationView[] }).creations ?? []).filter(c => c.canvasId === options.canvasId);
        const turns: ConversationTurn[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const result = await options.transport.request({ path: `/api/agent-conversations/group-executions?canvasId=${encodeURIComponent(options.canvasId)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` });
          if (!current()) return;
          if (!result.ok) throw new Error(result.error);
          const page = result.data as { turns: ConversationTurn[]; nextCursor?: string };
          turns.push(...page.turns);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("组执行分页游标重复，请刷新重试");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        const seen = new Set<string>();
        const rows: CanvasGroupRun[] = [];
        const add = (turn: ConversationTurn | undefined, creation?: CanvasCreationView) => {
          const requestId = turn?.requestId ?? creation!.turnRequestId;
          if (seen.has(requestId)) return;
          seen.add(requestId);
          const status = turn?.status ?? creation!.stage;
          rows.push({ rootGroupId: turn?.target.nodeId ?? creation!.rootGroupId,
            conversationId: turn?.conversationId ?? creation?.conversationId, creation, turn, requestId,
            status, label: labels[status] ?? status,
            active: ["preparing", "root-created", "accepted", "queued", "running", "committing"].includes(status),
            error: turn?.error?.message ?? creation?.error?.message,
            createdAt: turn?.createdAt ?? snapshot.rows.find(row => row.requestId === requestId)?.createdAt ?? new Date().toISOString() });
        };
        for (const turn of turns) if (turn.target.mode === "canvas-group" && turn.target.canvasId === options.canvasId && turn.action !== "discuss")
          add(turn, creations.find(c => c.turnRequestId === turn.requestId));
        for (const creation of creations) if (!seen.has(creation.turnRequestId)) add(undefined, creation);
        rows.sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt) || b.requestId.localeCompare(a.requestId));
        if (current()) publish({ rows, error: "" });
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
    if (!result.ok) throw new Error(result.error ?? "请求失败，请重试");
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
