import type { Context } from "@deepseek-ai/cordis";
import { visibleNodeHistoryVersions, type CanvasOperationRecord, type NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import type { CanvasHistoryClient } from "./canvas-history-controller.js";
import { ExecutionPreview } from "./execution-preview.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { INLINE_HISTORY_SERVICE, RUN_STATE_SERVICE, type RunStateService } from "../service-keys.js";

export type InlineVersionRequest = { nodeId: string; entryId?: string; presentationId?: string; operationId?: string; viewOnly?: boolean; index?: number; step?: number };

/** 直接切换版本的本地前置门禁（草稿/运行中）；失败原因由宿主展示。 */
export type InlineVersionGuard = { ok: true } | { ok: false; reason: string };
export type InlineVersionOptions = {
  canActivate?: (nodeId: string, item: NodeGenerationHistoryListItem) => InlineVersionGuard;
  onApplyError?: (input: { nodeId: string; error: string }) => void;
  /** 测试/嵌入式可注入的 seen 存储；缺省 localStorage。 */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

const SEEN_STORAGE_PREFIX = "woohaa:node-history-seen:v1:";
const SEEN_STORAGE_MAX_NODES = 200;

function defaultSeenStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 页面级版本切换与未读提示
 * （原：bounded metadata and page-local preview selection；persistent apply belongs to the drawer）。
 *
 * 圆点直接切换已完成的非当前版本时走受控历史 `apply`，不再要求先进入聚焦/历史面板；
 * 失败/运行中/当前版本仍只做只读预览。未读只看**已归档版本**：以每个节点上次查看的
 * `createdAt` 为基线，新完成的条目在圆点右上角显示提醒，点击或打开历史面板后清除。
 */
export class InlineVersions {
  readonly preview: ExecutionPreview;
  private versions = new Map<string, readonly NodeGenerationHistoryListItem[]>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private loading = false;
  private refreshAgain = false;
  private revision = 0;
  private nodeRevisions = new Map<string, number>();
  private seenAt = new Map<string, string>();
  private unseen = new Map<string, ReadonlySet<string>>();
  private baseline = new Set<string>();
  private applying = new Map<string, string>();
  private pendingApply = new Map<string, string>();
  private runRecords = new Map<string, CanvasOperationRecord>();
  private runningSelections = new Map<string, Set<string>>();
  private settledSeen = new Map<string, Set<string>>();
  private readonly openedAt = new Date().toISOString();
  private storage: Pick<Storage, "getItem" | "setItem"> | null;
  constructor(private client: NodeHistoryClient & Partial<CanvasHistoryClient>, private canvasId: string,
    private report: (error: unknown) => void,
    private onApplyError?: (input: { nodeId: string; error: string }) => void,
    private canActivate?: (nodeId: string, item: NodeGenerationHistoryListItem) => InlineVersionGuard,
    storage: Pick<Storage, "getItem" | "setItem"> | null = defaultSeenStorage()) {
      this.storage = storage;
      this.loadSeen();
      this.preview = new ExecutionPreview(() => this.versions, () => this.emit(), client, canvasId, report);
    }
  private emit() { for (const listener of this.listeners) listener(); }
  private loadSeen() {
    try {
      const raw = this.storage?.getItem(`${SEEN_STORAGE_PREFIX}${this.canvasId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [nodeId, at] of Object.entries(parsed)) if (typeof at === "string" && at) this.seenAt.set(nodeId, at);
    } catch { /* 损坏的本地提示状态不应阻塞历史读取。 */ }
  }
  private persistSeen() {
    try {
      const newest = [...this.seenAt.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, SEEN_STORAGE_MAX_NODES);
      this.storage?.setItem(`${SEEN_STORAGE_PREFIX}${this.canvasId}`, JSON.stringify(Object.fromEntries(newest)));
    } catch { /* 存储不可用只丢提示，不影响版本切换。 */ }
  }
  /** 首次见到某节点时建立已读基线：有历史取最新条目，没有则取本页打开时刻，避免存量历史全标未读。 */
  private ensureBaseline(nodeId: string, items: readonly NodeGenerationHistoryListItem[]) {
    if (this.baseline.has(nodeId)) return;
    this.baseline.add(nodeId);
    if (this.seenAt.has(nodeId)) return;
    const newest = items.length
      ? items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, "")
      : this.openedAt;
    if (!newest) return;
    this.seenAt.set(nodeId, newest);
    this.persistSeen();
  }
  private trackRunningSelection(nodeId: string, operationId: string) {
    const ops = this.runningSelections.get(nodeId) ?? new Set<string>();
    ops.add(operationId);
    this.runningSelections.set(nodeId, ops);
  }
  private trackIfRunning(nodeId: string, presentationId: string) {
    if (!presentationId.startsWith("operation:")) return;
    const operationId = presentationId.slice("operation:".length);
    const record = this.runRecords.get(operationId);
    if (record?.nodeId === nodeId && (record.state === "running" || record.state === "queued")) {
      this.trackRunningSelection(nodeId, operationId);
    }
  }
  private trackSettledSeen(nodeId: string, operationId: string) {
    const ops = this.settledSeen.get(nodeId) ?? new Set<string>();
    ops.add(operationId);
    this.settledSeen.set(nodeId, ops);
  }
  /** 已结算的操作等到历史条目到达后再标记已读；返回是否更新了 seenAt。 */
  private applySettledSeen(): void {
    let changed = false;
    for (const [nodeId, ops] of [...this.settledSeen]) {
      const items = this.versions.get(nodeId) ?? [];
      for (const operationId of [...ops]) {
        const item = items.find(entry => entry.source.runId === operationId);
        if (!item) continue;
        ops.delete(operationId);
        const previous = this.seenAt.get(nodeId);
        if (!previous || item.createdAt > previous) {
          this.seenAt.set(nodeId, item.createdAt);
          changed = true;
        }
      }
      if (!ops.size) this.settledSeen.delete(nodeId);
    }
    if (changed) this.persistSeen();
  }
  private recomputeUnseen() {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [nodeId, items] of this.versions) {
      this.ensureBaseline(nodeId, items);
      const seen = this.seenAt.get(nodeId);
      if (!seen) continue;
      const unseen = new Set<string>();
      for (const item of items) {
        // 只有成功（绿点）才需要未读提醒；失败/取消/中断等红点不标。
        if (!item.entryId || item.createdAt <= seen) continue;
        if ((item.outcome ?? "succeeded") !== "succeeded") continue;
        unseen.add(item.entryId);
      }
      if (unseen.size) next.set(nodeId, unseen);
    }
    this.unseen = next;
  }
  private markSeenAt(nodeId: string, at: string) {
    const previous = this.seenAt.get(nodeId);
    if (previous && previous >= at) return;
    this.seenAt.set(nodeId, at);
    this.persistSeen();
    this.recomputeUnseen();
    this.emit();
  }
  private markSeenEntry(nodeId: string, entryId: string) {
    const item = this.versions.get(nodeId)?.find(entry => entry.entryId === entryId);
    if (item) this.markSeenAt(nodeId, item.createdAt);
  }
  /** 打开节点历史面板/查看完整列表时，把该节点当前已知版本全部视为已读。 */
  markSeenNode(nodeId: string) {
    const items = this.versions.get(nodeId) ?? [];
    const newest = items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, "");
    if (newest) this.markSeenAt(nodeId, newest);
  }
  /**
   * 首次见到画布节点时建立已读基线。
   *
   * 有历史时取最新条目，没有历史时取本页打开时刻；后者让节点之后完成的第一个版本也能
   * 显示未读角标，而不是因为空历史被永久视为已读。
   */
  baselineNodes(nodeIds: readonly string[]) {
    let changed = false;
    for (const nodeId of nodeIds) {
      if (this.seenAt.has(nodeId)) continue;
      this.seenAt.set(nodeId, this.openedAt);
      changed = true;
    }
    if (!changed) return;
    this.persistSeen();
    this.recomputeUnseen();
    this.emit();
  }
  unseenSnapshot = (): ReadonlyMap<string, ReadonlySet<string>> => this.unseen;
  /**
   * 运行态观察：预览中的黄点结算后撤销本地预览。
   *
   * 任务成功时节点 canonical 已由投影器写入新 outputAssetId（若用户没有切走，activeRunId
   * 仍是该 run）；撤销预览让新结果直接显示。失败/取消同样撤销，保留此前当前版本。
   * 若用户在完成前切到绿点，apply 已改写 activeRunId，投影器会按 latest-run-wins 跳过，
   * 不会覆盖用户刚选的版本。
   */
  observeRunState(records: readonly CanvasOperationRecord[]) {
    this.runRecords = new Map(records.map(record => [record.operationId, record]));
    this.preview.observe(records);
    for (const [nodeId, presentationId] of this.preview.selected) {
      if (!presentationId.startsWith("operation:")) continue;
      const operationId = presentationId.slice("operation:".length);
      const record = this.runRecords.get(operationId);
      if (!record || record.nodeId !== nodeId) continue;
      if (record.state === "running" || record.state === "queued") {
        this.trackRunningSelection(nodeId, operationId);
      } else if (record.state === "failed" || record.state === "cancelled") {
        // 失败归档可能晚于运行态；先用运行态错误替换内容，避免仍显示当前成功图。
        this.preview.setOperationFailure(nodeId, operationId, record.state,
          record.error?.trim() || (record.state === "cancelled" ? "任务已取消" : "任务失败"));
      } else {
        this.preview.clearOperationFailure(nodeId, operationId);
      }
    }
    for (const [nodeId, ops] of [...this.runningSelections]) {
      for (const operationId of [...ops]) {
        const record = this.runRecords.get(operationId);
        if (!record || record.state === "running" || record.state === "queued") continue;
        ops.delete(operationId);
        if (!ops.size) this.runningSelections.delete(nodeId);
        if (this.preview.selected.get(nodeId) === `operation:${operationId}`) {
          this.trackSettledSeen(nodeId, operationId);
        }
      }
    }
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
      this.applySettledSeen();
      this.recomputeUnseen();
      this.preview.refresh();
      this.emit();
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
      this.applySettledSeen();
      this.recomputeUnseen();
      this.preview.refresh();
      this.emit();
    } catch (error) { if (!this.disposed) this.report(error); }
    finally {
      this.loading = false;
      if (this.refreshAgain && !this.disposed) { this.refreshAgain = false; void this.refresh(); }
    }
  }
  private presentationOf(item: NodeGenerationHistoryListItem): string {
    return item.source.runId ? `operation:${item.source.runId}` : `entry:${item.entryId}`;
  }
  private itemByPresentation(nodeId: string, identity: string): NodeGenerationHistoryListItem | undefined {
    return this.versions.get(nodeId)?.find(item => this.presentationOf(item) === identity);
  }
  private resolveItem(request: InlineVersionRequest): NodeGenerationHistoryListItem | undefined {
    const all = this.versions.get(request.nodeId) ?? [];
    if (request.entryId) return all.find(item => item.entryId === request.entryId);
    const visible = visibleNodeHistoryVersions(all);
    const cursor = this.preview.selected.get(request.nodeId);
    const current = Math.max(0, all.findIndex(item => cursor ? this.presentationOf(item) === cursor : item.current));
    return request.index !== undefined
      ? visible[request.index]
      : all[Math.max(0, Math.min(all.length - 1, current + (request.step ?? 0)))];
  }
  select(request: InlineVersionRequest) {
    if (this.disposed) return;
    const identity = request.presentationId ?? (request.operationId ? `operation:${request.operationId}` : undefined);
    if (identity) {
      const item = this.itemByPresentation(request.nodeId, identity);
      if (item?.entryId) this.markSeenEntry(request.nodeId, item.entryId);
      // 当前版本本来就是可见内容，不再用本地预览覆盖 canonical。
      if (item?.current) { this.preview.select(request.nodeId, identity); return; }
      this.preview.select(request.nodeId, identity);
      this.trackIfRunning(request.nodeId, identity);
      return;
    }
    const item = this.resolveItem(request);
    if (!item) return;
    if (item.entryId) this.markSeenEntry(request.nodeId, item.entryId);
    if (item.current) { this.preview.select(request.nodeId, this.presentationOf(item)); return; }
    this.preview.select(request.nodeId, this.presentationOf(item));
    this.trackIfRunning(request.nodeId, this.presentationOf(item));
  }
  /**
   * 圆点直接切换：已完成的非当前版本调用受控历史 apply；其余保持只读预览。
   *
   * 不进入聚焦、不打开历史面板，也不先把选择写进预览，避免失败时卡片停在旧版本。
   */
  activate(request: InlineVersionRequest) {
    if (this.disposed) return;
    const item = this.resolveItem(request);
    if (!item?.entryId) { this.select(request); return; }
    // 任何状态点击都先显示该版本内容：绿点显示目标图，红点显示失败原因，黄点保持运行态。
    if (item.current) {
      this.preview.select(request.nodeId, this.presentationOf(item));
      this.markSeenEntry(request.nodeId, item.entryId);
      return;
    }
    if ((item.outcome ?? "succeeded") !== "succeeded" || item.recoverable === false) {
      this.select(request);
      return;
    }
    const guard = this.canActivate?.(request.nodeId, item);
    if (guard && !guard.ok) {
      // 仍先显示用户点中的版本内容；只拒绝把它写成当前版本。
      this.select(request);
      this.onApplyError?.({ nodeId: request.nodeId, error: guard.reason });
      return;
    }
    const target = this.presentationOf(item);
    this.preview.select(request.nodeId, target);
    this.markSeenEntry(request.nodeId, item.entryId);
    if (this.applying.has(request.nodeId)) {
      // 已有 apply 在途时也立即显示新目标，完成后接着应用最新一次点击。
      this.pendingApply.set(request.nodeId, item.entryId);
      return;
    }
    void this.runApply(request.nodeId, item);
  }
  private async runApply(nodeId: string, item: NodeGenerationHistoryListItem) {
    if (this.disposed || !item.entryId) return;
    this.applying.set(nodeId, item.entryId);
    this.emit();
    try {
      const result = await this.client.apply({ canvasId: this.canvasId, nodeId, entryId: item.entryId });
      if (this.disposed) return;
      if (!result.ok) {
        this.onApplyError?.({ nodeId, error: result.error });
        return;
      }
      this.markSeenEntry(nodeId, item.entryId);
      await this.refreshNode(nodeId);
    } catch (error) {
      if (!this.disposed) this.onApplyError?.({ nodeId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.applying.delete(nodeId);
      const pending = this.pendingApply.get(nodeId);
      this.pendingApply.delete(nodeId);
      if (!this.disposed && pending && pending !== item.entryId) {
        const next = this.versions.get(nodeId)?.find(entry => entry.entryId === pending);
        if (next) void this.runApply(nodeId, next);
      }
      if (!this.disposed) this.emit();
    }
  }
  dispose() { this.disposed = true; this.preview.dispose(); this.listeners.clear(); this.applying.clear(); this.pendingApply.clear(); this.seenAt.clear(); this.unseen.clear(); this.baseline.clear(); this.runRecords.clear(); this.runningSelections.clear(); this.settledSeen.clear(); }
}

export function installInlineVersions(ctx: Context, canvasId: string, client: NodeHistoryClient & Partial<CanvasHistoryClient>, options: InlineVersionOptions = {}) {
  const openApplyError = options.onApplyError ?? ((input: { nodeId: string; error: string }) => {
    const dialogs = (ctx as unknown as { dialogs?: { open?: (input: unknown) => void } }).dialogs;
    if (dialogs?.open) dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法切换版本", description: input.error } });
    else console.error("[node-history] version apply", input.error);
  });
  const service = new InlineVersions(client, canvasId, error => console.error("[node-history] version preview", error),
    openApplyError, options.canActivate, options.storage);
  ctx.provide(INLINE_HISTORY_SERVICE as never, service as never);
  let previous: unknown[] = [], timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (canvas?.id === canvasId) service.baselineNodes(canvas.document.nodes.map(node => node.id));
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
  const historyRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const observed = new Map<string, string>();
  /**
   * 终态归档可能晚于运行态；失败尤其不会改变 outputAssetId，不能依赖画布 identity 触发刷新。
   * 对每个终态 operation 做有界退避补查，直到摘要里出现同 runId 的归档条目。
   */
  const ensureHistoryEntry = (record: { nodeId: string; operationId: string }) => {
    const key = `${record.nodeId}:${record.operationId}`;
    const hasEntry = () => service.snapshot().get(record.nodeId)?.some(item => item.source.runId === record.operationId) === true;
    if (hasEntry() || historyRetries.has(key)) return;
    let attempt = 0;
    const schedule = () => {
      const delay = attempt === 0 ? 0 : Math.min(400 * 2 ** (attempt - 1), 15_000);
      const timer = setTimeout(() => {
        if (hasEntry()) { historyRetries.delete(key); return; }
        void service.refreshNode(record.nodeId).then(() => {
          if (hasEntry()) { historyRetries.delete(key); return; }
          if (attempt >= 7) { historyRetries.delete(key); return; }
          attempt += 1;
          schedule();
        });
      }, delay);
      historyRetries.set(key, timer);
    };
    schedule();
  };
  // 运行态由 **run-state 插件**提供（兄弟插件），apply 窗口内还没 active：装配期 `ctx.get` 只会拿到
  // undefined，订阅与首次 observe 都不会发生（版本预览因此看不到运行态进度）。声明式等待：
  // 服务就绪才订阅并补一次 observe，服务撤销随 fiber 释放。
  ctx.inject([RUN_STATE_SERVICE], (scoped) => {
    const runState = scoped.get(RUN_STATE_SERVICE as never) as unknown as RunStateService;
    const offRuns = runState.subscribe(() => {
      service.observeRunState(runState.snapshot().records);
      for (const record of runState.snapshot().records) {
        const previous = observed.get(record.operationId);
        observed.set(record.operationId, record.state);
        if (previous === record.state || record.state === "running" || record.state === "queued" || record.localFailure) continue;
        ensureHistoryEntry(record);
      }
    });
    service.observeRunState(runState.snapshot().records);
    scoped.effect(() => () => offRuns(), "node-history:inline-run-state");
  });
  const off = ctx.on("ui.node-history.switch-requested", request => {
    if (request.viewOnly === false) service.activate(request);
    else service.select(request);
  });
  sync();
  return () => { if (timer) clearTimeout(timer); for (const retry of historyRetries.values()) clearTimeout(retry); historyRetries.clear(); offSession?.(); unsubscribe(); off(); service.dispose(); };
}
