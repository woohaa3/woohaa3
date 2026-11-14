/**
 * 外部画布来源契约（change: 2026-10-12-add-extension-online-canvas-migration，任务 1.1 / design D3、D4）。
 *
 * 平台通用、**与具体旧 provider 无关**的来源 DTO：来源引用、版本绑定、标准化目标 ACL、
 * 转换候选与有界诊断、来源摘要。这里不含任何旧 Mongo/旧 SQLite/旧 Y.Doc/驱动类型，
 * 也不含目标数据库形状；来源格式知识留在来源扩展内部。
 *
 * 版本语义（design D3）各自单一职责，**不得混用**：
 * - `sourceId`：稳定区分部署的来源身份；
 * - `cutoverGeneration`：管理员登记的切换代次（来源冻结代次）；
 * - `configVersion`：来源扩展不可变配置版本；
 * - `converterVersion`：转换算法版本；
 * - `sourceVersion`：来源内部生成的稳定不透明水位（CRDT sequence/ACL version/快照指纹）。
 * 四者都**不能**替代目标 revision 或 roomEpoch。
 */
import {
  isBoundedId,
  isJsonObject,
  isNonNegativeInteger,
  isStringArray
} from "../validation.js";

/** 来源能力命名空间前缀：`canvas-source:<sourceId>`。 */
export const CANVAS_SOURCE_CAPABILITY_PREFIX = "canvas-source:" as const;

/**
 * `canvas-source:<sourceId>` capability 的形状版本
 * （change: 2026-11-13-add-extension-capability-abi）。
 *
 * 提供者按此版本注册、Application 按此版本解析；`CanvasSourceProvider` 的成员或语义变化时抬高。
 */
export const CANVAS_SOURCE_CAPABILITY_VERSION = 1;

export function canvasSourceCapabilityId(sourceId: string): string {
  return `${CANVAS_SOURCE_CAPABILITY_PREFIX}${sourceId}`;
}

export function isCanvasSourceCapabilityId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CANVAS_SOURCE_CAPABILITY_PREFIX);
}

export function canvasSourceIdFromCapabilityId(value: string): string {
  return value.slice(CANVAS_SOURCE_CAPABILITY_PREFIX.length);
}

/** 来源作品引用：来源身份 + 旧作品 ID + 切换代次。 */
export type CanvasSourceRef = {
  sourceId: string;
  sourceCanvasId: string;
  cutoverGeneration: string;
};

/**
 * 版本绑定：一次导入所固定的（来源、扩展、配置、转换器、源水位）。
 *
 * 重试/重启必须复用同一绑定；配置升级或来源换代产生新绑定，不得让在途作业中途切换。
 */
export type CanvasSourceBinding = CanvasSourceRef & {
  extensionId: string;
  configVersion: number;
  converterVersion: string;
  /** 来源内部生成的稳定不透明水位；不得解释为目标 revision。 */
  sourceVersion: string;
};

/** 媒体处理模式：同源复用（verify）或跨源复制（bytes → Media write）。 */
export const CANVAS_SOURCE_MEDIA_MODES = ["reuse", "copy"] as const;
export type CanvasSourceMediaMode = (typeof CANVAS_SOURCE_MEDIA_MODES)[number];

/** 标准化目标 ACL 候选；由来源扩展按可信身份映射生成，绝不接受调用者自报。 */
export type ImportedCanvasAccess = {
  /** 目标 owner 的 subject；必须是来源 creator 的可信映射，不得是首次访问者。 */
  ownerSubject: string;
  readSubjects: string[];
  writeSubjects: string[];
  sharingMode: "private" | "specified" | "everyone_view" | "everyone_edit";
  /** 生成该 ACL 时的来源权限版本（opaque）。 */
  sourceAclVersion: string;
};

export type CanvasImportDiagnosticKind =
  | "unmapped-model"
  | "discarded-field"
  | "failed-asset"
  | "unsupported-node"
  | "note";

export type CanvasImportDiagnosticEntry = {
  kind: CanvasImportDiagnosticKind;
  nodeId?: string;
  assetId?: string;
  /** 有界标题（可能来自旧创作数据）；只在授权后按需读取，status 不返回。 */
  title?: string;
  status?: string;
  detail?: string;
};

/** 有界转换/媒体诊断；区分已保全成功资产、可恢复历史与未恢复记录。 */
export type CanvasImportDiagnostics = {
  entries: CanvasImportDiagnosticEntry[];
  readyMediaCount: number;
  restoredHistoryCount: number;
  /** 未恢复（failed/generating 且无 bytes）记录数；不是“已恢复图片”。 */
  unrecoveredRecordCount: number;
};

export const CANVAS_IMPORT_DIAGNOSTICS_LIMITS = {
  maxEntries: 2_048,
  maxTitleLength: 200,
  maxDetailLength: 500
} as const;

/** 来源作品摘要（目录条目）；不含正文/媒体/凭据。 */
export type SourceCanvasSummary = {
  ref: CanvasSourceRef;
  targetCanvasId: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
  availability: "not-prepared" | "preparing" | "ready";
};

/** `/api/canvas-sources` 的活动来源目录条目摘要；不含路径、URI、数据库名。 */
export type CanvasSourceCatalogEntry = {
  sourceId: string;
  displayName: string;
  availability: "available" | "unavailable";
};

/** 来源目录稳定 cursor 分页。 */
export type CanvasSourceListPage = {
  items: SourceCanvasSummary[];
  nextCursor: string | null;
};

export const DEFAULT_CANVAS_SOURCE_PAGE_SIZE = 20;
export const MAX_CANVAS_SOURCE_PAGE_SIZE = 100;

/**
 * 外部导入边界错误码（design D5）。
 *
 * `UNAUTHENTICATED`/`FORBIDDEN` 用于权限；`SOURCE_UNAVAILABLE`/`SOURCE_CHANGED`/
 * `SOURCE_AMBIGUOUS` 用于来源；`UNSUPPORTED_SOURCE_FORMAT`/`CANDIDATE_INVALID` 用于转换；
 * `TARGET_CONFLICT`/`MEDIA_MISSING`/`LIMIT_EXCEEDED`/`PREPARATION_REQUIRED`/`DELETED`
 * 用于目标与流程。底层错误必须先分类/脱敏。
 */
export const CANVAS_IMPORT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SOURCE_UNAVAILABLE",
  "SOURCE_CHANGED",
  "SOURCE_AMBIGUOUS",
  "UNSUPPORTED_SOURCE_FORMAT",
  "TARGET_CONFLICT",
  "MEDIA_MISSING",
  "CANDIDATE_INVALID",
  "LIMIT_EXCEEDED",
  "PREPARATION_REQUIRED",
  "DELETED"
] as const;

export type CanvasImportErrorCode = (typeof CANVAS_IMPORT_ERROR_CODES)[number];

export function isCanvasImportErrorCode(value: unknown): value is CanvasImportErrorCode {
  return typeof value === "string" && (CANVAS_IMPORT_ERROR_CODES as readonly string[]).includes(value);
}

export function isCanvasSourceRef(value: unknown): value is CanvasSourceRef {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.sourceId, 120) &&
    isBoundedId(value.sourceCanvasId, 200) &&
    isBoundedId(value.cutoverGeneration, 120)
  );
}

export function isCanvasSourceBinding(value: unknown): value is CanvasSourceBinding {
  if (!isCanvasSourceRef(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedId(record.extensionId, 120) &&
    isNonNegativeInteger(record.configVersion) &&
    isBoundedId(record.converterVersion, 120) &&
    isBoundedId(record.sourceVersion, 300)
  );
}

export function isCanvasSourceCatalogEntry(value: unknown): value is CanvasSourceCatalogEntry {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.sourceId, 120) &&
    typeof value.displayName === "string" &&
    value.displayName.length <= 200 &&
    (value.availability === "available" || value.availability === "unavailable")
  );
}

export function isImportedCanvasAccess(value: unknown): value is ImportedCanvasAccess {
  if (!isJsonObject(value)) return false;
  const mode = value.sharingMode;
  return (
    isBoundedId(value.ownerSubject, 200) &&
    isStringArray(value.readSubjects) &&
    isStringArray(value.writeSubjects) &&
    (mode === "private" || mode === "specified" || mode === "everyone_view" || mode === "everyone_edit") &&
    isBoundedId(value.sourceAclVersion, 300)
  );
}

function isDiagnosticEntry(value: unknown): value is CanvasImportDiagnosticEntry {
  if (!isJsonObject(value)) return false;
  const kind = value.kind;
  if (
    kind !== "unmapped-model" &&
    kind !== "discarded-field" &&
    kind !== "failed-asset" &&
    kind !== "unsupported-node" &&
    kind !== "note"
  ) {
    return false;
  }
  const bounded = (input: unknown, max: number): boolean =>
    input === undefined || (typeof input === "string" && input.length <= max);
  return (
    bounded(value.nodeId, 200) &&
    bounded(value.assetId, 200) &&
    bounded(value.title, CANVAS_IMPORT_DIAGNOSTICS_LIMITS.maxTitleLength) &&
    bounded(value.status, 64) &&
    bounded(value.detail, CANVAS_IMPORT_DIAGNOSTICS_LIMITS.maxDetailLength)
  );
}

export function isCanvasImportDiagnostics(value: unknown): value is CanvasImportDiagnostics {
  if (!isJsonObject(value)) return false;
  if (!Array.isArray(value.entries)) return false;
  if (value.entries.length > CANVAS_IMPORT_DIAGNOSTICS_LIMITS.maxEntries) return false;
  if (!value.entries.every(isDiagnosticEntry)) return false;
  return (
    isNonNegativeInteger(value.readyMediaCount) &&
    isNonNegativeInteger(value.restoredHistoryCount) &&
    isNonNegativeInteger(value.unrecoveredRecordCount)
  );
}

export function isSourceCanvasSummary(value: unknown): value is SourceCanvasSummary {
  if (!isJsonObject(value)) return false;
  const availability = value.availability;
  return (
    isCanvasSourceRef(value.ref) &&
    isBoundedId(value.targetCanvasId, 200) &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "string" &&
    isNonNegativeInteger(value.nodeCount) &&
    (availability === "not-prepared" || availability === "preparing" || availability === "ready")
  );
}

export function decodeCanvasSourceListPage(
  value: unknown
): { ok: true; page: CanvasSourceListPage } | { ok: false; error: string } {
  if (!isJsonObject(value)) return { ok: false, error: "来源目录响应必须是对象" };
  if (!Array.isArray(value.items) || !value.items.every(isSourceCanvasSummary)) {
    return { ok: false, error: "来源目录条目形态非法" };
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    return { ok: false, error: "来源目录 nextCursor 非法" };
  }
  return { ok: true, page: { items: value.items as SourceCanvasSummary[], nextCursor: value.nextCursor as string | null } };
}

export function normalizeCanvasSourceListQuery(query: { cursor?: string | null; limit?: number | null }): {
  cursor: string | null;
  limit: number;
} {
  const rawLimit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.floor(query.limit) : DEFAULT_CANVAS_SOURCE_PAGE_SIZE;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_CANVAS_SOURCE_PAGE_SIZE);
  const cursor = typeof query.cursor === "string" && query.cursor.length > 0 && query.cursor.length <= 512 ? query.cursor : null;
  return { cursor, limit };
}
