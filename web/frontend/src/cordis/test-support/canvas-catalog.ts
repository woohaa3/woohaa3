/**
 * 测试用 Canvas Catalog remote
 * （change: 2026-09-29-add-multi-canvas-workspace）。
 *
 * 内存实现：默认目录含单个画布，可编程 list/create/get，用于 page-scope / app-host 测试。
 */
import type { CanvasSummary } from "@woohaa3/contracts";
import type {
  CanvasArchiveExportResult,
  CanvasArchiveImportResult,
  CanvasCatalogCreateResult,
  CanvasCatalogDeleteResult,
  CanvasCatalogListResult,
  CanvasCatalogRemote,
  CanvasCatalogSummaryResult
} from "../contract/canvas-catalog.js";

const NOW = "2026-09-29T00:00:00.000Z";

export function makeSummary(id: string, title = id): CanvasSummary {
  return { id, title, revision: 1, updatedAt: NOW, createdAt: NOW, nodeCount: 0, assetCount: 0 };
}

export type FakeCanvasCatalogRemote = CanvasCatalogRemote & {
  entries: Map<string, CanvasSummary>;
  created: string[];
};

export function createFakeCanvasCatalogRemote(
  initial: CanvasSummary[] = [makeSummary("woohaa3-default-canvas")]
): FakeCanvasCatalogRemote {
  const entries = new Map(initial.map((entry) => [entry.id, entry]));
  const created: string[] = [];
  let seq = 0;
  const remote: FakeCanvasCatalogRemote = {
    entries,
    created,
    async list(input): Promise<CanvasCatalogListResult> {
      const all = [...entries.values()];
      const page = all.slice(input.offset, input.offset + input.limit);
      return { ok: true, entries: page, total: all.length, offset: input.offset, limit: input.limit };
    },
    async get(canvasId): Promise<CanvasCatalogSummaryResult> {
      const entry = entries.get(canvasId);
      if (!entry) return { ok: false, code: "CANVAS_NOT_FOUND", error: `画布 ${canvasId} 不存在` };
      const { createdAt, ...rest } = entry;
      void createdAt;
      return { ok: true, summary: rest };
    },
    async create(input): Promise<CanvasCatalogCreateResult> {
      seq += 1;
      const canvasId = input.canvasId ?? `canvas-new-${seq}`;
      const entry = makeSummary(canvasId, input.title ?? "");
      entries.set(canvasId, entry);
      created.push(canvasId);
      return { ok: true, canvasId, revision: 1, title: entry.title };
    },
    async delete(canvasId, expectedRevision): Promise<CanvasCatalogDeleteResult> {
      const entry = entries.get(canvasId);
      if (!entry) return { ok: false, code: "CANVAS_NOT_FOUND", error: `画布 ${canvasId} 不存在` };
      if (entry.revision !== expectedRevision) {
        return { ok: false, code: "REVISION_CONFLICT", error: "画布 revision 已变化" };
      }
      entries.delete(canvasId);
      return { ok: true };
    },
    // 归档不是本 fake 的关注点：返回空包 / 空结果，够调用方跑通即可。
    async exportArchive(canvasId): Promise<CanvasArchiveExportResult> {
      if (!entries.has(canvasId)) return { ok: false, code: "CANVAS_NOT_FOUND", error: `画布 ${canvasId} 不存在` };
      return { ok: true, bytes: new Uint8Array(), filename: `${canvasId}.woohaa-archive`, missingMedia: 0 };
    },
    async importArchive(): Promise<CanvasArchiveImportResult> {
      return { ok: true, importedCanvasIds: [], replacedCanvasIds: [], mediaWritten: 0 };
    }
  };
  return remote;
}
