/**
 * 首次打开准备（online canvas migration）前端契约
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1、5.4、5.5 / design D4、D5）。
 *
 * App scope 的受认证来源目录 + 准备态读模型。只消费平台契约 DTO，绝不接触旧 JSON/Y.Doc；
 * 未认证/无来源时不产生任何网络请求。prepare 是显式用户动作（POST），status 无副作用（GET）。
 */
import type {
  CanvasSourceCatalogEntry,
  CanvasSourceListPage,
  PreparationState,
  SourceCanvasSummary
} from "@woohaa3/contracts";

/** 来源目录 remote：浏览器访问 `/api/canvas-sources` 的唯一出口。 */
export interface CanvasPreparationRemote {
  /** 活动来源目录（受认证）。 */
  listSources(): Promise<{ ok: true; sources: CanvasSourceCatalogEntry[] } | { ok: false; code: string; error: string }>;
  /** 某来源下主体可访问的来源作品分页（受认证）。 */
  listAccessible(input: {
    sourceId: string;
    cursor: string | null;
    limit?: number;
  }): Promise<{ ok: true; page: CanvasSourceListPage } | { ok: false; code: string; error: string }>;
  /** 无创建副作用的准备态查询。 */
  status(canvasId: string): Promise<{ ok: true; state: PreparationState } | { ok: false; code: string; error: string; conflict?: boolean }>;
  /** 幂等触发在线迁移（显式用户动作）。 */
  prepare(input: {
    canvasId: string;
    sourceId?: string;
  }): Promise<{ ok: true; state: PreparationState } | { ok: false; code: string; error: string; status: number }>;
}

/** 单 owner 轮询的准备态视图（App scope；切换画布时创建独立实例）。 */
export type CanvasPreparationState = {
  status: "idle" | "loading" | "preparing" | "ready" | "failed" | "deleted";
  canvasId: string | null;
  jobId: string | null;
  phase: string | null;
  completedMedia: number;
  totalMedia: number;
  pollAfterMs: number;
  error: string | null;
  code: string | null;
  retryable: boolean;
  /** 已加载的来源目录（list 成功后）。 */
  sources: CanvasSourceCatalogEntry[];
};

export interface CanvasPreparationService {
  getState(): CanvasPreparationState;
  subscribe(listener: () => void): () => void;
  listSources(force?: boolean): Promise<void>;
  /** 某来源下主体可访问的来源作品分页（受认证；供切换器来源分区）。 */
  listAccessible(input: { sourceId: string; cursor: string | null; limit?: number }): Promise<{
    items: SourceCanvasSummary[];
    nextCursor: string | null;
  }>;
  /** 显式准备：POST prepare 并进入轮询（幂等）。 */
  prepare(input: { canvasId: string; sourceId?: string }): Promise<void>;
  /**
   * 观察一个 canvasId 的准备态：先 GET status，未 ready 时按 pollAfterMs 轮询。
   * 传入 generation/AbortSignal 以隔离迟到响应；dispose/切换后不再发布。
   */
  observe(input: { canvasId: string; signal?: AbortSignal }): Promise<PreparationState>;
  dispose(): void;
}
