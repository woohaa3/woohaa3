/**
 * 最近画布选择存储
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.4 / design D1；
 *   change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 5.8）。
 *
 * 本地记录「最近打开的画布 ID」，用于无 canvasId 的 Canvas URL 确定性解析。读写失败都
 * 静默降级（存储不可用时返回 null / 忽略），绝不阻塞启动。
 *
 * `namespace` 提供 identity provider + subject 隔离：账号切换后不会命中上一主体记录的最近 ID。
 * 未注入或命名空间为 null 时使用匿名 key（展示仍受服务端 read 授权保护）。
 */
import type { CanvasSelectionService } from "../contract/canvas-catalog.js";

export const RECENT_CANVAS_STORAGE_KEY = "woohaa3.recent-canvas-id";

export type CanvasSelectionOptions = {
  /** 用户态命名空间（`providerId:subject`）；null 表示未知/匿名。 */
  namespace?: () => string | null;
};

export function createCanvasSelectionService(storage?: Storage, options: CanvasSelectionOptions = {}): CanvasSelectionService {
  const resolveStore = (): Storage | null => {
    if (storage) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  // 每次读写都重新求值命名空间：身份异步解析完成后再访问即可命中正确主体。
  const storageKey = (): string => {
    const ns = options.namespace?.() ?? null;
    return ns ? `${RECENT_CANVAS_STORAGE_KEY}::${ns}` : RECENT_CANVAS_STORAGE_KEY;
  };
  return {
    getRecentCanvasId(): string | null {
      const store = resolveStore();
      if (!store) return null;
      try {
        const value = store.getItem(storageKey());
        return value && value.trim() ? value : null;
      } catch {
        return null;
      }
    },
    setRecentCanvasId(canvasId: string | null): void {
      const store = resolveStore();
      if (!store) return;
      try {
        if (canvasId) store.setItem(storageKey(), canvasId);
        else store.removeItem(storageKey());
      } catch {
        // 存储失败不影响主流程。
      }
    }
  };
}
