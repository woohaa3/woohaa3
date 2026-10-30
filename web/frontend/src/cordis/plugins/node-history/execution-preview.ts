import { executeModelScriptVersioned, isSupportedModelScriptVersion, prepareModelResource, sceneIrVersionFor,
  type PreparedModelResource, type NodeGenerationHistoryDetail, type CanvasOperationRecord, type NodeGenerationHistoryListItem, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import { stripAppLocationPathname } from "../../services/app-base-path.js";
import { mediaUrlFor } from "../../services/paths.js";

/** Page-owned dot selection. Never changes canonical output, task identity or inputs. */
export class ExecutionPreview {
  readonly selected = new Map<string, string>();
  private observed = new Set<string>();
  private details = new Map<string, NodeGenerationHistoryDetail>();
  private loading = new Map<string, string>();
  readonly models = new Map<string, PreparedModelResource>();
  private disposed = false;
  private revision = 0;
  private cached: { canvas: ServerCanvas; history: ReturnType<ExecutionPreview["history"]>; revision: number; value: ServerCanvas } | null = null;
  constructor(private history: () => ReadonlyMap<string, readonly NodeGenerationHistoryListItem[]>,
    private changed: () => void, private client?: NodeHistoryClient, private canvasId?: string,
    private report: (error: unknown) => void = console.error) {}
  private publish() { this.revision++; this.changed(); }

  private item(nodeId: string) {
    return this.history().get(nodeId)?.find(item =>
      (item.source.runId ? `operation:${item.source.runId}` : `entry:${item.entryId}`) === this.selected.get(nodeId));
  }
  /** Keep an explicitly selected old entry when the bounded recent summary rolls forward. */
  retain(history: Map<string, readonly NodeGenerationHistoryListItem[]>) {
    for (const nodeId of this.selected.keys()) {
      const previous = this.item(nodeId), next = history.get(nodeId);
      if (previous && next && next.length >= 24 && !next.some(item => item.entryId === previous.entryId)) {
        history.set(nodeId, [...next, previous].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId)));
      }
    }
  }
  refresh() {
    if (this.disposed || !this.client || !this.canvasId) return;
    for (const [nodeId, id] of this.selected) {
      const item = this.item(nodeId);
      if (!item || (item.outcome ?? "succeeded") !== "succeeded" || !item.previewable
        || this.details.get(nodeId)?.entryId === item.entryId || this.loading.get(nodeId) === item.entryId) continue;
      this.loading.set(nodeId, item.entryId);
      void this.client.detail({ canvasId: this.canvasId, nodeId, entryId: item.entryId }).then(result => {
        if (this.disposed || this.selected.get(nodeId) !== id || this.loading.get(nodeId) !== item.entryId) return;
        if (!result.ok) throw new Error(result.error);
        if (result.detail.entryId !== item.entryId || result.detail.kind === "failure") return;
        this.details.set(nodeId, result.detail);
        if (result.detail.kind === "model" && isSupportedModelScriptVersion(result.detail.version)) {
          const execution = executeModelScriptVersioned(result.detail.modelScript, result.detail.version);
          if (execution.ok) this.models.set(nodeId, prepareModelResource({ sceneVersion: sceneIrVersionFor(result.detail.version), ops: execution.scene.ops }));
        }
        this.publish();
      }).catch(error => { if (!this.disposed && this.selected.get(nodeId) === id) this.report(error); })
        .finally(() => { if (this.loading.get(nodeId) === item.entryId) this.loading.delete(nodeId); });
    }
  }

  observe(records: readonly CanvasOperationRecord[]) {
    let changed = false;
    // Records can arrive as a whole snapshot; choose the newest newly observed activity per node.
    for (const record of [...records].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId))) {
      const fresh = !this.observed.has(record.operationId);
      this.observed.add(record.operationId);
      if (fresh && (record.state === "queued" || record.state === "running")) {
        this.selected.set(record.nodeId, `operation:${record.operationId}`);
        this.details.delete(record.nodeId); this.models.delete(record.nodeId); changed = true;
      }
    }
    if (changed) this.publish();
  }
  select(nodeId: string, presentationId: string) {
    if (this.selected.get(nodeId) === presentationId) return;
    this.selected.set(nodeId, presentationId); this.details.delete(nodeId); this.models.delete(nodeId);
    this.refresh(); this.publish();
  }
  project = (canvas: ServerCanvas | null): ServerCanvas | null => {
    if (!canvas || !this.selected.size) return canvas;
    const history = this.history();
    if (this.cached?.canvas === canvas && this.cached.history === history && this.cached.revision === this.revision) return this.cached.value;
    const nodeData = { ...canvas.nodeData }, assets = [...canvas.assets];
    let changed = false;
    for (const nodeId of this.selected.keys()) {
      if (!canvas.document.nodes.some(node => node.id === nodeId)) continue;
      const item = this.item(nodeId);
      if (!item) continue;
      const preview = item.preview;
      if (preview.kind === "failure") {
        // 选中失败/取消归档时用失败原因替换卡片内容：清掉上一个成功输出的媒体/模型引用，
        // 避免卡片继续显示旧预览；正文由 render-scene 的 readBody 从该本地字段读取。
        const data = { ...nodeData[nodeId] };
        data.historyPreviewFailure = { outcome: preview.outcome, message: preview.message };
        delete data.outputAssetId;
        delete data.posterAssetId;
        delete data.result;
        delete data.resultPreview;
        delete data.modelScript;
        delete data.modelAssetId;
        delete data.modelPlacement;
        nodeData[nodeId] = data;
        changed = true;
        continue;
      }
      if ((item.outcome ?? "succeeded") !== "succeeded" || !item.previewable) continue;
      const data = { ...nodeData[nodeId] };
      const detail = this.details.get(nodeId);
      const asset = (id: string, mediaKind: StoredAsset["mediaKind"], url: string): StoredAsset =>
        ({ id, mediaKind, status: "ready", url, title: "历史预览", source: "generated", createdAt: item.createdAt });
      if (detail?.kind === "model") {
        data.modelScript = detail.modelScript; data.modelScriptVersion = detail.version;
        if (detail.placement) data.modelPlacement = detail.placement;
      } else if (preview.kind === "text") data.result = { kind: "text", text: detail?.kind === "text" ? detail.text : preview.excerpt };
      else if (preview.kind === "image" || preview.kind === "video" || preview.kind === "audio") {
        const assetId = `history-preview:${item.entryId}`;
        const mediaDetail = detail && (detail.kind === "image" || detail.kind === "video" || detail.kind === "audio") ? detail : null;
        const main = asset(assetId, preview.kind, mediaDetail ? mediaUrlFor(mediaDetail.storageKey) : stripAppLocationPathname(preview.href));
        if (mediaDetail) main.metadata = { storageKey: mediaDetail.storageKey, checksum: mediaDetail.checksum, contentType: mediaDetail.contentType, size: mediaDetail.size };
        assets.push(main);
        data.outputAssetId = assetId;
        if (preview.kind === "video") {
          data.durationSeconds = mediaDetail?.durationSeconds ?? preview.durationSeconds ?? undefined;
          data.posterAssetId = undefined;
          if (preview.posterHref) {
            const posterId = `${assetId}:poster`;
            assets.push(asset(posterId, "image", stripAppLocationPathname(preview.posterHref)));
            data.posterAssetId = posterId;
          }
          if (mediaDetail?.poster) main.posterUrl = mediaUrlFor(mediaDetail.poster.storageKey);
        }
      } else continue;
      nodeData[nodeId] = data; changed = true;
    }
    const value = changed ? { ...canvas, nodeData, assets } : canvas;
    this.cached = { canvas, history, revision: this.revision, value };
    return value;
  };
  dispose() { this.disposed = true; this.selected.clear(); this.observed.clear(); this.details.clear(); this.models.clear(); this.loading.clear(); this.cached = null; }
}
