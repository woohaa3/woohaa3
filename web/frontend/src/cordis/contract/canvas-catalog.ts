/**
 * Canvas Catalog Service 契约（类型 re-export）
 *
 * 契约定义已上移到 `@woohaa3/contracts`（`extension/services/frontend/`）：前端 Cordis 根的服务
 * 契约由 contracts 定义，`web/frontend` 实现并经 Context 增强暴露。本文件只做 re-export，
 * 保持前端内部与扩展的既有 import 路径不变。
 */
export type {
  CanvasSummary,
  CanvasDetailSummary,
  CanvasCatalogState,
  CanvasCatalogListResult,
  CanvasCatalogSummaryResult,
  CanvasCatalogCreateResult,
  CanvasArchiveExportResult,
  CanvasArchiveImportResult,
  CanvasCatalogRemote,
  CanvasCatalogService,
  CanvasSelectionService,
  CanvasRecoveryService
} from "@woohaa3/contracts";
