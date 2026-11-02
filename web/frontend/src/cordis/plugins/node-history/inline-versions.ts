import type { Context } from "@deepseek-ai/cordis";
import type { CanvasOperationRecord, NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import type { CanvasHistoryClient } from "./canvas-history-controller.js";
import { ExecutionPreview } from "./execution-preview.js";
import { NodeHistoryCatalog } from "./history-catalog.js";
import { HistorySeenStore, type SeenStorage } from "./seen-store.js";
import { VersionSelectionController, type VersionSelectionGuard } from "./version-selection.js";
import type { VersionRequest } from "./version-model.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { INLINE_HISTORY_SERVICE, RUN_STATE_SERVICE, type RunStateService } from "../service-keys.js";

export type InlineVersionRequest = VersionRequest;
export type InlineVersionGuard = VersionSelectionGuard;
export type InlineVersionOptions = {
  canActivate?: (nodeId: string, item: NodeGenerationHistoryListItem) => InlineVersionGuard;
  onApplyError?: (input: { nodeId: string; error: string }) => void;
  /** 测试/嵌入式可注入的 seen 存储；缺省 localStorage。 */
  storage?: SeenStorage | null;
};

/**
 * 页面级版本切换与未读提示。
 *
 * 只做编排：历史摘要目录（加载/刷新）、已读基线、选择/apply 状态机、预览投影各自有独立
 * 模块。圆点点击进入同一个 activate 入口，由选择控制器决定“只预览”还是“预览并应用”。
 */
export class InlineVersions {
  readonly preview: ExecutionPreview;
  private readonly catalog: NodeHistoryCatalog;
  private readonly seen: HistorySeenStore;
  private readonly selection: VersionSelectionController;
  private readonly listeners = new Set<() => void>();
  private readonly selected = new Map<string, string>();
  private unseen = new Map<string, ReadonlySet<string>>();
  private settledSeen = new Map<string, Set<string>>();
  private disposed = false;

  constructor(private client: NodeHistoryClient & Partial<CanvasHistoryClient>, private canvasId: string,
    report: (error: unknown) => void,
    private onApplyError?: (input: { nodeId: string; error: string }) => void,
    private canActivate?: (nodeId: string, item: NodeGenerationHistoryListItem) => InlineVersionGuard,
    storage: SeenStorage | null = defaultSeenStorage()) {
    this.seen = new HistorySeenStore(canvasId, { storage }, () => this.handleSeenChanged());
    this.catalog = new NodeHistoryCatalog(client, canvasId, report, versions => this.handleCatalogChanged(versions));
    this.preview = new ExecutionPreview(() => this.catalog.snapshot(), () => this.emit(), client, canvasId, report,
      () => this.selected);
    this.selection = new VersionSelectionController({
      selected: this.selected,
      items: nodeId => this.catalog.items(nodeId),
      preview: this.preview,
      apply: (nodeId, entryId) => this.client.apply({ canvasId: this.canvasId, nodeId, entryId }),
      refreshNode: nodeId => this.refreshNode(nodeId),
      markSeenEntry: (nodeId, item) => this.seen.markEntry(nodeId, item),
      markSettledSeen: (nodeId, operationId) => this.trackSettledSeen(nodeId, operationId),
      canActivate: this.canActivate,
      onApplyError: this.onApplyError,
      onChange: () => this.emit()
    });
  }

  private emit() { for (const listener of this.listeners) listener(); }

  private handleSeenChanged() {
    this.recomputeUnseen();
    this.emit();
  }

  private handleCatalogChanged(versions: Map<string, readonly NodeGenerationHistoryListItem[]>) {
    this.preview.retain(versions);
    this.applySettledSeen();
    this.recomputeUnseen();
    this.preview.refresh();
    this.emit();
  }

  private recomputeUnseen() {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [nodeId, items] of this.catalog.snapshot()) {
      this.seen.baselineNode(nodeId, items);
      const unseen = this.seen.unseenFor(nodeId, items);
      if (unseen.size) next.set(nodeId, unseen);
    }
    this.unseen = next;
  }

  private trackSettledSeen(nodeId: string, operationId: string) {
    const ops = this.settledSeen.get(nodeId) ?? new Set<string>();
    ops.add(operationId);
    this.settledSeen.set(nodeId, ops);
  }

  /** 已结算的操作等到历史条目到达后再标记已读。 */
  private applySettledSeen() {
    for (const [nodeId, ops] of [...this.settledSeen]) {
      const items = this.catalog.items(nodeId) ?? [];
      for (const operationId of [...ops]) {
        const item = items.find(entry => entry.source.runId === operationId);
        if (!item) continue;
        ops.delete(operationId);
        this.seen.markEntry(nodeId, item);
      }
      if (!ops.size) this.settledSeen.delete(nodeId);
    }
  }

  markSeenNode(nodeId: string) {
    this.seen.markNode(nodeId, this.catalog.items(nodeId) ?? []);
  }

  baselineNodes(nodeIds: readonly string[]) {
    this.seen.baselineNodes(nodeIds);
  }

  unseenSnapshot = (): ReadonlyMap<string, ReadonlySet<string>> => this.unseen;
  selectedByNode = (): ReadonlyMap<string, string> => this.selected;
  snapshot = () => this.catalog.snapshot();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  select(request: InlineVersionRequest) {
    if (!this.disposed) this.selection.select(request);
  }

  activate(request: InlineVersionRequest) {
    if (!this.disposed) this.selection.activate(request);
  }

  observeRunState(records: readonly CanvasOperationRecord[]) {
    if (!this.disposed) this.selection.observeRunState(records);
  }

  async refreshNode(nodeId: string) {
    if (!this.disposed) await this.catalog.refreshNode(nodeId);
  }

  async refresh() {
    if (!this.disposed) await this.catalog.refresh();
  }

  dispose() {
    this.disposed = true;
    this.catalog.dispose();
    this.selection.dispose();
    this.preview.dispose();
    this.listeners.clear();
    this.selected.clear();
    this.unseen.clear();
    this.settledSeen.clear();
  }
}

function defaultSeenStorage(): SeenStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
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
  const off = ctx.on("ui.node-history.switch-requested", request => service.activate(request));
  sync();
  return () => { if (timer) clearTimeout(timer); for (const retry of historyRetries.values()) clearTimeout(retry); historyRetries.clear(); offSession?.(); unsubscribe(); off(); service.dispose(); };
}
