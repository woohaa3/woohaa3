/**
 * 通知偏好的本地持久化（change: 2026-10-17-move-settings-into-canvas-dialog，任务 9.2 / design D10）。
 *
 * 只保存**非敏感**偏好：
 * - 带版本化的独立键，**不写** `/api/settings`、画布 Y.Doc 或共享宿主配置；
 * - 按实例 + basePath + 数据范围隔离，同源不同 worktree 挂载互不串扰；
 * - 读取失败/损坏回退默认值并给出诊断（不抛错、不阻塞设置打开）；
 * - 写入失败保留上次成功值并返回失败，不产生「已保存」假象。
 *
 * 纯逻辑（注入 storage），便于确定性回归。
 */
import {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  type TaskNotificationPreferences
} from "../../contract/notification.js";

export const TASK_NOTIFICATION_PREFERENCES_KEY = "woohaa:task-notifications:v1";

/** 偏好作用域：同源不同实例/挂载/数据范围必须隔离。 */
export type TaskNotificationScope = {
  /** 应用实例标识（桌面壳或浏览器 origin 内稳定）。 */
  instanceId: string;
  /** 规范化发布挂载路径（`/` 或 `/dev/xxx/`）。 */
  basePath: string;
  /** 身份数据范围（无身份时为空串）。 */
  dataScopeId: string;
};

export type TaskNotificationStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type TaskNotificationPreferenceDiagnostic = {
  code: "read-failed" | "write-failed" | "corrupt";
  /** 安全文案（不含存储内容）。 */
  message: string;
};

export type TaskNotificationPreferenceSnapshot = {
  preferences: TaskNotificationPreferences;
  /** 读取/写入是否可用。 */
  persistenceAvailable: boolean;
  diagnostic: TaskNotificationPreferenceDiagnostic | null;
};

export type TaskNotificationPreferenceStore = {
  getSnapshot(): TaskNotificationPreferenceSnapshot;
  subscribe(listener: () => void): () => void;
  /** 当前作用域的稳定键（诊断/回归）。 */
  storageKey(): string;
  setPreferences(next: TaskNotificationPreferences): { ok: true } | { ok: false; error: string };
  /** 数据范围变化：重新读取该范围的值（旧范围的写入不再影响新范围）。 */
  setScope(scope: TaskNotificationScope): void;
  dispose(): void;
};

/** 作用域键：稳定排序拼接，避免不同范围碰撞。 */
export function preferenceStorageKey(scope: TaskNotificationScope): string {
  return [
    TASK_NOTIFICATION_PREFERENCES_KEY,
    encodeURIComponent(scope.instanceId),
    encodeURIComponent(scope.basePath),
    encodeURIComponent(scope.dataScopeId)
  ].join("|");
}

/** 规范化偏好：未知/非法字段回退默认值（前向兼容）。 */
export function normalizePreferences(raw: unknown): TaskNotificationPreferences {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const categories = (typeof value.categories === "object" && value.categories !== null ? value.categories : {}) as Record<
    string,
    unknown
  >;
  const bool = (input: unknown, fallback: boolean) => (typeof input === "boolean" ? input : fallback);
  const defaults = DEFAULT_TASK_NOTIFICATION_PREFERENCES;
  return {
    categories: {
      succeeded: bool(categories.succeeded, defaults.categories.succeeded),
      failed: bool(categories.failed, defaults.categories.failed)
    },
    titleEnabled: bool(value.titleEnabled, defaults.titleEnabled),
    systemEnabled: bool(value.systemEnabled, defaults.systemEnabled)
  };
}

function defaultStorage(): TaskNotificationStorage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value)
    };
  } catch {
    return null;
  }
}

export function createTaskNotificationPreferenceStore(options: {
  scope: TaskNotificationScope;
  storage?: TaskNotificationStorage | null;
}): TaskNotificationPreferenceStore {
  const owned = options.storage === undefined;
  const storage = owned ? defaultStorage() : options.storage;
  let scope = options.scope;
  let snapshot: TaskNotificationPreferenceSnapshot = {
    preferences: { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES },
    persistenceAvailable: storage !== null,
    diagnostic: null
  };
  let disposed = false;
  const listeners = new Set<() => void>();

  const publish = (next: TaskNotificationPreferenceSnapshot) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const read = (nextScope: TaskNotificationScope): TaskNotificationPreferenceSnapshot => {
    if (!storage) {
      return {
        preferences: { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES },
        persistenceAvailable: false,
        diagnostic: {
          code: "read-failed",
          message: "浏览器拒绝持久化，通知偏好仅在本次会话内生效"
        }
      };
    }
    try {
      const raw = storage.getItem(preferenceStorageKey(nextScope));
      if (raw === null) {
        return {
          preferences: { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES },
          persistenceAvailable: true,
          diagnostic: null
        };
      }
      const parsed: unknown = JSON.parse(raw);
      return {
        preferences: normalizePreferences(parsed),
        persistenceAvailable: true,
        diagnostic: null
      };
    } catch {
      return {
        preferences: { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES },
        persistenceAvailable: true,
        diagnostic: { code: "corrupt", message: "通知偏好无法识别，已回退默认值" }
      };
    }
  };

  snapshot = read(scope);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    storageKey: () => preferenceStorageKey(scope),
    setPreferences(next) {
      const normalized = normalizePreferences(next);
      if (!storage) {
        // 无持久化能力：本次会话生效，但不谎称已保存。
        publish({
          preferences: normalized,
          persistenceAvailable: false,
          diagnostic: {
            code: "read-failed",
            message: "浏览器拒绝持久化，通知偏好仅在本次会话内生效"
          }
        });
        return { ok: false, error: "通知偏好仅在本次会话内生效（无法写入本地存储）" };
      }
      try {
        storage.setItem(preferenceStorageKey(scope), JSON.stringify(normalized));
        publish({ preferences: normalized, persistenceAvailable: true, diagnostic: null });
        return { ok: true };
      } catch {
        // 保留上次成功的值，不把未落盘的值当作已保存。
        publish({
          ...snapshot,
          diagnostic: { code: "write-failed", message: "无法保存通知偏好，请检查浏览器存储权限" }
        });
        return { ok: false, error: "无法保存通知偏好，请检查浏览器存储权限" };
      }
    },
    setScope(nextScope) {
      scope = nextScope;
      publish(read(scope));
    },
    dispose() {
      disposed = true;
      listeners.clear();
    }
  };
}
