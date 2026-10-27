/**
 * Frontend 插件偏好 store
 * （change: add-frontend-plugin-manager，任务 2.1/2.2 / design D3/D6；
 *  其后按「配置文件是事实来源」重写：启停不再写浏览器 localStorage）。
 *
 * store 是配置文件 `extensions.frontend.<id>.enabled` 在浏览器侧的**只读投影 + 写入转发**：
 * - 读取：由调用方注入从宿主设置快照投影出的目标状态（`defaultPreferences` 兜底启用）；
 * - 写入：交给注入的 `persist`（走宿主设置 API，写进宿主配置文件并热生效），
 *   store 自己不持有任何持久化介质；
 * - 失败时保留最后成功值、返回失败，不制造「已保存」假象。
 *
 * store 只接触已知可配置 optional ID；required/未知 ID 永不进入有效选择（design D1/D3）。
 */
import {
  defaultPreferences,
  normalizePreferences,
  type FrontendExtensionPreferences,
  type PreferencesDiagnostic
} from "./codec.js";

export type ExtensionPreferenceSnapshot = {
  /** 当前目标选择（最后成功读取/保存的值）。 */
  preferences: FrontendExtensionPreferences;
  /** 最近一次解析/存储诊断（成功操作后清空相关写入诊断）。 */
  diagnostic: PreferencesDiagnostic | null;
  /** 读取与写入都可用时为 true；任一步骤失败后为 false。 */
  persistenceAvailable: boolean;
};

export type ExtensionPreferenceWriteResult = { ok: true } | { ok: false; error: string };

export type ExtensionPreferenceStoreOptions = {
  /** 可配置 optional Plugin ID allowlist（静态可信）。 */
  ids: readonly string[];
  /**
   * 从宿主设置快照投影出的目标状态（配置文件 `extensions.frontend.<id>.enabled`）。
   * 缺省表示宿主未提供：回退全部启用。
   */
  desired?: FrontendExtensionPreferences;
  /**
   * 写入一个插件的目标状态（生产实现写宿主配置文件）。
   * 缺省表示当前宿主不支持持久化（store 退化为只读）。
   */
  persist?: (id: string, enabled: boolean) => Promise<ExtensionPreferenceWriteResult>;
};

export class ExtensionPreferenceStore {
  private readonly ids: readonly string[];
  private readonly persist?: (id: string, enabled: boolean) => Promise<ExtensionPreferenceWriteResult>;
  private readonly listeners = new Set<() => void>();
  private snapshot: ExtensionPreferenceSnapshot;
  private disposed = false;
  /** 写入串行化：同一插件的连续操作不互相覆盖。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ExtensionPreferenceStoreOptions) {
    this.ids = options.ids;
    this.persist = options.persist;
    this.snapshot = this.project(options.desired);
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
   * 用新的配置投影替换目标选择（宿主热重载 / 重新拉取快照后调用）。
   *
   * 只包含 allowlist 内的 ID；未出现的 ID 取默认启用。
   */
  applyDesired(desired: FrontendExtensionPreferences): void {
    if (this.disposed) return;
    this.snapshot = this.project(desired);
    for (const listener of this.listeners) listener();
  }

  /**
   * 设置一个可配置 optional Plugin 的目标状态并转发给持久化实现。
   *
   * 成功：以宿主写真值更新 snapshot、清空写入诊断并通知订阅者。
   * 失败：保留最后成功值、记录诊断并返回失败；不产生 pending。
   * 非 allowlist ID：拒绝且不写任何介质。
   */
  setEnabled(id: string, enabled: boolean): ExtensionPreferenceWriteResult {
    if (this.disposed) return { ok: false, error: "插件配置已释放" };
    if (!this.ids.includes(id)) return { ok: false, error: "未知或不可配置的插件" };
    const persist = this.persist;
    if (!persist) {
      this.update({
        diagnostic: { code: "storage-write-failed", detail: "当前宿主不支持保存插件启停" },
        persistenceAvailable: false
      });
      return { ok: false, error: "当前宿主不支持保存插件启停" };
    }
    const next = normalizePreferences(this.ids, { ...this.snapshot.preferences, [id]: enabled });
    // 乐观更新：面板立即反映目标；写入失败再回滚到最后成功值。
    this.update({ preferences: next, diagnostic: null, persistenceAvailable: true });
    void this.serializeWrite(persist, id, enabled);
    return { ok: true };
  }

  /** 等待最近的写入稳定（测试与面板显式刷新用）。 */
  async settled(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private serializeWrite(
    persist: (id: string, enabled: boolean) => Promise<ExtensionPreferenceWriteResult>,
    id: string,
    enabled: boolean
  ): Promise<void> {
    const run = this.chain.then(
      () => persist(id, enabled),
      () => persist(id, enabled)
    );
    const settled: Promise<void> = run
      .then((result) => {
        if (!this.disposed && !result.ok) {
          this.update({
            preferences: this.revert(id, enabled),
            diagnostic: { code: "storage-write-failed", detail: result.error },
            persistenceAvailable: true
          });
        }
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.update({
          preferences: this.revert(id, enabled),
          diagnostic: { code: "storage-write-failed", detail: error instanceof Error ? error.message : "插件启停保存失败" },
          persistenceAvailable: true
        });
      });
    this.chain = settled;
    return settled;
  }

  /** 写入失败时回滚该 ID 到写入前的值。 */
  private revert(id: string, attempted: boolean): FrontendExtensionPreferences {
    const previous = { ...this.snapshot.preferences, [id]: !attempted };
    return normalizePreferences(this.ids, previous);
  }

  private project(desired: FrontendExtensionPreferences | undefined): ExtensionPreferenceSnapshot {
    const resolved = normalizePreferences(this.ids, { ...defaultPreferences(this.ids), ...(desired ?? {}) });
    return {
      preferences: resolved,
      diagnostic: null,
      persistenceAvailable: this.persist !== undefined
    };
  }

  private update(patch: Partial<ExtensionPreferenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
