/**
 * Canvas Catalog Service 契约（App scope）
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 2.1 / design D2）。
 *
 * App scope 唯一的画布目录读模型：分页列出、按 ID 读取、创建、缓存失效与请求去旧结果。
 * 它**不**创建 Canvas Session、Yjs socket、Bevy runtime、selection 或 page feature。
 */
import type { CanvasDetailSummary, CanvasSummary } from "@woohaa3/contracts";

export type { CanvasSummary, CanvasDetailSummary };

/** 目录 store 的原子 snapshot。 */
export type CanvasCatalogState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: CanvasSummary[];
  total: number;
  offset: number;
  limit: number;
  loadingMore: boolean;
  error: string | null;
};

export type CanvasCatalogListResult =
  | { ok: true; entries: CanvasSummary[]; total: number; offset: number; limit: number }
  | { ok: false; code: string; error: string };

export type CanvasCatalogSummaryResult =
  | { ok: true; summary: CanvasDetailSummary }
  | { ok: false; code: string; error: string };

export type CanvasCatalogCreateResult =
  | { ok: true; canvasId: string; revision: number; title: string }
  | { ok: false; code: string; error: string };

/** Catalog 远端 adapter：所有目录 HTTP 协议的唯一浏览器出口。 */
export interface CanvasCatalogRemote {
  list(input: { offset: number; limit: number }): Promise<CanvasCatalogListResult>;
  get(canvasId: string): Promise<CanvasCatalogSummaryResult>;
  create(input: { canvasId?: string; title?: string }): Promise<CanvasCatalogCreateResult>;
}

export interface CanvasCatalogService {
  getState(): CanvasCatalogState;
  subscribe(listener: () => void): () => void;
  /** 加载第一页（默认缓存命中直接返回；force 强制刷新）。 */
  load(force?: boolean): Promise<CanvasCatalogListResult>;
  /** 追加下一页。 */
  loadMore(): Promise<void>;
  /** 创建画布，成功后失效并刷新目录。 */
  create(input?: { title?: string }): Promise<CanvasCatalogCreateResult>;
  /** 按 ID 读取摘要（用于校验显式 canvasId 是否存在/展示当前标题）。 */
  get(canvasId: string): Promise<CanvasCatalogSummaryResult>;
  /** 失效缓存，使下一次 `load()` 重新请求。 */
  invalidate(): void;
  dispose(): void;
}

/** 最近画布选择（本地持久化，用于缺省 location 解析）。 */
export interface CanvasSelectionService {
  getRecentCanvasId(): string | null;
  setRecentCanvasId(canvasId: string | null): void;
}

/**
 * 显式 canvasId 不存在（或目录解析失败）时的恢复入口状态
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.5）。
 *
 * 只由 Canvas recovery page scope 提供：该 scope **不**创建 Canvas Session/socket/Bevy，
 * 仅展示稳定错误与「选择/创建画布」动作。
 */
export type CanvasRecoveryService = {
  /** 用户显式请求但不存在/解析失败的 canvasId；目录解析失败时为 null。 */
  canvasId: string | null;
  code: string;
  error: string;
};
