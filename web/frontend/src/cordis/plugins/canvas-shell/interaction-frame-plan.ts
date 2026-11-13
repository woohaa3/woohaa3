/**
 * 统一帧提交决策（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D2/D3）。
 *
 * 从 `interaction-controller` 抽出纯决策与视口提交边界，保持在文件体积守卫内：
 * 控制器仍是唯一帧账本 owner；本模块只回答“本帧该走 full 还是纯 viewport”，并封装
 * 视口提交的运行时能力检查（缺导出/旧 base 时回退 full）。
 */
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";

/**
 * 只改变普通 overview 视口的 dirty reason 集合。
 *
 * 只有这些来源在同一帧内**全部**命中且无其它失效时，才允许走固定大小视口增量；
 * 任何结构、选择、悬停、资源、主题、surface、focus 失效都并入 full 场景
 * （design D2 表 / D3「结构与视口同帧只发 full」）。
 */
export const VIEWPORT_ONLY_REASONS: ReadonlySet<string> = new Set(["viewport", "viewport-transition"]);

/** 本帧失效是否可安全地只提交纯视口增量。 */
export function shouldRouteViewportOnly(reasons: ReadonlySet<string>, force: boolean): boolean {
  if (force || reasons.size === 0) return false;
  for (const reason of reasons) {
    if (!VIEWPORT_ONLY_REASONS.has(reason)) return false;
  }
  return true;
}

/**
 * 运行时是否具备纯视口增量能力且已有 full 基线。
 *
 * `baseSceneGeneration() === 0` 表示尚未接受任何完整场景（冷启动/重启），必须走 full
 * 引导（design D3）。缺 `setViewport`/`baseSceneGeneration`（旧 fake/旧 WASM）时回退 full。
 */
export function viewportUpdateAvailable(runtime: BevyRuntime | null): boolean {
  if (!runtime?.setViewport || !runtime.baseSceneGeneration) return false;
  return runtime.baseSceneGeneration() > 0;
}

/** 提交一次纯视口增量；返回稳定错误字符串或 `null`（成功）。 */
export function commitViewportUpdate(
  runtime: BevyRuntime,
  viewport: { x: number; y: number; zoom: number }
): string | null {
  if (!runtime.setViewport || !runtime.baseSceneGeneration) return "viewport-unsupported";
  try {
    (runtime.queueViewport ?? runtime.setViewport)({ baseSceneGeneration: runtime.baseSceneGeneration(), viewport });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const OBSERVER_ONLY_REASONS: ReadonlySet<string> = new Set(["model-focus"]);

export function shouldRouteObserverOnly(
  reasons: ReadonlySet<string>,
  force: boolean,
  block: string | null,
  focused: boolean,
  editorUnchanged = false
): boolean {
  if (force || !focused || reasons.size === 0) return false;
  if (block && block !== "focus-active" && block !== "baseline-focus") return false;
  for (const reason of reasons) {
    if (OBSERVER_ONLY_REASONS.has(reason) || (editorUnchanged && reason === "model-editor")) continue;
    return false;
  }
  return true;
}
