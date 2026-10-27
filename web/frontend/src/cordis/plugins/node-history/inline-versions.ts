import type { Context } from "@deepseek-ai/cordis";
import { visibleNodeHistoryVersions, type NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import type { CanvasHistoryClient } from "./canvas-history-controller.js";
import { ExecutionPreview } from "./execution-preview.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { INLINE_HISTORY_SERVICE, RUN_STATE_SERVICE, type RunStateService } from "../service-keys.js";

export type InlineVersionRequest = { nodeId: string; entryId?: string; presentationId?: string; operationId?: string; viewOnly?: boolean; index?: number; step?: number };
/** Bounded metadata and page-local preview selection; persistent apply belongs to the drawer. */
export class InlineVersions {
  readonly preview: ExecutionPreview;
  private versions = new Map<string, readonly NodeGenerationHistoryListItem[]>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private loading = false;
  private refreshAgain = false;
  private revision = 0;
  private nodeRevisions = new Map<string, number>();
  constructor(private client: NodeHistoryClient & Partial<CanvasHistoryClient>, private canvasId: string,
    private report: (error: unknown) => void) {
      this.preview = new ExecutionPreview(() => this.versions, () => { for (const listener of this.listeners) listener(); }, client, canvasId, report);
    }
  snapshot = () => this.versions;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async refreshNode(nodeId: string) {
    if (this.disposed) return;
    const revision = ++this.revision;
    this.nodeRevisions.set(nodeId, revision);
    try {
      const result = this.client.listCanvas
        ? await this.client.listCanvas({ canvasId: this.canvasId, summary: true, summaryNodeId: nodeId })
        : await this.client.list({ canvasId: this.canvasId, nodeId, limit: 24 });
      if (this.disposed || this.nodeRevisions.get(nodeId) !== revision) return;
      if (!result.ok) throw new Error(result.error);
      const next = new Map(this.versions).set(nodeId, [...result.items].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId)));
      this.preview.retain(next);
      this.versions = next;
      this.preview.refresh();
      for (const listener of this.listeners) listener();
    } catch (error) { if (!this.disposed) this.report(error); }
  }
  async refresh() {
    if (this.disposed || !this.client.listCanvas) return;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    const revision = ++this.revision;
    try {
      const next = new Map<string, readonly NodeGenerationHistoryListItem[]>();
      const result = await this.client.listCanvas({ canvasId: this.canvasId, summary: true });
      if (this.disposed) return;
      if (!result.ok) throw new Error(result.error);
      for (const item of result.items) {
        const list = next.get(item.nodeId) ?? []; next.set(item.nodeId, [...list, item]);
      }
      for (const [nodeId, items] of next) next.set(nodeId, [...items].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId)));
      // A targeted compensation may have completed while this canvas read was in flight.
      for (const [nodeId, nodeRevision] of this.nodeRevisions) {
        if (nodeRevision > revision && this.versions.has(nodeId)) next.set(nodeId, [...this.versions.get(nodeId)!]);
      }
      this.preview.retain(next);
      this.versions = next;
      this.preview.refresh();
      for (const listener of this.listeners) listener();
    } catch (error) { if (!this.disposed) this.report(error); }
    finally {
      this.loading = false;
      if (this.refreshAgain && !this.disposed) { this.refreshAgain = false; void this.refresh(); }
    }
  }
  select(request: InlineVersionRequest) {
    if (this.disposed) return;
    const identity = request.presentationId ?? (request.operationId ? `operation:${request.operationId}` : undefined);
    if (identity) { this.preview.select(request.nodeId, identity); return; }
    const all = this.versions.get(request.nodeId) ?? [];
    const visible = visibleNodeHistoryVersions(all);
    const cursor = this.preview.selected.get(request.nodeId);
    const current = Math.max(0, all.findIndex(item => cursor ? (item.source.runId ? `operation:${item.source.runId}` : `entry:${item.entryId}`) === cursor : item.current));
    const item = request.entryId ? all.find(item => item.entryId === request.entryId) : request.index !== undefined ? visible[request.index] : all[Math.max(0, Math.min(all.length - 1, current + (request.step ?? 0)))];
    if (item) this.preview.select(request.nodeId, item.source.runId ? `operation:${item.source.runId}` : `entry:${item.entryId}`);
  }
  dispose() { this.disposed = true; this.preview.dispose(); this.listeners.clear(); }
}

export function installInlineVersions(ctx: Context, canvasId: string, client: NodeHistoryClient & Partial<CanvasHistoryClient>) {
  const service = new InlineVersions(client, canvasId, error => console.error("[node-history] version preview", error));
  ctx.provide(INLINE_HISTORY_SERVICE as never, service as never);
  let previous: unknown[] = [], timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const identity = canvas?.id === canvasId ? canvas.document.nodes.flatMap(node => {
      const data = canvas.nodeData[node.id] as Record<string, unknown> | undefined;
      return [node.id, data?.outputAssetId, data?.activeRunId, data?.modelScript];
    }) : [];
    if (identity.length === previous.length && identity.every((value,index) => value === previous[index])) return;
    previous = identity;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void service.refresh(); }, 150);
  };
  const unsubscribe = woohaa3CanvasStore.subscribe(sync);
  let syncPhase: string | undefined;
  const offSession = ctx.canvasSession.subscribe?.(status => {
    const phase = status.remote.phase;
    if (phase === "synced" && syncPhase !== phase) void service.refresh();
    syncPhase = phase;
  });
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const observed = new Map<string, string>();
  // 运行态由 **run-state 插件**提供（兄弟插件），apply 窗口内还没 active：装配期 `ctx.get` 只会拿到
  // undefined，订阅与首次 observe 都不会发生（版本预览因此看不到运行态进度）。声明式等待：
  // 服务就绪才订阅并补一次 observe，服务撤销随 fiber 释放。
  ctx.inject([RUN_STATE_SERVICE], (scoped) => {
    const runState = scoped.get(RUN_STATE_SERVICE as never) as unknown as RunStateService;
    const offRuns = runState.subscribe(() => {
      service.preview.observe(runState.snapshot().records);
      for (const record of runState.snapshot().records) {
        const previous = observed.get(record.operationId);
        observed.set(record.operationId, record.state);
        if (previous === record.state || record.state === "running" || record.state === "queued" || record.localFailure) continue;
        // Bounded compensation for an activity event arriving before history registration.
        for (const delay of [0, 400, 1500]) {
          const retry = setTimeout(() => {
            retries.delete(retry);
            if (!service.snapshot().get(record.nodeId)?.some(item => item.source.runId === record.operationId)) void service.refreshNode(record.nodeId);
          }, delay);
          retries.add(retry);
        }
      }
    });
    service.preview.observe(runState.snapshot().records);
    scoped.effect(() => () => offRuns(), "node-history:inline-run-state");
  });
  const off = ctx.on("ui.node-history.switch-requested", request => {
    service.select(request);
  });
  sync();
  return () => { if (timer) clearTimeout(timer); for (const retry of retries) clearTimeout(retry); offSession?.(); unsubscribe(); off(); service.dispose(); };
}
