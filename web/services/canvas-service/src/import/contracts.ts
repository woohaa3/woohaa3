/**
 * 画布导入（在线迁移）内部契约与类型
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.1、4.3 / design D6、D9）。
 *
 * 这是 Canvas 权威侧对来源能力的**窄端口**：不 import 来源扩展，只消费平台契约 DTO。
 * 作业/收据/ACL/诊断持久化与「整画布单连接原子提交」由 SQLite adapter 实现。
 */
import type {
  CanvasImportCandidate,
  CanvasImportErrorCode,
  CanvasSourceBinding,
  CanvasSourceCatalogEntry,
  CanvasSourceListPage,
  ImportedCanvasAccess
} from "@woohaa3/contracts";

/** 导入作业状态。 */
export const CANVAS_IMPORT_JOB_STATES = [
  "pending",
  "running",
  "committed",
  "failed",
  "superseded"
] as const;
export type CanvasImportJobState = (typeof CANVAS_IMPORT_JOB_STATES)[number];

/** 持久作业记录：同来源幂等、attempt fencing、重启恢复依据。 */
export type CanvasImportJobRecord = {
  jobId: string;
  targetCanvasId: string;
  binding: CanvasSourceBinding;
  /** 主体（发起/恢复准备的事实来源）。 */
  subject: string;
  state: CanvasImportJobState;
  phase: string;
  attempt: number;
  /** 当前有效 attempt token；旧 attempt 的提交被拒绝（fencing）。 */
  fence: number;
  completedMedia: number;
  totalMedia: number;
  errorCode?: string;
  errorRetryable?: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 来源访问解析结果。
 *
 * `handle` 携带版本绑定；Canvas 不缓存、不解释它，只在同一次流程内透传。
 */
export type CanvasSourceAccessHandle = {
  binding: Omit<CanvasSourceBinding, "sourceVersion">;
  sourceVersion: string;
  targetCanvasId: string;
  title: string;
};

export type CanvasSourcePort = {
  /** 活动来源目录（不含路径/URI）。 */
  listSources(): Promise<CanvasSourceCatalogEntry[]>;
  /** 按来源列出可访问作品；主体由宿主认证注入。 */
  listAccessible(input: { subject: string; sourceId: string; cursor: string | null; limit: number }): Promise<CanvasSourceListPage>;
  /**
   * 解析一个具体来源画布（含 ACL 校验）；主体无读权限或来源不可用返回错误。
   * `sourceId` 省略时在多个来源中唯一解析，命中多个返回 `SOURCE_AMBIGUOUS`。
   */
  resolveAccessible(input: { subject: string; sourceCanvasId: string; sourceId?: string }): Promise<
    { ok: true; handle: CanvasSourceAccessHandle } | { ok: false; code: CanvasImportErrorCode; message: string }
  >;
  /** 在版本绑定 handle 上生成当前格式候选。 */
  prepareCandidate(input: { subject: string; handle: CanvasSourceAccessHandle }): Promise<
    { ok: true; candidate: CanvasImportCandidate } | { ok: false; code: CanvasImportErrorCode; retryable: boolean; message: string }
  >;
  /** 提交前再验来源冻结/水位/权限版本。 */
  validateSnapshot(input: { subject: string; binding: CanvasSourceBinding }): Promise<
    { ok: true } | { ok: false; code: CanvasImportErrorCode; retryable: boolean; message: string }
  >;
};

export type CanvasImportDiagnosticSummary = {
  readyMediaCount: number;
  restoredHistoryCount: number;
  unrecoveredRecordCount: number;
};

export type CanvasImportReceipt = {
  targetCanvasId: string;
  binding: CanvasSourceBinding;
  ownerSubject: string;
  sharingMode: ImportedCanvasAccess["sharingMode"];
  diagnostics: CanvasImportDiagnosticSummary;
  committedAt: string;
};

export type {
  CanvasImportCandidate,
  CanvasImportErrorCode,
  CanvasSourceBinding,
  ImportedCanvasAccess
};
