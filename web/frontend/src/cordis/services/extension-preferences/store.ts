/**
 * Frontend 插件偏好 store
 * （change: add-frontend-plugin-manager，任务 2.1/2.2 / design D3/D6）。
 *
 * origin-local 版本化偏好记录的唯一 owner：读取一次初始有效选择，提供 snapshot/subscription
 * 与规范化的成功写入。写入失败时保留最后成功值、返回失败且不产生“已保存”假象；读取失败
 * 或损坏时回退全启用默认值并暴露**不含原始内容**的诊断。
 *
 * store 只接触已知可配置 optional ID；required/未知 ID 永不进入有效选择（design D1/D3）。
 */
import {
  FRONTEND_PLUGIN_PREFERENCES_KEY,
  defaultPreferences,
  normalizePreferences,
  parsePreferences,
  serializePreferences,
  type FrontendExtensionPreferences,
  type PreferenceStorage,
  type PreferencesDiagnostic
} from "./codec.js";

export type ExtensionPreferenceSnapshot = {
  /** 当前目标选择（最后成功读取/保存的值）。 */
  preferences: FrontendExtensionPreferences;
  /** 最近一次解析/存储诊断（成功操作后清空相关写入诊断）。 */
  diagnostic: PreferencesDiagnostic | null;
  /** 读取与写入都可用时为 true；任一步骤抛错后为 false。 */
  persistenceAvailable: boolean;
};

export type ExtensionPreferenceWriteResult = { ok: true } | { ok: false; error: string };

export type ExtensionPreferenceStoreOptions = {
  /** 可配置 optional Plugin ID allowlist（静态可信）。 */
  ids: readonly string[];
  /** 注入的存储；缺省使用 globalThis.localStorage（不可用时降级）。 */
  storage?: PreferenceStorage | null;
  /** 存储键（缺省版本化键）。 */
  key?: string;
};

export class ExtensionPreferenceStore {
  private readonly ids: readonly string[];
  private readonly storage: PreferenceStorage | null;
  private readonly key: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: ExtensionPreferenceSnapshot;
  private disposed = false;

  constructor(options: ExtensionPreferenceStoreOptions) {
    this.ids = options.ids;
    this.key = options.key ?? FRONTEND_PLUGIN_PREFERENCES_KEY;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.snapshot = this.readInitial();
  }

  getSnapshot = (): ExtensionPreferenceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isEnabled(id: string): boolean {
    return this.snapshot.preferences[id] ?? true;
  }

  /**
   * 设置一个可配置 optional Plugin 的目标状态并规范化写入。
   *
   * 写入成功：更新 snapshot、清空写入诊断并通知订阅者。
   * 写入失败：保留最后成功值、记录 `storage-write-failed` 并返回失败；不产生 pending。
   * 非 allowlist ID：拒绝且不写存储。
   */
  setEnabled(id: string, enabled: boolean): ExtensionPreferenceWriteResult {
    if (this.disposed) return { ok: false, error: "插件配置已释放" };
    if (!this.ids.includes(id)) return { ok: false, error: "未知或不可配置的插件" };
    const next = normalizePreferences(this.ids, { ...this.snapshot.preferences, [id]: enabled });
    if (this.storage === null) {
      this.update({
        diagnostic: { code: "storage-write-failed", detail: "浏览器拒绝持久化，设置无法保存" },
        persistenceAvailable: false
      });
      return { ok: false, error: "浏览器拒绝持久化，设置无法保存" };
    }
    try {
      this.storage.setItem(this.key, serializePreferences(this.ids, next));
    } catch {
      this.update({
        diagnostic: { code: "storage-write-failed", detail: "浏览器拒绝持久化，设置无法保存" },
        persistenceAvailable: false
      });
      return { ok: false, error: "浏览器拒绝持久化，设置无法保存" };
    }
    this.update({ preferences: next, diagnostic: null, persistenceAvailable: true });
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private readInitial(): ExtensionPreferenceSnapshot {
    const fallback: ExtensionPreferenceSnapshot = {
      preferences: defaultPreferences(this.ids),
      diagnostic: null,
      persistenceAvailable: this.storage !== null
    };
    if (this.storage === null) return fallback;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return {
        ...fallback,
        diagnostic: { code: "storage-read-failed", detail: "浏览器拒绝读取存储，使用默认插件选择" },
        persistenceAvailable: false
      };
    }
    const parsed = parsePreferences(raw, this.ids);
    return { preferences: parsed.preferences, diagnostic: parsed.diagnostic, persistenceAvailable: true };
  }

  private update(patch: Partial<ExtensionPreferenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

/** globalThis.localStorage 安全 facade；不可用（SSR/拒绝）时返回 null。 */
export function defaultStorage(): PreferenceStorage | null {
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
