/**
 * 设置页「核心服务」分区的状态：读取 / 保存 `/api/settings`，并记录当前用户能否管理。
 *
 * 能否管理也决定插件分区里站点插件与生成模型的开关是否可写（服务端仍会二次授权）。
 */
import type { SettingsIssue, SettingsSnapshot, SettingsWriteValue } from "@woohaa3/contracts";

type RemoteResult = { ok: true; snapshot: SettingsSnapshot } | { ok: false; code: string; error: string; issues?: SettingsIssue[] };

export type BackendSettingsRemote = {
  fetchSnapshot(): Promise<RemoteResult>;
  setExtensionInstalled?(extensionId: string, installed: boolean): Promise<RemoteResult>;
  write(values: Record<string, SettingsWriteValue>): Promise<RemoteResult>;
};

export type BackendSettingsState =
  | { status: "loading" }
  | { status: "unauthorized" }
  | { status: "error"; error: string }
  | { status: "ready"; snapshot: SettingsSnapshot };

export type BackendSettingsSaveResult = { ok: true } | { ok: false; error: string; issues: SettingsIssue[] };

export type BackendSettingsStore = {
  getState(): BackendSettingsState;
  subscribe(listener: () => void): () => void;
  canManage(): boolean;
  load(): Promise<void>;
  setExtensionInstalled?(extensionId: string, installed: boolean): Promise<BackendSettingsSaveResult>;
  save(values: Record<string, SettingsWriteValue>): Promise<BackendSettingsSaveResult>;
};

/**
 * 包一层 remote：写入成功后刷新「由配置决定的运行时状态」。
 *
 * 站点插件状态是按 revision 有界的**增量**拉取，写配置（走 `/api/settings`）不推进它的 revision。
 * 而 Provider 补上 API Key 这类写入会让插件从 `degraded` 回到 `active`、模型从不可执行变可执行，
 * 不主动重取就只能靠刷新页面才看得到。刷新失败不影响写入结果（写入已成功，状态只是展示）。
 */
export function withRuntimeStateRefresh(
  remote: BackendSettingsRemote,
  refresh: ReadonlyArray<() => Promise<void>>
): BackendSettingsRemote {
  return {
    fetchSnapshot: () => remote.fetchSnapshot(),
    setExtensionInstalled: remote.setExtensionInstalled?.bind(remote),
    async write(values) {
      const result = await remote.write(values);
      if (result.ok) {
        for (const run of refresh) void run().catch(() => undefined);
      }
      return result;
    }
  };
}

export function createBackendSettingsStore(remote: BackendSettingsRemote): BackendSettingsStore {
  let state: BackendSettingsState = { status: "loading" };
  const listeners = new Set<() => void>();
  const set = (next: BackendSettingsState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const fromFailure = (result: Extract<RemoteResult, { ok: false }>): BackendSettingsState =>
    result.code === "unauthorized" ? { status: "unauthorized" } : { status: "error", error: result.error };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canManage: () => state.status === "ready",
    async load() {
      const result = await remote.fetchSnapshot();
      set(result.ok ? { status: "ready", snapshot: result.snapshot } : fromFailure(result));
    },
    async setExtensionInstalled(extensionId, installed) {
      if (!remote.setExtensionInstalled) return { ok: false, error: "当前宿主不支持插件目录管理", issues: [] };
      const result = await remote.setExtensionInstalled(extensionId, installed);
      if (result.ok) { set({ status: "ready", snapshot: result.snapshot }); return { ok: true }; }
      if (result.code === "unauthorized") set({ status: "unauthorized" });
      return { ok: false, error: result.error, issues: result.issues ?? [] };
    },
    async save(values) {
      const result = await remote.write(values);
      if (result.ok) {
        set({ status: "ready", snapshot: result.snapshot });
        return { ok: true };
      }
      if (result.code === "unauthorized") set({ status: "unauthorized" });
      return { ok: false, error: result.error, issues: result.issues ?? [] };
    }
  };
}
