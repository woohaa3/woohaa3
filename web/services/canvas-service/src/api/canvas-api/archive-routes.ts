/**
 * 画布归档 / 恢复路由。
 *
 * ```
 * GET  /api/canvases/:canvasId/archive            导出为 .woohaa-archive（八位字节流）
 * POST /api/canvases/archive                      从 .woohaa-archive 导入
 * ```
 *
 * 与 `CanvasArchiveService`（metadata-only 归档）的分工：
 * - 该服务负责**归档对象**的构造与校验（SHA-256 清单、no-overwrite、dry-run）；
 * - 本模块负责**包**：把归档对象与被引用的媒体字节打成一个 zip，以及反过来拆开。
 *
 * 「带着图片一起搬走」是用户对归档的实际期待。只有 JSON 的话，恢复回来的画布图片全是断链，
 * 那不算归档，只是丢了一份索引。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import { CanvasStorageError } from "../../storage/core/errors.js";
import { CanvasArchiveService } from "../../storage/core/archive-service.js";
import {
  MAX_PACKAGE_BYTES,
  findMissingMedia,
  readArchivePackage,
  writeArchivePackage
} from "../../storage/core/archive-package.js";
import { readBody, sendError, sendJson } from "./http-codec.js";
import type { CanvasLogger, CanvasRequestHandlerOptions } from "./types.js";

/** 导出/导入都走同一个上限；导入的整包上限与解包上限一致。 */
const MAX_IMPORT_BYTES = MAX_PACKAGE_BYTES;

type ArchiveDeps = {
  archive: Pick<CanvasArchiveService, "exportArchive" | "importArchive" | "verifyArchive">;
  mediaStorage?: MediaStorage;
};

/** 从 handler options 取归档依赖；未装配时返回 null（路由回 503）。 */
export function resolveArchiveDeps(options: CanvasRequestHandlerOptions): ArchiveDeps | null {
  const archive = options.archive;
  if (!archive) return null;
  return { archive, ...(options.mediaStorage ? { mediaStorage: options.mediaStorage } : {}) };
}

/**
 * 收集归档里引用到的、且确实存在的媒体字节。
 *
 * 缺失的键**不在这里报错**：导出语义是「先给我一份完整的」，缺件说明画布本身已经有断链，
 * 这不该让导出整个失败。缺件清单随响应头返回，由调用方决定怎么提示。
 */
async function collectMedia(
  archive: unknown,
  media: MediaStorage | undefined,
  scope: MediaStorageScope
): Promise<{ entries: Array<{ storageKey: string; bytes: Uint8Array }>; missing: string[] }> {
  const wanted = new Set<string>();
  const canvases = (archive as { canvases?: unknown }).canvases;
  if (Array.isArray(canvases)) {
    for (const record of canvases) {
      if (typeof record !== "object" || record === null) continue;
      const groups = [(record as { assets?: unknown }).assets, (record as { mediaReferences?: unknown }).mediaReferences];
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const item of group) {
          if (typeof item !== "object" || item === null) continue;
          const key = (item as { storageKey?: unknown }).storageKey;
          if (typeof key === "string" && key.length > 0) wanted.add(key);
        }
      }
    }
  }

  const entries: Array<{ storageKey: string; bytes: Uint8Array }> = [];
  const missing: string[] = [];
  for (const storageKey of [...wanted].sort()) {
    if (!media) {
      missing.push(storageKey);
      continue;
    }
    try {
      const object = await media.get(storageKey, scope);
      entries.push({ storageKey, bytes: object.bytes });
    } catch {
      // 画布上引用了、存储里却没有：记下来，不中断导出。
      missing.push(storageKey);
    }
  }
  return { entries, missing };
}

export async function handleArchiveExport(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const deps = resolveArchiveDeps(options);
  if (!deps) {
    sendError(res, 503, "REPOSITORY_FAILURE", "归档能力未装配");
    return true;
  }

  try {
    const archive = await deps.archive.exportArchive([canvasId]);
    const { entries, missing } = await collectMedia(archive, deps.mediaStorage, { canvasId });
    const bytes = writeArchivePackage(archive, entries);

    // 缺省文件名用画布标题（客户端的保存对话框可以改）。标题可能为空，退回 canvasId。
    const rawTitle = (archive.canvases[0]?.canvas as { title?: unknown } | undefined)?.title;
    const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle.trim() : canvasId;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    // 文件名按 RFC 5987 编码：标题常含中文，裸写进 header 会被截断或拒绝。
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(title)}.woohaa-archive`);
    res.setHeader("Content-Length", String(bytes.byteLength));
    // 缺件清单走响应头：正文是二进制包，不能混别的。
    res.setHeader("X-Woohaa-Archive-Missing-Media", String(missing.length));
    res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    log?.({ event: "canvas-archive-export", status: 200 });
    return true;
  } catch (error) {
    if (error instanceof CanvasStorageError) {
      const notFound = error.code === "CANVAS_NOT_FOUND";
      sendError(res, notFound ? 404 : 500, notFound ? "CANVAS_NOT_FOUND" : "REPOSITORY_FAILURE", error.message);
      log?.({ event: "canvas-archive-export-failed", status: notFound ? 404 : 500, code: error.code });
      return true;
    }
    throw error;
  }
}

export async function handleArchiveImport(
  req: IncomingMessage,
  res: ServerResponse,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const deps = resolveArchiveDeps(options);
  if (!deps) {
    sendError(res, 503, "REPOSITORY_FAILURE", "归档能力未装配");
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const dryRun = url.searchParams.get("dryRun") === "1";
  const replace = url.searchParams.get("replace") === "1";

  const body = await readBody(req, MAX_IMPORT_BYTES);
  if (body.byteLength === 0) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "缺少归档包");
    return true;
  }

  const unpacked = readArchivePackage(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (!unpacked.ok) {
    // 包本身坏了：这是客户端/文件的问题，不是仓库故障。
    sendError(res, 400, "INVALID_COMMAND_BATCH", `归档包无法读取（${unpacked.code}）：${unpacked.detail}`);
    log?.({ event: "canvas-archive-import-bad-package", status: 400, code: unpacked.code });
    return true;
  }

  // 媒体先落地：导入在「所有结构化记录与引用都通过」后才发布，这里顺序同理 ——
  // 先把字节写进去，再让归档服务写元数据，避免出现指向空对象的资产。
  const missing = findMissingMedia(unpacked.archive, unpacked.media);
  if (missing.length > 0 && !dryRun) {
    sendError(
      res,
      400,
      "INVALID_COMMAND_BATCH",
      `归档包缺少媒体文件：${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` 等 ${missing.length} 个` : ""}`
    );
    log?.({ event: "canvas-archive-import-missing-media", status: 400 });
    return true;
  }

  try {
    const result = await deps.archive.importArchive(unpacked.archive, { dryRun, replace });
    if (!dryRun && deps.mediaStorage) {
      for (const [storageKey, bytes] of unpacked.media) {
        const scope = inferScope(unpacked.archive, storageKey);
        await deps.mediaStorage.put(storageKey, bytes, contentTypeOf(unpacked.archive, storageKey), scope);
      }
    }
    sendJson(res, 200, {
      importedCanvasIds: result.importedCanvasIds,
      replacedCanvasIds: result.replacedCanvasIds,
      dryRun,
      mediaWritten: dryRun ? 0 : unpacked.media.size
    });
    log?.({ event: "canvas-archive-import", status: 200 });
    return true;
  } catch (error) {
    if (error instanceof CanvasStorageError) {
      const conflict = error.code === "CANVAS_ALREADY_EXISTS";
      sendError(res, conflict ? 409 : 400, error.code, error.message);
      log?.({ event: "canvas-archive-import-failed", status: conflict ? 409 : 400, code: error.code });
      return true;
    }
    throw error;
  }
}

/** 媒体写入要带画布作用域：托管存储按 `<canvasId>/...` 拼键。 */
function inferScope(archive: unknown, storageKey: string): MediaStorageScope | undefined {
  const canvases = (archive as { canvases?: unknown }).canvases;
  if (!Array.isArray(canvases)) return undefined;
  const keys = new Set<string>();
  for (const record of canvases) {
    if (typeof record !== "object" || record === null) continue;
    const groups = [(record as { assets?: unknown }).assets, (record as { mediaReferences?: unknown }).mediaReferences];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (typeof item !== "object" || item === null) continue;
        const key = (item as { storageKey?: unknown }).storageKey;
        if (key === storageKey && typeof (record as { canvasId?: unknown }).canvasId === "string") {
          keys.add((record as { canvasId: string }).canvasId);
        }
      }
    }
  }
  // 同一个键被多张画布引用时无法判定归属；此时交给后端按「与画布无关」处理。
  return keys.size === 1 ? { canvasId: [...keys][0]! } : undefined;
}

function contentTypeOf(archive: unknown, storageKey: string): string {
  const canvases = (archive as { canvases?: unknown }).canvases;
  if (!Array.isArray(canvases)) return "application/octet-stream";
  for (const record of canvases) {
    if (typeof record !== "object" || record === null) continue;
    const groups = [(record as { assets?: unknown }).assets, (record as { mediaReferences?: unknown }).mediaReferences];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (typeof item !== "object" || item === null) continue;
        const item_ = item as { storageKey?: unknown; contentType?: unknown };
        if (item_.storageKey === storageKey && typeof item_.contentType === "string" && item_.contentType) {
          return item_.contentType;
        }
      }
    }
  }
  return "application/octet-stream";
}
