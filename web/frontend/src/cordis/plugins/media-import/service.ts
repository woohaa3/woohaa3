/**
 * Media Import Service
 * （change: adopt-frontend-cordis-plugin-runtime，design D4/D5；
 *  change: add-paste-import-workflows，design D1/D4）。
 *
 * 文件选择、clipboard paste 与拖放共用的**批量 import coordinator**：
 * - bytes 只经 `mediaRemote` 上传到 Media Service；文本文件在受控上限内读取正文；
 * - 每个文件取得稳定 metadata/文本后，才通过 `canvasSession` 提交一个
 *   `asset.upsert` + `node.add`/`nodeData.patch` 的原子批次；
 * - 多文件独立提交，允许可诊断的部分成功；失败项在页面存活期内可用同一 File 重试；
 * - 不把 File/Blob 写入 IndexedDB 或离线 outbox；不直接 fetch 或拼 Media API path。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  GLB_MAX_FILE_BYTES,
  GLB_MEDIA_TYPE,
  parseGlbModel
} from "@woohaa3/contracts";
import {
  UPLOAD_ACCEPT,
  buildUploadedAsset,
  buildUploadedTextAsset,
  planReplaceImage,
  planUploadedNode,
  uploadedNodeType,
  type UploadFile
} from "../../../extension-api/upload-asset.js";
import {
  createImportItemId,
  planImportLayout,
  summarizeItems,
  IMPORT_CONCURRENCY,
  MAX_TEXT_FILE_BYTES
} from "../paste-import/batch.js";
import { classifyPasteFile, extractTransferFiles } from "../paste-import/datatransfer.js";
import type {
  ImportAnchor,
  ImportBatchInput,
  ImportBatchResult,
  ImportItem,
  ImportItemStage,
  ImportService,
  ImportState
} from "../../contracts.js";

/** 上传/提交失败时抛出的可诊断错误（阶段 + 安全摘要）。 */
class ImportStageError extends Error {
  constructor(readonly stage: ImportItemStage, message: string) {
    super(message);
    this.name = "ImportStageError";
  }
}

export class MediaImportService implements ImportService {
  private state: ImportState = { uploading: false, error: null, items: [] };
  private readonly listeners = new Set<() => void>();
  private fileInput: HTMLInputElement | null = null;
  private anchor: ImportAnchor = { world: null };
  private disposed = false;
  /** 页面存活期内的 File 句柄，供失败项重试（不持久化）。 */
  private readonly fileHandles = new Map<string, File>();
  private readonly objectUrls = new Set<string>();
  /**
   * 上传中的幽灵节点（只渲染，不进规范状态）。
   * 以 nodeId 为键，便于与真实节点同 id 接管；值为本地预览信息。
   */
  private readonly ghosts = new Map<string, {
    itemId: string;
    nodeType: "image" | "video" | "audio" | "text";
    world: { x: number; y: number; z?: number };
    label: string;
    objectUrl: string | null;
    progress: number;
  }>();

  constructor(private readonly ctx: Context) {}

  /** 当前画布身份：画布内导入的上传要带画布提示，让字节写入该画布的存储后端。 */
  private canvasId(): string | undefined {
    // Canvas page scope 一定提供 canvasScope；单测的轻量 Context 替身可以省略它。
    return this.ctx.canvasScope?.canvasId();
  }

  getState = (): ImportState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  requestFile(anchor: ImportAnchor): void {
    this.anchor = anchor;
    const input = this.ensureInput(false);
    input.value = "";
    input.click();
  }

  requestFiles(anchor: ImportAnchor): void {
    this.anchor = anchor;
    const input = this.ensureInput(true);
    input.value = "";
    input.click();
  }

  /** 批量 coordinator：逐文件独立原子提交，允许部分成功。 */
  async importBatch(input: ImportBatchInput): Promise<ImportBatchResult> {
    if (this.disposed) return { ok: false, succeeded: 0, failed: input.files.length, items: [] };
    const gate = this.canStartImport();
    if (!gate.ok) {
      const items = input.files.map((file) => this.newItem(file, { stage: "failed", error: gate.reason }));
      this.setState({ uploading: false, error: gate.reason, items });
      return summarizeItems(items);
    }

    // 与 paste/drop 相同口径的分类：不支持类型直接进失败项，其余做 metadata 初筛
    // （内容 hash 去重已在 dispatcher 的 DataTransfer 提取阶段完成）。
    const items: ImportItem[] = [];
    const pending: Array<{ file: File; itemId: string }> = [];
    for (const file of input.files) {
      const kind = classifyPasteFile(file);
      if (!kind) {
        items.push(this.newItem(file, { stage: "failed", error: "不支持的文件类型" }));
        continue;
      }
      if (pending.some((entry) => sameFileMetadata(entry.file, file))) continue;
      const id = createImportItemId();
      this.fileHandles.set(id, file);
      items.push({ id, name: file.name || "(未命名文件)", kind, size: file.size, stage: "pending" });
      pending.push({ file, itemId: id });
    }

    this.setState({ uploading: true, error: null, items });

    const viewport = this.ctx.canvasRuntime.controller()?.viewport();
    const anchorPos = input.anchor.world ?? this.viewportCenterWorld();
    const layout = planImportLayout(anchorPos, pending.length, viewport?.zoom ?? 1);

    await runWithConcurrency(pending, IMPORT_CONCURRENCY, async (entry, index) => {
      const nodeId = `import-node-${entry.itemId}`;
      const nodeType = uploadedNodeType(entry.file);
      const world = layout[index] ?? anchorPos;
      // 立刻把节点作为「幽灵节点」交给画布渲染（不等上传完成）——design D7 修订。
      // 用与真实节点相同的 id，渲染外观完全一致；上传完成提交命令后由真实节点接管。
      if (nodeType === "image" || nodeType === "video" || nodeType === "audio" || nodeType === "text") {
        this.addGhost(nodeId, entry.file, nodeType, world);
      }
      try {
        this.setItem(entry.itemId, { stage: "uploading" });
        await this.importOne(entry.file, {
          world,
          nodeId,
          ...(input.anchor.connectFrom ? { connectFrom: input.anchor.connectFrom } : {})
        });
        // 命令已提交：真实节点由 working projection 接管；移除 ghost 并释放 object URL。
        this.removeGhost(nodeId);
        this.setItem(entry.itemId, { stage: "done", nodeId });
      } catch (error) {
        const message = error instanceof ImportStageError ? error.message : "导入失败";
        this.removeGhost(nodeId);
        this.setItem(entry.itemId, { stage: "failed", error: message });
      }
    });

    const finalItems = this.state.items;
    const summary = summarizeItems(finalItems);
    this.setState({ uploading: false, error: summary.failed > 0 ? "部分文件导入失败" : null });
    return summary;
  }

  /** 用当前页面存活期的 File 重试单个失败项。 */
  async retryItem(itemId: string): Promise<{ ok: boolean; error?: string }> {
    const file = this.fileHandles.get(itemId);
    if (!file) return { ok: false, error: "文件已不可用，请重新导入" };
    const item = this.state.items.find((entry) => entry.id === itemId);
    if (!item) return { ok: false, error: "导入项已不存在" };
    const nodeId = `import-node-${itemId}`;
    const nodeType = uploadedNodeType(file);
    this.setItem(itemId, { stage: "pending", error: undefined });
    const world = this.anchor.world ?? this.viewportCenterWorld();
    if (nodeType === "image" || nodeType === "video" || nodeType === "audio" || nodeType === "text") {
      this.addGhost(nodeId, file, nodeType, world);
    }
    try {
      this.setItem(itemId, { stage: "uploading" });
      await this.importOne(file, { ...this.anchor, world, nodeId });
      this.removeGhost(nodeId);
      this.setItem(itemId, { stage: "done", nodeId });
      this.recomputeError();
      return { ok: true };
    } catch (error) {
      const message = error instanceof ImportStageError ? error.message : "重试失败";
      this.removeGhost(nodeId);
      this.setItem(itemId, { stage: "failed", error: message });
      this.recomputeError();
      return { ok: false, error: message };
    }
  }

  /** 单图替换：先稳定上传，再以一个批次 upsert 资产并 patch 目标节点。 */
  async replaceSelectedImage(input: { file: File; nodeId: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.disposed) return { ok: false, error: "导入能力已释放" };
    const kind = classifyPasteFile(input.file);
    if (kind !== "image") return { ok: false, error: "只能替换为受支持的图片" };
    if (!this.ctx.canvasSession.isWritable()) return { ok: false, error: "网络不可用，画布只读" };
    this.setState({ uploading: true, error: null });
    try {
      const uploaded = await this.ctx.mediaRemote.upload({ file: input.file, canvasId: this.canvasId() });
      if (!uploaded.ok) return this.fail(uploaded.error);
      const asset = buildUploadedAsset({
        media: uploaded.media,
        mediaKind: "image",
        file: input.file
      });
      // 上传后再次检查写入门禁（spec「上传完成、提交命令前再次检查」）。
      if (!this.ctx.canvasSession.isWritable()) return this.fail("网络不可用，画布只读");
      const result = this.ctx.canvasSession.submitCommands(
        planReplaceImage({ nodeId: input.nodeId, asset }),
        `web-replace-image-${Date.now().toString(36)}`
      );
      if (!result.ok) return this.fail(result.reason);
      return { ok: true };
    } catch {
      return this.fail("替换失败");
    } finally {
      this.setState({ uploading: false });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.fileInput?.remove();
    this.fileInput = null;
    this.listeners.clear();
    this.fileHandles.clear();
    this.ghosts.clear();
    this.ctx.canvasRuntime.setGhostNodes([]);
    this.ctx.canvasRuntime.setPreviewUrls(new Map());
    for (const url of this.objectUrls) {
      revokeObjectUrl(url);
    }
    this.objectUrls.clear();
  }

  // --- ghost nodes (uploading placeholders rendered as real nodes) ----------

  /**
   * 新增/更新一个上传中的幽灵节点，并同步给画布渲染 + 本地预览纹理。
   * `nodeId` 与真实节点一致，上传完成后真实节点接管。
   */
  private addGhost(
    nodeId: string,
    file: File,
    nodeType: "image" | "video" | "audio" | "text",
    world: { x: number; y: number; z?: number }
  ): void {
    // 只有图片/视频能预览本地内容；音频/文本用节点卡片自身样式（无纹理）。
    const canPreview = nodeType === "image" || nodeType === "video";
    const objectUrl = canPreview ? this.createObjectUrl(file) : null;
    this.ghosts.set(nodeId, {
      itemId: nodeId,
      nodeType,
      world,
      label: file.name || "上传中",
      objectUrl,
      progress: 0
    });
    this.flushGhosts();
  }

  /** 更新幽灵节点进度（0..100），驱动节点卡片上的进度环/进度条。 */
  private setGhostProgress(nodeId: string, progress: number): void {
    const ghost = this.ghosts.get(nodeId);
    if (!ghost) return;
    ghost.progress = Math.max(0, Math.min(100, progress));
    this.flushGhosts();
  }

  private removeGhost(nodeId: string): void {
    const ghost = this.ghosts.get(nodeId);
    if (!ghost) return;
    if (ghost.objectUrl) {
      revokeObjectUrl(ghost.objectUrl);
      this.objectUrls.delete(ghost.objectUrl);
    }
    this.ghosts.delete(nodeId);
    this.flushGhosts();
  }

  /** 把当前 ghosts 同步给画布渲染（幽灵节点 + 本地预览纹理 URL）。 */
  private flushGhosts(): void {
    const ghostNodes = [...this.ghosts.entries()].map(([id, ghost]) => ({
      id,
      nodeType: ghost.nodeType,
      x: ghost.world.x,
      y: ghost.world.y,
      label: ghost.label,
      status: "上传中",
      progress: ghost.progress,
      texture: ghost.objectUrl !== null
    }));
    const previewUrls = new Map<string, string>();
    for (const [id, ghost] of this.ghosts) {
      if (ghost.objectUrl) previewUrls.set(id, ghost.objectUrl);
    }
    this.ctx.canvasRuntime.setGhostNodes(ghostNodes);
    this.ctx.canvasRuntime.setPreviewUrls(previewUrls);
  }

  private createObjectUrl(file: File): string | null {
    // `URL.createObjectURL` 在部分环境（无 Blob URL 支持的 jsdom/SSR）不可用；此时退回
    // 无纹理节点卡片，不产生数据 URL（规范状态也不允许）。
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    try {
      const url = URL.createObjectURL(file);
      this.objectUrls.add(url);
      return url;
    } catch {
      return null;
    }
  }

  // --- internals ----------------------------------------------------------

  /**
   * GLB 文件模型导入（change: 2026-10-28-support-glb-model-nodes，任务 2.1）。
   *
   * 顺序：本地读取 → 预算/格式/可呈现性校验 → 上传原始字节 → 原子提交
   * `asset.upsert` + `node.add`。校验失败时不产生任何规范资产或节点；上传成功后提交失败只会
   * 留下不可达的存储对象，规范画布仍保持原状。
   */
  private async importModel(file: File, anchor: ImportAnchor & { nodeId: string }): Promise<void> {
    if (file.size > GLB_MAX_FILE_BYTES) {
      throw new ImportStageError(
        "reading",
        `GLB 文件超过 ${Math.round(GLB_MAX_FILE_BYTES / 1024 / 1024)}MB 上限`
      );
    }
    let parsed: ReturnType<typeof parseGlbModel>;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new ImportStageError("reading", "文件读取失败（编码或权限问题）");
    }
    parsed = parseGlbModel(bytes);
    if (!parsed.ok) throw new ImportStageError("reading", `无法使用该 GLB：${parsed.message}`);
    // 浏览器可能给出空 MIME 或 octet-stream；上传时显式标注为 GLB，便于下载恢复。
    const uploadFile = typeof File === "function" && file.type !== GLB_MEDIA_TYPE
      ? new File([file], file.name || "model.glb", { type: GLB_MEDIA_TYPE, lastModified: file.lastModified })
      : file;
    const uploaded = await this.ctx.mediaRemote.upload({
      file: uploadFile,
      canvasId: this.canvasId(),
      onProgress: (percent) => this.setGhostProgress(anchor.nodeId, percent)
    });
    if (!uploaded.ok) throw new ImportStageError("uploading", uploaded.error);
    if (!this.ctx.canvasSession.isWritable()) {
      throw new ImportStageError("submitting", "网络不可用，画布只读");
    }
    const asset = buildUploadedAsset({
      media: uploaded.media,
      mediaKind: "file",
      modelFormat: "glb",
      file: uploadFile
    });
    this.submit(
      // 模型没有卡片：落点只投影成世界实例，不参与卡片连线规则。
      planUploadedNode({
        nodeType: "model3d",
        position: anchor.world ?? { x: 0, y: 0 },
        file: uploadFile,
        asset,
        nodeId: anchor.nodeId
      })
    );
  }

  private async importOne(file: File, anchor: ImportAnchor & { nodeId: string }): Promise<void> {
    const nodeType = uploadedNodeType(file);
    if (!nodeType) throw new ImportStageError("pending", "不支持的文件类型（仅图片/视频/音频/文本/GLB）");

    if (nodeType === "model3d") {
      await this.importModel(file, anchor);
      return;
    }

    if (nodeType === "text") {
      if (file.size > MAX_TEXT_FILE_BYTES) {
        throw new ImportStageError("reading", `文本文件超过 ${Math.round(MAX_TEXT_FILE_BYTES / 1024)}KB 上限`);
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        throw new ImportStageError("reading", "文本读取失败（编码或权限问题）");
      }
      const asset = buildUploadedTextAsset({ file, text });
      this.submit(
        planUploadedNode({
          nodeType,
          position: anchor.world ?? { x: 0, y: 0 },
          file,
          asset,
          nodeId: anchor.nodeId,
          ...(anchor.connectFrom ? { connectFrom: anchor.connectFrom } : {})
        })
      );
      return;
    }

    const uploaded = await this.ctx.mediaRemote.upload({
      file,
      // 画布内导入：上传请求带画布提示（POST /api/media?canvas=<id>）。
      canvasId: this.canvasId(),
      // 上传进度直接驱动幽灵节点的进度环（1..99 由传输层上报，100 由完成态接管）。
      onProgress: (percent) => this.setGhostProgress(anchor.nodeId, percent)
    });
    if (!uploaded.ok) throw new ImportStageError("uploading", uploaded.error);
    const asset = buildUploadedAsset({
      media: uploaded.media,
      mediaKind: nodeType as "image" | "video" | "audio",
      file
    });
    // 上传后再次检查写入门禁（spec「上传完成、提交命令前再次检查」）。
    if (!this.ctx.canvasSession.isWritable()) {
      throw new ImportStageError("submitting", "网络不可用，画布只读");
    }
    this.submit(
      planUploadedNode({
        nodeType,
        position: anchor.world ?? { x: 0, y: 0 },
        file,
        asset,
        nodeId: anchor.nodeId,
        ...(anchor.connectFrom ? { connectFrom: anchor.connectFrom } : {})
      })
    );
  }

  private submit(commands: ReturnType<typeof planUploadedNode>): void {
    if (!this.ctx.canvasSession.isWritable()) {
      throw new ImportStageError("submitting", "网络不可用，画布只读");
    }
    const result = this.ctx.canvasSession.submitCommands(
      commands,
      `web-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    );
    if (!result.ok) throw new ImportStageError("submitting", result.reason);
  }

  private canStartImport(): { ok: true } | { ok: false; reason: string } {
    if (!this.ctx.canvasSession.isWritable()) return { ok: false, reason: "网络不可用，画布只读" };
    const status = this.ctx.canvasRuntime.getStatus();
    if (status.phase === "error") return { ok: false, reason: "画布运行时错误，暂不可导入" };
    return { ok: true };
  }

  private viewportCenterWorld(): { x: number; y: number } {
    const controller = this.ctx.canvasRuntime.controller();
    if (controller) {
      const surface = controller.surface();
      const viewport = controller.viewport();
      return {
        x: (surface.width / 2 - viewport.x) / viewport.zoom,
        y: (surface.height / 2 - viewport.y) / viewport.zoom
      };
    }
    return { x: 0, y: 0 };
  }

  private newItem(file: File, patch: Partial<ImportItem>): ImportItem {
    const id = patch.id ?? createImportItemId();
    if (!this.fileHandles.has(id)) this.fileHandles.set(id, file);
    return {
      id,
      name: file.name || "(未命名文件)",
      kind: null,
      size: file.size,
      stage: "pending",
      ...patch
    };
  }

  private setItem(itemId: string, patch: Partial<ImportItem>): void {
    this.setState({
      items: this.state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
    });
  }

  private recomputeError(): void {
    const failed = this.state.items.filter((item) => item.stage === "failed").length;
    this.setState({ error: failed > 0 ? "部分文件导入失败" : null });
  }

  private fail(error: string): { ok: false; error: string } {
    this.setState({ error });
    return { ok: false, error };
  }

  private setState(patch: Partial<ImportState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private ensureInput(multiple: boolean): HTMLInputElement {
    if (this.fileInput && this.fileInput.multiple === multiple) return this.fileInput;
    this.fileInput?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = UPLOAD_ACCEPT;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      input.value = "";
      if (files.length === 0) return;
      void this.importBatch({ files, anchor: this.anchor, source: "picker", selectedNodeIds: [] });
    });
    document.body.appendChild(input);
    this.fileInput = input;
    return input;
  }
}

function sameFileMetadata(a: File, b: File): boolean {
  return a.name === b.name && a.type === b.type && a.size === b.size && a.lastModified === b.lastModified;
}

function revokeObjectUrl(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}

/** 供 paste/drop dispatcher 复用的提取入口（保持一处去重口径）。 */
export { extractTransferFiles };
export type { UploadFile };
