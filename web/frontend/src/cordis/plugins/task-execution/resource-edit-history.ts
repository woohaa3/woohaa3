import type { Context } from "@deepseek-ai/cordis";
import { createHighEntropyId } from "@woohaa3/contracts";
import type { AgentConversationServiceHandle } from "../../services/agent-conversation-service.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

/** Register authoritative assistant commands in the page's existing undo journal. */
export function watchResourceEditHistory(ctx: Context, canvasId: string, service: AgentConversationServiceHandle): () => void {
  const active = new Set<string>();
  const loaded = new Set<string>();
  const loading = new Set<string>();
  const recorded = new Set<string>();
  const abort = new AbortController();
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retry = () => { if (!disposed && retryTimer === undefined) retryTimer = setTimeout(() => { retryTimer = undefined; inspect(); }, 2000); };
  const waitRevision = (revision: number) => new Promise<boolean>(resolve => {
    let off = () => {};
    const finish = (value: boolean) => { clearTimeout(timer); off(); abort.signal.removeEventListener("abort", cancelled); resolve(value); };
    const cancelled = () => finish(false);
    const check = () => { const canvas = woohaa3CanvasStore.getState().canvas; if (canvas?.id === canvasId && canvas.revision >= revision) finish(true); };
    const timer = setTimeout(() => finish(false), 10_000);
    off = woohaa3CanvasStore.subscribe(check);
    abort.signal.addEventListener("abort", cancelled, { once: true });
    if (abort.signal.aborted) cancelled(); else check();
  });
  const load = async (requestId: string) => {
    if (loading.has(requestId) || loaded.has(requestId) || !ctx.canvasRemote.listResourceEdits) return;
    loading.add(requestId);
    try {
      const result = await ctx.canvasRemote.listResourceEdits({ canvasId, runId: requestId }, abort.signal);
      if (!result.ok || disposed) { if (!disposed) retry(); return; }
      for (const item of result.commands) {
        if (recorded.has(item.commandId)) continue;
        let previousCommandId = item.commandId;
        let pending: { direction: "undo" | "redo"; operationId: string } | undefined;
        let committed: { direction: "undo" | "redo"; revision: number } | undefined;
        const replay = async (direction: "undo" | "redo") => {
          if (disposed || !ctx.canvasSession.isWritable() || !ctx.canvasRemote.replayResourceEdit) return { ok: false as const, reason: "画布当前不可写" };
          if (committed?.direction === direction) {
            if (!await waitRevision(committed.revision)) return { ok: false as const, reason: "撤销已保存，画布同步尚未完成" };
            const revision = committed.revision;
            committed = undefined;
            return { ok: true as const, revision };
          }
          if (!pending || pending.direction !== direction) pending = { direction, operationId: createHighEntropyId("resource-history") };
          let outcome: Awaited<ReturnType<NonNullable<typeof ctx.canvasRemote.replayResourceEdit>>>;
          try {
            outcome = await ctx.canvasRemote.replayResourceEdit({ canvasId, sourceCommandId: item.commandId, previousCommandId, ...pending }, abort.signal);
          } catch {
            return { ok: false as const, reason: "无法连接画布，请重试" };
          }
          if (!outcome.ok) return { ok: false as const, reason: outcome.message };
          previousCommandId = outcome.commandId;
          pending = undefined;
          committed = { direction, revision: outcome.revision };
          if (!await waitRevision(outcome.revision)) return { ok: false as const, reason: "撤销已保存，画布同步尚未完成" };
          committed = undefined;
          return { ok: true as const, revision: outcome.revision };
        };
        const entry = ctx.canvasEdit.recordExternal({ id: `resource-edit:${item.commandId}`, label: "助手编辑导演区", revision: item.revision, undo: () => replay("undo"), redo: () => replay("redo") });
        if (!entry.ok) { retry(); return; }
        recorded.add(item.commandId);
      }
      loaded.add(requestId);
    } catch {
      if (!disposed) retry();
    } finally { loading.delete(requestId); }
  };
  const inspect = () => {
    for (const [requestId, item] of Object.entries(service.getSnapshot().turnsByRequest ?? {})) {
      if (item.turn.target.canvasId !== canvasId || item.turn.target.mode !== "world" || item.turn.target.worldScope?.kind !== "scene-area") continue;
      if (["queued", "running", "committing", "unknown"].includes(item.turn.status)) active.add(requestId);
      else if (active.has(requestId)) void load(requestId);
    }
  };
  const off = service.subscribe(inspect);
  inspect();
  return () => { disposed = true; if (retryTimer !== undefined) clearTimeout(retryTimer); abort.abort(); off(); };
}
