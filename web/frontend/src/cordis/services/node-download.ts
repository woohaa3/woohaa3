import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { readCanonicalMedia } from "./media-remote.js";
import { downloadFilename, saveDownload } from "./file-download.js";

type DownloadSnapshot = { busy: boolean; error: boolean; text: string } | null;
type DownloadOptions = {
  getCanvas(): ServerCanvas | null;
  mediaContent?: Pick<import("../../extension-api/media-content.js").MediaContentService, "resolve">;
  /** 第三参数是画布身份：浏览器读画布媒体时带 `?canvas=` 提示。 */
  readMedia?: (asset: StoredAsset, signal: AbortSignal, canvasId?: string) => Promise<Blob>;
  exportModel?: (source: string, version: unknown, signal: AbortSignal) => Promise<Blob>;
  save?: (blob: Blob, filename: string) => void;
};

/** Canvas-scope transient operation; never changes nodes, assets or selection. */
export class NodeDownloadService {
  private snapshot: DownloadSnapshot = null;
  private readonly listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private disposed = false;
  constructor(private readonly options: DownloadOptions) {}
  getSnapshot = (): DownloadSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: DownloadSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
  dismiss = (): void => { if (!this.active) this.publish(null); };
  cancel = (): void => { this.active?.abort(); };
  dispose = (): void => { this.disposed = true; this.cancel(); this.listeners.clear(); };

  async download(nodeId: string): Promise<void> {
    if (this.active || this.disposed) return;
    const abort = new AbortController();
    this.active = abort;
    const timer = window.setTimeout(() => abort.abort(new Error("下载超时，请重试")), 120_000);
    this.publish({ busy: true, error: false, text: "正在准备下载…" });
    try {
      const canvas = this.options.getCanvas();
      const node = canvas?.document.nodes.find(node => node.id === nodeId);
      if (!canvas || !node) throw new Error("作品已不存在，无法下载");
      const data = canvas.nodeData[nodeId];
      let blob: Blob;
      if (node.type === "model3d") {
        if (!data?.modelScript?.trim()) throw new Error("模型尚无可下载的内容");
        const exporter = this.options.exportModel ?? (await import("./model-download.js")).downloadModelBlob;
        blob = await exporter(data.modelScript, data.modelScriptVersion, abort.signal);
      } else if (node.type === "image" || node.type === "video") {
        const asset = data?.mediaContent
          ? await this.options.mediaContent?.resolve(nodeId, "resolvePreview", `download:${crypto.randomUUID()}`)
          : canvas.assets.find(asset => asset.id === data?.outputAssetId);
        if (!asset || asset.status !== "ready" || asset.mediaKind !== node.type) throw new Error("资源尚未就绪，暂时无法下载");
        blob = await (this.options.readMedia ?? readCanonicalMedia)(asset, abort.signal, canvas.id);
        if (!blob.type.startsWith(`${node.type}/`)) throw new Error("资源返回的文件类型不正确，请重试");
      } else throw new Error("此类节点暂不支持下载");
      abort.signal.throwIfAborted();
      const fallback = node.type === "model3d" ? "3D 模型" : node.type === "video" ? "视频" : "图片";
      const filename = downloadFilename(typeof data?.title === "string" ? data.title : fallback, blob.type);
      (this.options.save ?? saveDownload)(blob, filename);
      this.publish({ busy: false, error: false, text: "已交给浏览器下载" });
    } catch (error) {
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      const cancelled = abort.signal.aborted && reason?.name === "AbortError";
      this.publish({ busy: false, error: !cancelled, text: cancelled ? "下载已取消"
        : reason instanceof Error ? reason.message : "下载失败，请重试" });
    } finally { window.clearTimeout(timer); this.active = null; }
  }
}
