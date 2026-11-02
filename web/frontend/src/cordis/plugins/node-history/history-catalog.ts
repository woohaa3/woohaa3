/**
 * 节点历史摘要目录：只负责加载、排序、去重和刷新。
 *
 * 不持有选择、未读、apply 或运行态；变化通过 onChange 通知上层。
 */
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import type { CanvasHistoryClient } from "./canvas-history-controller.js";

const sortVersions = (items: readonly NodeGenerationHistoryListItem[]) =>
  [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId));

export class NodeHistoryCatalog {
  private versions = new Map<string, readonly NodeGenerationHistoryListItem[]>();
  private loading = false;
  private refreshAgain = false;
  private revision = 0;
  private readonly nodeRevisions = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly client: NodeHistoryClient & Partial<CanvasHistoryClient>,
    private readonly canvasId: string,
    private readonly report: (error: unknown) => void,
    private readonly onChange: (versions: Map<string, readonly NodeGenerationHistoryListItem[]>) => void
  ) {}

  snapshot = (): ReadonlyMap<string, readonly NodeGenerationHistoryListItem[]> => this.versions;
  items = (nodeId: string): readonly NodeGenerationHistoryListItem[] | undefined => this.versions.get(nodeId);

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
      this.versions = new Map(this.versions).set(nodeId, sortVersions(result.items));
      this.onChange(this.versions);
    } catch (error) { if (!this.disposed) this.report(error); }
  }

  async refresh() {
    if (this.disposed || !this.client.listCanvas) return;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    const revision = ++this.revision;
    try {
      const grouped = new Map<string, NodeGenerationHistoryListItem[]>();
      const result = await this.client.listCanvas({ canvasId: this.canvasId, summary: true });
      if (this.disposed) return;
      if (!result.ok) throw new Error(result.error);
      for (const item of result.items) {
        const list = grouped.get(item.nodeId) ?? [];
        list.push(item);
        grouped.set(item.nodeId, list);
      }
      const next = new Map<string, readonly NodeGenerationHistoryListItem[]>();
      for (const [nodeId, items] of grouped) next.set(nodeId, sortVersions(items));
      // A targeted compensation may have completed while this canvas read was in flight.
      for (const [nodeId, nodeRevision] of this.nodeRevisions) {
        if (nodeRevision > revision && this.versions.has(nodeId)) next.set(nodeId, [...this.versions.get(nodeId)!]);
      }
      this.versions = next;
      this.onChange(this.versions);
    } catch (error) { if (!this.disposed) this.report(error); }
    finally {
      this.loading = false;
      if (this.refreshAgain && !this.disposed) { this.refreshAgain = false; void this.refresh(); }
    }
  }

  dispose() { this.disposed = true; }
}
