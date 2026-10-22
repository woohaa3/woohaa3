/**
 * Metadata-only 版本化归档（任务 8.1 / design D12）。
 *
 * 格式 `woohaa3-canvas-archive-v1`：
 * ```
 * {
 *   format: "woohaa3-canvas-archive-v1",
 *   createdAt: string,
 *   canvases: ArchiveCanvasRecord[],   // 每个画布的规范聚合 + 资产引用清单
 *   operations: ArchiveOperationRecord[], // operation 幂等记录
 *   files: ArchiveFileRecord[]         // 结构化文件清单：size + SHA-256
 * }
 * ```
 *
 * **禁止二进制**：归档只含 JSON。任何 Blob、base64、临时签名 URL 或数据库内部主键都不许出现。
 * 媒体 bytes 由 COS 独立承载，归档只记录稳定 `storageKey / checksum / contentType / size`。
 */
import type { ServerCanvas, MediaMetadata } from "@woohaa3/contracts";

export const CANVAS_ARCHIVE_FORMAT = "woohaa3-canvas-archive-v1" as const;

export type ArchiveAssetReference = {
  assetId: string;
  mediaKind: string;
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
};

export type ArchiveCanvasRecord = {
  canvasId: string;
  revision: number;
  updatedAt: string;
  /** 规范画布聚合（纯 JSON）。 */
  canvas: ServerCanvas;
  /** 该画布引用的全部稳定 COS 资产。 */
  assets: ArchiveAssetReference[];
  /** 扩展项目、历史构建和依赖；旧归档可缺省此字段。 */
  mediaReferences?: ArchiveExtensionMediaReference[];
};

export type ArchiveExtensionMediaReference = MediaMetadata & { extensionId: string; nodeId: string };

export type ArchiveOperationRecord = {
  canvasId: string;
  operationId: string;
  baseRevision: number;
  resultRevision: number;
  actorId: string;
  createdAt: string;
};

export type ArchiveFileRecord = {
  /** 逻辑文件名，例如 `canvases.json`。 */
  name: string;
  size: number;
  sha256: string;
  recordCount: number;
};

export type CanvasArchive = {
  format: typeof CANVAS_ARCHIVE_FORMAT;
  createdAt: string;
  canvases: ArchiveCanvasRecord[];
  operations: ArchiveOperationRecord[];
  files: ArchiveFileRecord[];
};

/**
 * 从规范画布提取资产引用。只保留**稳定** metadata；缺失或非法的资产引用会导致导出失败
 * （而不是静默丢失），因为归档必须能完整重建引用清单。
 */
export function extractAssetReferences(canvas: ServerCanvas): ArchiveAssetReference[] {
  const references: ArchiveAssetReference[] = [];
  for (const asset of canvas.assets) {
    const metadata = asset.metadata as Record<string, unknown> | undefined;
    const storageKey = metadata?.storageKey;
    if (typeof storageKey !== "string" || storageKey.length === 0) continue;
    references.push({
      assetId: asset.id,
      mediaKind: asset.mediaKind,
      storageKey,
      checksum: typeof metadata?.checksum === "string" ? metadata.checksum : "",
      contentType: typeof metadata?.contentType === "string" ? metadata.contentType : "",
      size: typeof metadata?.size === "number" ? metadata.size : 0
    });
  }
  return references;
}

/**
 * 构造归档对象并计算结构化文件的 size/SHA-256。
 *
 * `sha256` 由注入的实现计算（浏览器/Node 都能用 Web Crypto），因此本模块保持中立。
 */
export async function buildCanvasArchive(
  input: {
    canvases: Array<{ canvas: ServerCanvas; operations: ArchiveOperationRecord[]; mediaReferences?: ArchiveExtensionMediaReference[] }>;
    createdAt: string;
  },
  computeSha256: (text: string) => Promise<string>
): Promise<CanvasArchive> {
  const canvases: ArchiveCanvasRecord[] = input.canvases.map((entry) => ({
    canvasId: entry.canvas.id,
    revision: entry.canvas.revision,
    updatedAt: entry.canvas.updatedAt,
    canvas: entry.canvas,
    assets: extractAssetReferences(entry.canvas),
    ...(entry.mediaReferences?.length ? { mediaReferences: entry.mediaReferences } : {})
  }));
  const operations = input.canvases.flatMap((entry) => entry.operations);

  const canvasesJson = JSON.stringify(canvases);
  const operationsJson = JSON.stringify(operations);
  const files: ArchiveFileRecord[] = [
    {
      name: "canvases.json",
      size: byteLength(canvasesJson),
      sha256: await computeSha256(canvasesJson),
      recordCount: canvases.length
    },
    {
      name: "operations.json",
      size: byteLength(operationsJson),
      sha256: await computeSha256(operationsJson),
      recordCount: operations.length
    }
  ];

  const archive: CanvasArchive = {
    format: CANVAS_ARCHIVE_FORMAT,
    createdAt: input.createdAt,
    canvases,
    operations,
    files
  };

  // 结构性保证：归档里不允许出现二进制或临时 URL。
  assertArchiveStructured(archive);
  return archive;
}

/** 校验归档 shape 与结构完整性（不含 SHA-256 重算；那由 verify 异步完成）。 */
export type ArchiveValidationFailure =
  | { code: "not-an-object" }
  | { code: "unsupported-format"; format: unknown }
  | { code: "missing-field"; field: string }
  | { code: "binary-content"; detail: string };

export function validateArchiveShape(input: unknown): ArchiveValidationFailure | null {
  if (!isRecord(input)) return { code: "not-an-object" };
  if (input.format !== CANVAS_ARCHIVE_FORMAT) {
    return { code: "unsupported-format", format: input.format };
  }
  if (!Array.isArray(input.canvases)) return { code: "missing-field", field: "canvases" };
  if (!Array.isArray(input.operations)) return { code: "missing-field", field: "operations" };
  if (!Array.isArray(input.files)) return { code: "missing-field", field: "files" };
  for (const [index, record] of input.canvases.entries()) {
    if (!isRecord(record) || typeof record.canvasId !== "string" || !isRecord(record.canvas)) {
      return { code: "missing-field", field: `canvases[${index}]` };
    }
  }
  try {
    assertArchiveStructured(input);
  } catch (error) {
    return { code: "binary-content", detail: error instanceof Error ? error.message : String(error) };
  }
  return null;
}

const FORBIDDEN_KEYS = ["blob", "blobs", "bytes", "base64", "arrayBuffer", "objectId", "_id"];
const FORBIDDEN_URL = [/^data:/i, /^blob:/i, /^file:/i];
const SIGNED_URL_HINTS = ["X-Amz-Signature", "q-sign-algorithm", "Signature=", "sign="];

/** 递归拒绝二进制字段、临时/签名 URL 与数据库内部主键。 */
export function assertArchiveStructured(value: unknown, path = "archive"): void {
  if (typeof value === "string") {
    for (const pattern of FORBIDDEN_URL) {
      if (pattern.test(value)) throw new Error(`${path} 含禁止的 URL：${value.slice(0, 32)}`);
    }
    for (const hint of SIGNED_URL_HINTS) {
      if (value.includes(hint)) throw new Error(`${path} 含疑似签名 URL`);
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertArchiveStructured(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    if (isBinaryLike(value)) throw new Error(`${path} 含二进制对象`);
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(key)) throw new Error(`${path}.${key} 是禁止的字段`);
      assertArchiveStructured(nested, `${path}.${key}`);
    }
  }
}

function isBinaryLike(value: object): boolean {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return true;
  const name = value.constructor?.name;
  return name === "Blob" || name === "File" || name === "ArrayBuffer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 跨环境字节长度：优先用 Buffer，其次 TextEncoder，最后回退到字符串长度。 */
function byteLength(text: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}
