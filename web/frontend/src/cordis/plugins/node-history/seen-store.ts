/**
 * 历史圆点未读基线：按画布/节点持久化上次查看的 createdAt。
 *
 * 只负责“哪些成功版本已经看过”，不持有选择、不决定切换行为。
 */
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { unseenEntryIds } from "./version-model.js";

export type SeenStorage = Pick<Storage, "getItem" | "setItem">;
const SEEN_STORAGE_PREFIX = "woohaa:node-history-seen:v1:";
const SEEN_STORAGE_MAX_NODES = 200;

function defaultStorage(): SeenStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class HistorySeenStore {
  private readonly seenAt = new Map<string, string>();
  private readonly baseline = new Set<string>();
  private readonly openedAt: string;
  private readonly storage: SeenStorage | null;

  constructor(private readonly canvasId: string, options: {
    storage?: SeenStorage | null;
    /** 测试/嵌入式时钟。 */
    now?: () => string;
  } = {}, private readonly onChange?: () => void) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.openedAt = (options.now ?? (() => new Date().toISOString()))();
    this.load();
  }

  private load() {
    try {
      const raw = this.storage?.getItem(`${SEEN_STORAGE_PREFIX}${this.canvasId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [nodeId, at] of Object.entries(parsed)) if (typeof at === "string" && at) this.seenAt.set(nodeId, at);
    } catch { /* 损坏的本地提示状态不应阻塞历史读取。 */ }
  }

  private persist() {
    try {
      const newest = [...this.seenAt.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, SEEN_STORAGE_MAX_NODES);
      this.storage?.setItem(`${SEEN_STORAGE_PREFIX}${this.canvasId}`, JSON.stringify(Object.fromEntries(newest)));
    } catch { /* 存储不可用只丢提示，不影响版本切换。 */ }
  }

  /** 画布出现节点时建立基线：有历史取最新条目，没有则取本页打开时刻。 */
  baselineNode(nodeId: string, items: readonly NodeGenerationHistoryListItem[]) {
    if (this.baseline.has(nodeId)) return false;
    this.baseline.add(nodeId);
    if (this.seenAt.has(nodeId)) return false;
    const newest = items.length
      ? items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, "")
      : this.openedAt;
    if (!newest) return false;
    this.seenAt.set(nodeId, newest);
    this.persist();
    return true;
  }

  baselineNodes(nodeIds: readonly string[]) {
    let changed = false;
    for (const nodeId of nodeIds) {
      if (this.seenAt.has(nodeId) || this.baseline.has(nodeId)) continue;
      this.baseline.add(nodeId);
      this.seenAt.set(nodeId, this.openedAt);
      changed = true;
    }
    if (changed) { this.persist(); this.onChange?.(); }
  }

  markEntry(nodeId: string, item: NodeGenerationHistoryListItem | undefined) {
    if (!item) return;
    const previous = this.seenAt.get(nodeId);
    if (previous && previous >= item.createdAt) return;
    this.seenAt.set(nodeId, item.createdAt);
    this.persist();
    this.onChange?.();
  }

  markNode(nodeId: string, items: readonly NodeGenerationHistoryListItem[]) {
    const newest = items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, "");
    if (!newest) return;
    const previous = this.seenAt.get(nodeId);
    if (previous && previous >= newest) return;
    this.seenAt.set(nodeId, newest);
    this.persist();
    this.onChange?.();
  }

  unseenFor(nodeId: string, items: readonly NodeGenerationHistoryListItem[]): Set<string> {
    return unseenEntryIds(items, this.seenAt.get(nodeId));
  }

  seenAtOf(nodeId: string): string | undefined {
    return this.seenAt.get(nodeId);
  }
}
