/**
 * 归档导出 / 校验 / 导入与跨 backend 迁移（任务 8.2–8.5 / design D12）。
 *
 * 语义要点：
 * - `exportArchive`：从任意 `CanvasRepository` 生成 metadata-only 归档，可选校验 COS 引用。
 * - `verifyArchive`：重算 SHA-256、检查记录数量与引用，篡改必须失败。
 * - `importArchive`：默认 no-overwrite；dry-run 零写入；可选 replace 前自动备份。
 * - 导入在**所有**结构化记录与 COS 引用校验通过后才发布；中途失败不留部分画布。
 */
import type { ServerCanvas, ApplicationExtensionArchiveDefinition } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import type { CanvasRepository } from "./contracts.js";
import type { CanvasPublishedReader } from "./catalog-service.js";
import { CanvasStorageError } from "./errors.js";
import { buildCanvasArchive,
  extractAssetReferences,
  validateArchiveShape,
  type ArchiveAssetReference,
  type ArchiveExtensionMediaReference,
  type ArchiveOperationRecord,
  type CanvasArchive } from "./archive-format.js";
import { collectExtensionMediaReferences } from "./archive-extension-media.js";
import { storageKeyChecksum } from "./asset-validation.js";

export type CanvasArchivePublication = {
  /** Capture every target before any mutation. Offline callers exclude live writers. */
  prepare(canvasIds: readonly string[]): Promise<{
    publish(canvas: ServerCanvas): Promise<void>;
    rollback(): Promise<void>;
  }>;
};

export type ArchiveServiceOptions = {
  publication?: CanvasArchivePublication;
  repository: CanvasRepository;
  /** Yjs 部署从已发布的权威投影导出，不读取启动前的 legacy 快照。 */
  publishedReader?: CanvasPublishedReader;
  /** 可选中立媒体存储；提供时校验 COS 引用存在性与 metadata。 */
  mediaStorage?: MediaStorage;
  /** 可信静态扩展贡献；离线使用，不受个人/站点启停影响。 */
  extensionArchiveDefinitions?: readonly ApplicationExtensionArchiveDefinition[];
  now?: () => string;
  computeSha256?: (text: string) => Promise<string>;
};

export type ArchiveVerifyResult =
  | { ok: true; canvasCount: number; operationCount: number; assetCount: number }
  | { ok: false; code: ArchiveVerifyErrorCode; detail: string };

export type ArchiveVerifyErrorCode =
  | "invalid-shape"
  | "unsupported-format"
  | "checksum-mismatch"
  | "record-count-mismatch"
  | "binary-content"
  | "missing-cos-object"
  | "asset-metadata-mismatch";

export type ImportOptions = {
  /** 只做检查，不写目标库（spec「Dry run」）。 */
  dryRun?: boolean;
  /** 目标已存在相同 canvasId 时是否替换。默认 false（拒绝）。 */
  replace?: boolean;
  /** 启用远端媒体校验时逐一检查 storageKey。 */
  verifyMedia?: boolean;
};

export type ImportResult = {
  importedCanvasIds: string[];
  replacedCanvasIds: string[];
  skipped: boolean;
  dryRun: boolean;
};

export class CanvasArchiveService {
  private readonly repository: CanvasRepository;
  private readonly publication?: CanvasArchivePublication;
  private readonly publishedReader?: CanvasPublishedReader;
  private readonly mediaStorage?: MediaStorage;
  private readonly now: () => string;
  private readonly computeSha256: (text: string) => Promise<string>;
  private readonly extensionArchiveDefinitions: readonly ApplicationExtensionArchiveDefinition[];

  constructor(options: ArchiveServiceOptions) {
    this.repository = options.repository;
    this.publication = options.publication;
    this.publishedReader = options.publishedReader;
    this.mediaStorage = options.mediaStorage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.computeSha256 = options.computeSha256 ?? defaultSha256;
    this.extensionArchiveDefinitions = options.extensionArchiveDefinitions ?? [];
  }

  /** 导出全部或指定画布（任务 8.2）。 */
  async exportArchive(canvasIds?: readonly string[]): Promise<CanvasArchive> {
    const targets = canvasIds ?? await this.listAllCanvasIds();
    const records: Array<{ canvas: ServerCanvas; operations: ArchiveOperationRecord[]; mediaReferences: ArchiveExtensionMediaReference[] }> = [];
    for (const canvasId of targets) {
      const canvas = await this.publishedReader?.loadPublished(canvasId) ?? await this.repository.getCanvas(canvasId);
      if (!canvas) {
        throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
      }
      const operations = await this.listOperations(canvasId);
      const mediaReferences = await collectExtensionMediaReferences(canvas, this.extensionArchiveDefinitions, this.mediaStorage, {
        canvasId
      });
      records.push({ canvas, operations, mediaReferences });
    }
    return buildCanvasArchive({ canvases: records, createdAt: this.now() }, this.computeSha256);
  }

  /**
   * 校验归档（任务 8.2）：shape、SHA-256、记录数量，可选 COS 引用存在性。
   * 任一不符即失败并指出损坏项。
   */
  async verifyArchive(
    input: unknown,
    options: { verifyMedia?: boolean } = {}
  ): Promise<ArchiveVerifyResult> {
    const shape = validateArchiveShape(input);
    if (shape) {
      if (shape.code === "unsupported-format") {
        return { ok: false, code: "unsupported-format", detail: `不支持的归档格式：${String(shape.format)}` };
      }
      if (shape.code === "binary-content") return { ok: false, code: "binary-content", detail: shape.detail };
      return { ok: false, code: "invalid-shape", detail: JSON.stringify(shape) };
    }
    const archive = input as CanvasArchive;

    // 重算结构化文件的 SHA-256 与记录数。
    const payloads: Record<string, { json: string; count: number }> = {
      "canvases.json": { json: JSON.stringify(archive.canvases), count: archive.canvases.length },
      "operations.json": { json: JSON.stringify(archive.operations), count: archive.operations.length }
    };
    for (const file of archive.files) {
      const payload = payloads[file.name];
      if (!payload) continue;
      const digest = await this.computeSha256(payload.json);
      if (digest !== file.sha256) {
        return { ok: false, code: "checksum-mismatch", detail: `${file.name} SHA-256 不一致` };
      }
      if (payload.count !== file.recordCount) {
        return { ok: false, code: "record-count-mismatch", detail: `${file.name} 记录数量不一致` };
      }
    }

    // 校验归档内的资产引用与画布内 assets 一致（防止裁剪后引用清单残缺）。
    let assetCount = 0;
    for (const record of archive.canvases) {
      assetCount += record.assets.length;
      const expected = extractAssetReferences(record.canvas);
      if (JSON.stringify(expected) !== JSON.stringify(record.assets)) {
        return { ok: false, code: "invalid-shape", detail: `画布 ${record.canvasId} 资产引用清单不完整` };
      }
      if (record.mediaReferences !== undefined && (!Array.isArray(record.mediaReferences) || record.mediaReferences.some(ref =>
        !ref || typeof ref.extensionId !== "string" || typeof ref.nodeId !== "string" || typeof ref.storageKey !== "string" || !storageKeyChecksum(ref.storageKey) ||
        storageKeyChecksum(ref.storageKey) !== ref.checksum || typeof ref.contentType !== "string" || !Number.isSafeInteger(ref.size) || ref.size < 0
      ))) return { ok: false, code: "invalid-shape", detail: `画布 ${record.canvasId} 扩展媒体引用非法` };
    }

    if (options.verifyMedia) {
      const mediaResult = await this.verifyMediaReferences(archive);
      if (!mediaResult.ok) return mediaResult;
    }

    return {
      ok: true,
      canvasCount: archive.canvases.length,
      operationCount: archive.operations.length,
      assetCount
    };
  }

  /** 通过注入的 MediaStorage 校验全部 storageKey 的存在性与 metadata（不复制 bytes）。 */
  async verifyMediaReferences(archive: CanvasArchive): Promise<ArchiveVerifyResult> {
    const storage = this.mediaStorage;
    if (!storage) {
      return { ok: false, code: "missing-cos-object", detail: "未配置媒体存储，无法校验 COS 引用" };
    }
    for (const record of archive.canvases) {
      // 归档记录自带画布 id：核验存在性时带上作用域（远端画布的字节只在托管存储里）。
      const scope = { canvasId: record.canvasId };
      let derived: ArchiveExtensionMediaReference[];
      try { derived = await collectExtensionMediaReferences(record.canvas, this.extensionArchiveDefinitions, storage, scope); }
      catch (error) { return { ok: false, code: "missing-cos-object", detail: `扩展媒体引用无法恢复：${error instanceof Error ? error.message : String(error)}` }; }
      // 旧归档没有扩展段时从完整项目派生；新归档不允许裁剪已登记扩展的依赖。
      for (const definition of this.extensionArchiveDefinitions) {
        if (record.mediaReferences !== undefined && JSON.stringify(record.mediaReferences.filter(ref => ref.extensionId === definition.extensionId)) !==
          JSON.stringify(derived.filter(ref => ref.extensionId === definition.extensionId))) {
          return { ok: false, code: "invalid-shape", detail: `画布 ${record.canvasId} 扩展媒体引用清单不完整或不一致` };
        }
      }
      for (const asset of [...record.assets, ...(record.mediaReferences ?? []), ...derived]) {
        if (!asset.storageKey) continue;
        const exists = await storage.exists(asset.storageKey, scope);
        if (!exists) {
          return { ok: false, code: "missing-cos-object", detail: `缺失 COS 对象：${asset.storageKey}` };
        }
        if (typeof storage.stat === "function") {
          const stat = await storage.stat(asset.storageKey, scope);
          if (stat.size !== asset.size) {
            return {
              ok: false,
              code: "asset-metadata-mismatch",
              detail: `${asset.storageKey} size 不一致`
            };
          }
          if (stat.contentType && asset.contentType && stat.contentType !== asset.contentType) {
            return { ok: false, code: "asset-metadata-mismatch", detail: `${asset.storageKey} contentType 不一致` };
          }
        }
      }
    }
    return { ok: true, canvasCount: archive.canvases.length, operationCount: archive.operations.length, assetCount: 0 };
  }

  /**
   * 导入归档（任务 8.3 / 8.4 / 8.5）。
   *
   * 顺序：校验归档 → 收集目标冲突 → （dry-run 到此为止）→ 可选自动备份 → 逐个创建/替换。
   * 默认 no-overwrite；`replace` 时先备份原结构化画布，替换失败可恢复。
   */
  async importArchive(input: unknown, options: ImportOptions = {}): Promise<ImportResult> {
    const verification = await this.verifyArchive(input, { verifyMedia: options.verifyMedia });
    if (!verification.ok) {
      throw new CanvasStorageError(
        "INVALID_COMMAND_BATCH",
        `归档校验失败（${verification.code}）：${verification.detail}`
      );
    }
    const archive = input as CanvasArchive;

    // 目标冲突检查。
    const conflicts: string[] = [];
    for (const record of archive.canvases) {
      if (await this.repository.getCanvas(record.canvasId) ?? await this.publishedReader?.loadPublished(record.canvasId)) conflicts.push(record.canvasId);
    }
    if (conflicts.length > 0 && !options.replace) {
      throw new CanvasStorageError(
        "CANVAS_ALREADY_EXISTS",
        `目标已存在画布：${conflicts.join(", ")}；默认不覆盖，请显式启用 replace 或先删除`
      );
    }

    if (options.dryRun) {
      return { importedCanvasIds: [], replacedCanvasIds: [], skipped: true, dryRun: true };
    }

    // Preserve exact legacy aggregates as well as authoritative Yjs state before writing.
    const backups = new Map<string, ServerCanvas | null>();
    for (const record of archive.canvases) {
      backups.set(record.canvasId, await this.repository.getCanvas(record.canvasId));
    }
    const publication = await this.publication?.prepare(archive.canvases.map(record => record.canvasId));
    const touched = new Set<string>();

    const importedCanvasIds: string[] = [];
    const replacedCanvasIds: string[] = [];
    try {
      for (const record of archive.canvases) {
        touched.add(record.canvasId);
        const existing = await this.repository.getCanvas(record.canvasId);
        if (existing) {
          await this.repository.deleteCanvas(record.canvasId, existing.revision);
        }
        if (conflicts.includes(record.canvasId)) replacedCanvasIds.push(record.canvasId);
        await this.repository.createCanvas(toImportCanvas(record.canvas));
        const imported = await this.repository.getCanvas(record.canvasId);
        if (!imported) throw new CanvasStorageError("REPOSITORY_FAILURE", "导入画布未发布");
        await publication?.publish(imported);
        importedCanvasIds.push(record.canvasId);
      }
    } catch (error) {
      const failures: unknown[] = [];
      try { await publication?.rollback(); } catch (failure) { failures.push(failure); }
      for (const id of touched) {
        try {
          const original = backups.get(id);
          if (original) await this.repository.restoreCanvas(original);
          else {
            const created = await this.repository.getCanvas(id);
            if (created) await this.repository.deleteCanvas(id, created.revision);
          }
        } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], "归档导入失败且回滚未完成");
      throw error instanceof CanvasStorageError
        ? error
        : new CanvasStorageError("REPOSITORY_FAILURE", "导入失败");
    }

    return { importedCanvasIds, replacedCanvasIds, skipped: false, dryRun: false };
  }

  private async listAllCanvasIds(): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.repository.listCanvases({ offset, limit: 100 });
      ids.push(...page.items.map((item) => item.id));
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
      offset += page.items.length;
    }
    return ids;
  }

  private async listOperations(canvasId: string): Promise<ArchiveOperationRecord[]> {
    const operations = (this.repository as { listOperations?: (id: string) => Promise<ArchiveOperationRecord[]> }).listOperations;
    if (typeof operations === "function") return operations.call(this.repository, canvasId);
    return [];
  }
}

/**
 * 导入时归一化画布：重置 revision 为 0，让仓库创建为 revision 1 的全新记录。
 * 这样导入不依赖源库 revision，且不与目标既有 revision 冲突。
 */
function toImportCanvas(canvas: ServerCanvas): ServerCanvas {
  return {
    ...createEmptyWoohaa3ServerCanvas(canvas.id, canvas.updatedAt),
    ...canvas,
    revision: 0
  };
}

/** 默认 SHA-256（Web Crypto；Node 20+ 与浏览器都可用）。 */
async function defaultSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type { ArchiveAssetReference, CanvasArchive };
