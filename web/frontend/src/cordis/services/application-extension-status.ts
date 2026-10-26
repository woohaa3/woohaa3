/**
 * 站点插件状态 Service
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 4.1 / design D5）。
 *
 * 服务端权威状态的浏览器读模型：
 * - 以 monotonic revision 拉取 snapshot 与有界增量；
 * - 旧响应（revision 更小的迟到响应）**不得覆盖**更新状态；
 * - 丢失 cursor / 断线重连后重取 snapshot；
 * - 不含配置秘密；只暴露公开状态与安全诊断。
 *
 * 通过注入的 remote 拉取；不自行创建 fetch。`subscribe` 通知 React/controller。
 */
import type {
  ApplicationExtensionChange,
  ApplicationExtensionReleasePointer,
  ApplicationExtensionStatus
} from "@woohaa3/contracts";
import type {
  ApplicationExtensionConfigWriteInput,
  ApplicationRemote,
  ApplicationExtensionWriteResult
} from "./application-remote.js";

export type ApplicationExtensionStatusSnapshot = {
  revision: number;
  /** 服务端可信清单公开元数据摘要（名称/说明/展示目录，不含可执行入口）。 */
  catalog: ApplicationExtensionCatalogSummary[];
  plugins: ApplicationExtensionStatus[];
  /** 最近一次同步错误（安全文案）；无错误为 null。 */
  error: string | null;
  /** 尚未取得任何权威状态。 */
  loading: boolean;
  /**
   * 宿主当前发布目录指针（change: 2026-10-21-add-extension-marketplace-point，6.2）。
   * 受管扩展热登记后变化；旧宿主不返回时为 null。与插件 revision 独立。
   */
  extensionRelease?: ApplicationExtensionReleasePointer | null;
};

export type ApplicationExtensionCatalogSummary = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  extensionId: string;
  name: string;
  description: string;
  version: string;
};

export type ApplicationExtensionStatusServiceOptions = {
  remote: ApplicationRemote;
  subscribeToChanges?: boolean;
  /** 增量刷新周期（毫秒）；缺省 5000。 */
  pollIntervalMs?: number;
};

export type ApplicationExtensionStatusService = {
  getSnapshot: () => ApplicationExtensionStatusSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 拉取权威 snapshot（重连/丢失 cursor）。 */
  refresh: () => Promise<void>;
  /** 增量刷新（旧响应不覆盖新状态）。 */
  refreshChanges: () => Promise<void>;
  /** 管理员配置写入；成功后重取权威状态。 */
  writeConfig: (input: Omit<ApplicationExtensionConfigWriteInput, "expectedRevision"> & { expectedRevision?: number }) => Promise<ApplicationExtensionWriteResult>;
  /** 启动/停止轮询。 */
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

const EMPTY: ApplicationExtensionStatusSnapshot = { revision: -1, catalog: [], plugins: [], error: null, loading: true, extensionRelease: null };

export function createApplicationExtensionStatusService(
  options: ApplicationExtensionStatusServiceOptions
): ApplicationExtensionStatusService {
  const listeners = new Set<() => void>();
  let snapshot: ApplicationExtensionStatusSnapshot = EMPTY;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const publish = (next: ApplicationExtensionStatusSnapshot) => {
    snapshot = next;
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  /** 只接受不早于当前 revision 的状态（旧响应不得覆盖新状态）。 */
  const applyMonotonic = (
    revision: number,
    plugins: ApplicationExtensionStatus[],
    catalog: ApplicationExtensionCatalogSummary[],
    error: string | null,
    extensionRelease: ApplicationExtensionReleasePointer | null | undefined
  ) => {
    if (revision < snapshot.revision) return;
    // 指针缺省（旧宿主或该响应未携带）时沿用已知值，不回退为 null。
    const release = extensionRelease ?? snapshot.extensionRelease ?? null;
    publish({ revision, catalog, plugins, error, loading: false, extensionRelease: release });
  };

  const mergeChange = (existing: ApplicationExtensionStatus[], change: ApplicationExtensionChange): ApplicationExtensionStatus[] => {
    const index = existing.findIndex((entry) => entry.extensionId === change.extensionId);
    if (index === -1) return [...existing, change.status];
    const next = [...existing];
    next[index] = change.status;
    return next;
  };

  const refresh: ApplicationExtensionStatusService["refresh"] = async () => {
    if (disposed) return;
    const result = await options.remote.fetchSnapshot();
    if (disposed) return;
    if (!result.ok) {
      publish({ ...snapshot, error: result.error, loading: false });
      return;
    }
    applyMonotonic(result.snapshot.revision, result.snapshot.plugins, result.snapshot.catalog, null, result.snapshot.extensionRelease);
  };

  const refreshChanges: ApplicationExtensionStatusService["refreshChanges"] = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      // revision 为 -1 表示尚未取得 snapshot：重取 snapshot。
      if (snapshot.revision < 0) {
        await refresh();
        return;
      }
      const result = await options.remote.fetchChanges(snapshot.revision);
      if (disposed) return;
      if (!result.ok) {
        // 增量失败视为断线：重取权威 snapshot（成功后清空错误，不保留不可信增量）。
        await refresh();
        return;
      }
      const batch = result.batch;
      if (batch.resyncRequired) {
        await refresh();
        return;
      }
      if (batch.revision < snapshot.revision) return;
      let plugins = snapshot.plugins;
      for (const change of batch.changes) plugins = mergeChange(plugins, change);
      applyMonotonic(batch.revision, plugins, snapshot.catalog, null, batch.extensionRelease);
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (disposed || timer) return;
    void refresh();
    if (options.subscribeToChanges ?? true) {
      timer = setInterval(() => void refreshChanges(), options.pollIntervalMs ?? 5_000);
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const writeConfig: ApplicationExtensionStatusService["writeConfig"] = async (input) => {
    const expectedRevision = input.expectedRevision ?? Math.max(snapshot.revision, 0);
    const result = await options.remote.writeConfig({ ...input, expectedRevision });
    if (result.ok) {
      // 写入成功后重取权威状态（旧值不保留）。
      await refresh();
    }
    return result;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    refreshChanges,
    writeConfig,
    start,
    stop,
    dispose: () => {
      disposed = true;
      stop();
      listeners.clear();
    }
  };
}
