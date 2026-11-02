/**
 * 版本选择与切换控制器。
 *
 * 拥有“用户在圆点上想看/应用哪个版本”的意图，以及 apply 队列；预览投影与历史目录由
 * 外部注入。选择一旦由用户显式建立（pinned），运行中的黄点不再抢走。
 */
import type { CanvasOperationRecord, NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { ExecutionPreview } from "./execution-preview.js";
import {
  itemByPresentation,
  presentationOfItem,
  resolveVersionItem,
  type VersionRequest
} from "./version-model.js";

export type VersionApplyResult = { ok: true } | { ok: false; error: string };
export type VersionSelectionGuard = { ok: true } | { ok: false; reason: string };

export type VersionSelectionDeps = {
  /** 与预览投影共享的节点 → 版本引用表；控制器是唯一写入方。 */
  selected: Map<string, string>;
  items: (nodeId: string) => readonly NodeGenerationHistoryListItem[] | undefined;
  preview: ExecutionPreview;
  apply: (nodeId: string, entryId: string) => Promise<VersionApplyResult>;
  refreshNode: (nodeId: string) => Promise<void>;
  markSeenEntry: (nodeId: string, item: NodeGenerationHistoryListItem | undefined) => void;
  markSettledSeen: (nodeId: string, operationId: string) => void;
  canActivate?: (nodeId: string, item: NodeGenerationHistoryListItem) => VersionSelectionGuard;
  onApplyError?: (input: { nodeId: string; error: string }) => void;
  onChange: () => void;
};

const isTerminal = (record: CanvasOperationRecord) => record.state !== "running" && record.state !== "queued";

export class VersionSelectionController {
  private readonly pinned = new Set<string>();
  private readonly applying = new Map<string, string>();
  private readonly pendingApply = new Map<string, string>();
  private readonly runRecords = new Map<string, CanvasOperationRecord>();
  private readonly runningSelections = new Map<string, Set<string>>();
  private readonly observed = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: VersionSelectionDeps) {}

  selected = (): ReadonlyMap<string, string> => this.deps.selected;

  private setSelection(nodeId: string, presentationId: string) {
    if (this.deps.selected.get(nodeId) === presentationId) return;
    this.deps.selected.set(nodeId, presentationId);
    this.deps.preview.invalidateSelection(nodeId);
  }

  private items(nodeId: string) { return this.deps.items(nodeId) ?? []; }

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

  /**
   * 带稳定 identity 的请求只按 identity 精确匹配；匹配不到表示运行中/尚未归档，
   * 不能再回落到相邻历史条目，否则点黄点会误应用旁边的绿点。
   */
  private resolve(request: VersionRequest) {
    const items = this.items(request.nodeId);
    const identity = request.presentationId ?? (request.operationId ? `operation:${request.operationId}` : undefined);
    return {
      identity,
      item: identity
        ? itemByPresentation(items, identity)
        : resolveVersionItem(items, request, this.deps.selected.get(request.nodeId))
    };
  }

  /** 只读预览：当前版本也保留选择，避免运行态默认回落黄点。 */
  select(request: VersionRequest) {
    if (this.disposed) return;
    const { identity, item } = this.resolve(request);
    if (item) {
      this.deps.markSeenEntry(request.nodeId, item);
      const presentation = presentationOfItem(item);
      this.pinned.add(request.nodeId);
      this.setSelection(request.nodeId, presentation);
      this.trackIfRunning(request.nodeId, presentation);
      return;
    }
    if (identity) {
      this.pinned.add(request.nodeId);
      this.setSelection(request.nodeId, identity);
      this.trackIfRunning(request.nodeId, identity);
    }
  }

  /** 任意圆点先显示内容；绿点额外应用为当前，红/黄只预览。 */
  activate(request: VersionRequest) {
    if (this.disposed) return;
    const { item } = this.resolve(request);
    if (!item?.entryId) { this.select(request); return; }
    if (item.current) {
      this.pinned.add(request.nodeId);
      this.setSelection(request.nodeId, presentationOfItem(item));
      this.deps.markSeenEntry(request.nodeId, item);
      return;
    }
    if ((item.outcome ?? "succeeded") !== "succeeded" || item.recoverable === false) {
      this.select(request);
      return;
    }
    const guard = this.deps.canActivate?.(request.nodeId, item);
    if (guard && !guard.ok) {
      this.select(request);
      this.deps.onApplyError?.({ nodeId: request.nodeId, error: guard.reason });
      return;
    }
    this.pinned.add(request.nodeId);
    this.setSelection(request.nodeId, presentationOfItem(item));
    this.deps.markSeenEntry(request.nodeId, item);
    if (this.applying.has(request.nodeId)) {
      this.pendingApply.set(request.nodeId, item.entryId);
      return;
    }
    void this.runApply(request.nodeId, item);
  }

  private async runApply(nodeId: string, item: NodeGenerationHistoryListItem) {
    if (this.disposed || !item.entryId) return;
    this.applying.set(nodeId, item.entryId);
    this.deps.onChange();
    try {
      const result = await this.deps.apply(nodeId, item.entryId);
      if (this.disposed) return;
      if (!result.ok) {
        this.deps.onApplyError?.({ nodeId, error: result.error });
        return;
      }
      this.deps.markSeenEntry(nodeId, item);
      await this.deps.refreshNode(nodeId);
    } catch (error) {
      if (!this.disposed) this.deps.onApplyError?.({ nodeId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.applying.delete(nodeId);
      const pending = this.pendingApply.get(nodeId);
      this.pendingApply.delete(nodeId);
      if (!this.disposed && pending && pending !== item.entryId) {
        const next = this.deps.items(nodeId)?.find(entry => entry.entryId === pending);
        if (next) void this.runApply(nodeId, next);
      }
      if (!this.disposed) this.deps.onChange();
    }
  }

  /** 运行态观察：自动跟随新任务；显式选择后不再抢；结算先落临时失败内容。 */
  observeRunState(records: readonly CanvasOperationRecord[]) {
    if (this.disposed) return;
    this.runRecords.clear();
    for (const record of records) this.runRecords.set(record.operationId, record);
    const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
    for (const record of ordered) {
      const fresh = !this.observed.has(record.operationId);
      this.observed.add(record.operationId);
      if (fresh && !this.pinned.has(record.nodeId) && (record.state === "queued" || record.state === "running")) {
        this.setSelection(record.nodeId, `operation:${record.operationId}`);
      }
    }
    for (const [nodeId, presentationId] of this.deps.selected) {
      if (!presentationId.startsWith("operation:")) continue;
      const operationId = presentationId.slice("operation:".length);
      const record = this.runRecords.get(operationId);
      if (!record || record.nodeId !== nodeId) continue;
      if (record.state === "running" || record.state === "queued") {
        this.trackRunningSelection(nodeId, operationId);
      } else if (record.state === "failed" || record.state === "cancelled") {
        this.deps.preview.setOperationFailure(nodeId, operationId, record.state,
          record.error?.trim() || (record.state === "cancelled" ? "任务已取消" : "任务失败"));
      } else {
        this.deps.preview.clearOperationFailure(nodeId, operationId);
      }
    }
    for (const [nodeId, ops] of [...this.runningSelections]) {
      for (const operationId of [...ops]) {
        const record = this.runRecords.get(operationId);
        if (!record || !isTerminal(record)) continue;
        ops.delete(operationId);
        if (!ops.size) this.runningSelections.delete(nodeId);
        if (this.deps.selected.get(nodeId) === `operation:${operationId}`) {
          this.deps.markSettledSeen(nodeId, operationId);
        }
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.deps.selected.clear();
    this.pinned.clear();
    this.applying.clear();
    this.pendingApply.clear();
    this.runRecords.clear();
    this.runningSelections.clear();
    this.observed.clear();
  }
}
