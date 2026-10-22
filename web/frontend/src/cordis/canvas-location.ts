/**
 * Canvas location 解析
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.4 / 3.5 / design D1）。
 *
 * 纯编排（无 React/DOM）：把一次 Canvas `AppPageLocation` 解析为可打开的 canvasId、显式
 * not-found 或目录错误。缺省 ID 的解析顺序为「最近有效画布 → 目录第一项 → 空目录幂等创建」。
 */
import type { AppPageLocation } from "./navigation/app-router.js";
import type { CanvasCatalogService, CanvasSelectionService } from "./contract/canvas-catalog.js";
import type { CanvasPreparationService } from "./contract/canvas-preparation.js";

export type CanvasResolution =
  | { kind: "resolved"; canvasId: string; created: boolean }
  | { kind: "not-found"; canvasId: string; error: string }
  /** 显式旧 ID：来源仍在转换；由调用方展示准备态并在 ready 后重解析（不创建默认画布）。 */
  | { kind: "preparing"; canvasId: string; jobId: string | null }
  | { kind: "error"; error: string };

export async function resolveCanvasLocation(input: {
  location: AppPageLocation;
  catalog: CanvasCatalogService;
  selection: CanvasSelectionService;
  /** 隐式缺省解析且目录不可用时回退的画布（兼容既有默认画布行为）。 */
  fallbackCanvasId?: string;
  /**
   * 在线迁移准备（change: 2026-10-12-add-extension-online-canvas-migration）。
   *
   * 显式 canvasId 在目标中不存在时，若来源目录非空则触发一次受认证 `prepare`：
   * - ready → 直接打开；
   * - preparing → 返回准备态（调用方轮询，不跳默认画布）；
   * - deleted/failed/无来源 → 维持显式 not-found（不创建默认画布）。
   */
  preparation?: CanvasPreparationService;
}): Promise<CanvasResolution> {
  const { location, catalog, selection } = input;

  // 显式 canvasId：只校验该 ID，不存在时不静默回退其它画布（design D1）。
  if (location.canvasId) {
    const result = await catalog.get(location.canvasId);
    if (result.ok) return { kind: "resolved", canvasId: location.canvasId, created: false };
    if (result.code === "CANVAS_NOT_FOUND" && input.preparation) {
      const attempted = await attemptMigration(input.preparation, location.canvasId);
      if (attempted) return attempted;
    }
    if (result.code === "CANVAS_NOT_FOUND") {
      return { kind: "not-found", canvasId: location.canvasId, error: result.error };
    }
    return { kind: "error", error: result.error };
  }

  // 最近画布仍存在 → 选择它（replaceState 规范化，不新增 history entry）。
  const recent = selection.getRecentCanvasId();
  if (recent) {
    const result = await catalog.get(recent);
    if (result.ok) return { kind: "resolved", canvasId: recent, created: false };
  }

  // 目录第一项。
  const list = await catalog.load();
  if (!list.ok) {
    // 隐式缺省解析：目录不可用时回退默认画布（不阻塞打开画布；显式 ID 仍走 not-found）。
    if (input.fallbackCanvasId) return { kind: "resolved", canvasId: input.fallbackCanvasId, created: false };
    return { kind: "error", error: list.error };
  }
  const first = list.entries[0];
  if (first) return { kind: "resolved", canvasId: first.id, created: false };

  // 目录确认为空 → 幂等创建一个默认空画布（StrictMode 重放由 generation guard 隔离）。
  const created = await catalog.create({});
  if (!created.ok) return { kind: "error", error: created.error };
  return { kind: "resolved", canvasId: created.canvasId, created: true };
}

/**
 * 显式旧 ID 的迁移尝试：来源目录为空（未启用/未认证）时不触发任何请求，维持 not-found。
 *
 * 触发 `prepare` 后：
 * - ready → 视为已就绪（返回 resolved，调用方可直接打开）；
 * - preparing → 返回准备态（**不**创建/跳转默认画布）；
 * - deleted/failed → 返回 not-found（删除不复活；失败由调用方展示错误）。
 */
async function attemptMigration(
  preparation: CanvasPreparationService,
  canvasId: string
): Promise<CanvasResolution | null> {
  try {
    await preparation.listSources();
  } catch {
    return null;
  }
  if (preparation.getState().sources.length === 0) return null;
  const sourceId = preparation.getState().sources.find((source) => source.availability === "available")?.sourceId;
  if (!sourceId) return null;
  await preparation.prepare({ canvasId, sourceId });
  const state = preparation.getState();
  switch (state.status) {
    case "ready":
      return { kind: "resolved", canvasId, created: false };
    case "preparing":
    case "loading":
      return { kind: "preparing", canvasId, jobId: state.jobId };
    case "deleted":
      return { kind: "not-found", canvasId, error: "已删除的作品不会自动重建" };
    default:
      return null;
  }
}
