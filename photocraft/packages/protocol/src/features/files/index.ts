/**
 * 文档创建、来源与关闭结算的本域协议声明
 * （change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 只追加本域真正落地的**数据契约**：能力 id 仍由共享集成维护（`tests/fixtures/contract.json`），
 * 这里不放宽任何命令门。
 */
export const feature = {
  id: "files",
  capabilities: [
  ]
} as const;

export {
  NEW_DOCUMENT_DEPTHS,
  NEW_DOCUMENT_LIMITS,
  NEW_DOCUMENT_MODES,
  SIZE_PRESETS,
  canReplayDocumentSpec,
  normalizePresetName,
  validateNewDocumentSpec
} from "./document-spec.js";
export type {
  DocumentPreset,
  NewDocumentBackground,
  NewDocumentSpec,
  NewDocumentSpecResult,
  SizePreset
} from "./document-spec.js";

export {
  FILE_INFO_COPYRIGHT_STATES,
  FILE_INFO_FIELDS,
  FILE_INFO_FORMATS,
  FILE_INFO_FORMAT_SUPPORT,
  FILE_INFO_LIMITS,
  describeFileInfoLoss,
  fileInfoFormatOf,
  validateFileInfoPatch
} from "./metadata.js";
export type {
  FileInfo,
  FileInfoCamera,
  FileInfoField,
  FileInfoFormat,
  FileInfoLoss,
  FileInfoPatchResult
} from "./metadata.js";

export {
  DOCUMENT_PRESET_STORE_VERSION,
  addDocumentPreset,
  canReopenRecent,
  createLocalDocumentPresetStorage,
  decodeDocumentPresetStore,
  emptyDocumentPresetStore,
  encodeDocumentPresetStore,
  parseDocumentPresetStore,
  recordRecentDocument,
  removeDocumentPreset
} from "./presets.js";
export type { DecodePresetStoreResult, DocumentPresetStorage, DocumentPresetStore } from "./presets.js";

export {
  planCloseAll,
  planCloseOthers,
  requestDocumentSlot,
  runClosePlan
} from "./close-plan.js";
export type { CloseFailure, CloseOutcome, ClosePlan, CloseStep, CloseTarget } from "./close-plan.js";

export {
  MAX_RECENT_FILES,
  MAX_RECENT_FILE_BYTES,
  MAX_RECENT_TOTAL_BYTES,
  RECENT_FILE_STORE_VERSION,
  decodeRecentFileStore,
  emptyRecentFileStore,
  encodeRecentFileStore,
  heldBytesAfterSave,
  parseRecentFileStore,
  planReopenRecent,
  recordRecentFile,
  removeRecentFile,
  reopenRecentLabel
} from "./recent-files.js";
export type {
  DecodeRecentFileStoreResult,
  RecentFileEntry,
  RecentFileStore,
  ReopenRecentResult
} from "./recent-files.js";
