/**
 * page-scope.ts 的纯辅助函数（从 page-scope.ts 原样移出，行为不变）。
 */
import type { CanvasPreparationService } from "./contract/canvas-preparation.js";
import type { AppHistoryAdapter } from "./navigation/app-router-store.js";

/**
 * 订阅某 canvasId 的准备态：仅当状态转为 `ready` 时回调一次（用于把 preparing scope 迁移到
 * 真正的 Canvas scope）。返回取消订阅函数。
 */
export function subscribePreparationReady(
  preparation: CanvasPreparationService,
  canvasId: string,
  onReady: () => void
): () => void {
  let fired = false;
  const listener = () => {
    if (fired) return;
    const state = preparation.getState();
    if (state.canvasId !== null && state.canvasId !== canvasId) return;
    if (state.status === "ready") {
      fired = true;
      onReady();
    }
  };
  const unsubscribe = preparation.subscribe(listener);
  // 订阅后立即检查一次（可能订阅前已 ready）。
  listener();
  return unsubscribe;
}

/** 浏览器 history 适配；无 `history` 时返回 undefined（SSR/测试）。 */
export function browserHistory(): AppHistoryAdapter | undefined {
  const history = globalThis.history;
  if (!history) return undefined;
  return {
    pushState: (data, title, url) => history.pushState(data, title, url),
    replaceState: (data, title, url) => history.replaceState(data, title, url)
  };
}
