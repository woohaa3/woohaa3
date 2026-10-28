/**
 * Extension Manager 的闭包共享状态：一次 `createExtensionManager` 构造一个上下文，
 * 安装流水线与生命周期函数都通过它显式取用依赖与状态（不引入模块级可变状态）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionInstallOutcome } from "@woohaa3/contracts";
import { ExtensionManagerError, toManagerError } from "./errors.js";
import { createJobBoard, type Job, type JobBoard } from "./jobs.js";
import {
  DEFAULT_MAX_PACKAGE_BYTES,
  DEFAULT_OBSERVE_MS,
  DEFAULT_RETENTION_MS,
  FAILURE_MESSAGES,
  sleepDefault,
  type ExtensionManagerDeps
} from "./manager-types.js";
import type { ExtensionPackageToolkit, InstallationRecord, InstallationsHandle, InstallationsState } from "./types.js";

export type ManagerContext = {
  deps: ExtensionManagerDeps;
  handle: InstallationsHandle | null;
  toolkit: ExtensionPackageToolkit;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxPackageBytes: number;
  observeMs: number;
  failureThreshold: number;
  retentionMs: number;
  drainTimeoutMs: number;
  drainPollMs: number;
  board: JobBoard;
  healthFailures: Map<string, number>;
  /** 本进程内需要重启才生效的扩展（卸载含后端的扩展后记录已删，靠这里提示）。 */
  restartPendingRemoved: Set<string>;
  /** 每个 Manager 实例自己的可变状态。 */
  status: { closed: boolean };
  requireHandle(): InstallationsHandle;
  /** 提交一次指针变更：读当前 revision → mutator → 原子写。 */
  commit(mutate: (draft: InstallationsState) => void): InstallationsState;
  history(record: InstallationRecord, entry: Record<string, unknown>): InstallationRecord;
  stagingFor(job: Job): string;
  cleanupStaging(job: Job): void;
  assertNotAborted(job: Job): void;
  /**
   * 重载。`hasBackend` = 声明了后端代码（记录里的 `requiresRestart`）：
   * - 纯前端：运行期发布 release 热登记；
   * - `hostPlugin`（hotSwappable）：扩展层 add/swap 换版；
   * - 站点 `backend` 工厂（hotSwappable=false）：没有运行期装配入口，直接 `restart-required`。
   * `directory = null` 表示卸载。
   */
  reload(
    extensionId: string,
    directory: string | null,
    hasBackend: boolean,
    options?: { previousDirectory?: string | null; hotSwappable?: boolean }
  ): Promise<ExtensionInstallOutcome>;
  /** 把指针切到 target（安装后重载失败 / 观察期失败 / 手动回滚共用）。`backend` = 含后端代码；`restart` = 需要受控重启才生效。 */
  switchPointer(extensionId: string, target: string, action: string, actor: string, rejected?: string): { record: InstallationRecord | null; restart: boolean; backend: boolean };
};

export function createManagerContext(deps: ExtensionManagerDeps, handle: InstallationsHandle | null): ManagerContext {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const sleep = deps.sleep ?? sleepDefault;
  const { toolkit } = deps;
  const maxPackageBytes = deps.limits?.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  const observeMs = deps.observeMs ?? DEFAULT_OBSERVE_MS;
  const failureThreshold = deps.observeFailureThreshold ?? 3;
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 5 * 60 * 1000;
  const drainPollMs = deps.drainPollMs ?? 1000;
  const board = createJobBoard({ now });
  const healthFailures = new Map<string, number>();
  const restartPendingRemoved = new Set<string>();

  const requireHandle = (): InstallationsHandle => {
    if (!handle) throw new ExtensionManagerError("MARKETPLACE_UNAVAILABLE", FAILURE_MESSAGES.MARKETPLACE_UNAVAILABLE!);
    return handle;
  };

  /** 提交一次指针变更：读当前 revision → mutator → 原子写。 */
  const commit = (mutate: (draft: InstallationsState) => void): InstallationsState => {
    const h = requireHandle();
    const current = h.read();
    try {
      return h.commit((draft) => {
        mutate(draft);
      }, { expectedRevision: current.revision });
    } catch (error) {
      throw toManagerError(error, "MARKETPLACE_REVISION_CONFLICT");
    }
  };

  const history = (record: InstallationRecord, entry: Record<string, unknown>): InstallationRecord =>
    toolkit.appendHistory(record, { ...entry, at: now().toISOString() });

  const stagingFor = (job: Job) => path.join(requireHandle().layout.stagingDir, job.id);
  const cleanupStaging = (job: Job) => {
    if (!handle) return;
    fs.rmSync(stagingFor(job), { recursive: true, force: true });
  };

  const assertNotAborted = (job: Job) => {
    if (job.controller.signal.aborted) throw new ExtensionManagerError("MARKETPLACE_CANCELLED", "安装已取消");
  };

  const reload = async (
    extensionId: string,
    directory: string | null,
    hasBackend: boolean,
    options: { previousDirectory?: string | null; hotSwappable?: boolean } = {}
  ): Promise<ExtensionInstallOutcome> => {
    const hotSwappable = options.hotSwappable !== false;
    // 站点 backend 工厂没有运行期装配入口：即使宿主有扩展层，也只能等下一次启动。
    if (hasBackend && !hotSwappable) return "restart-required";
    if (hasBackend) {
      // 进程内热切换（C 方向）：扩展层 add / remove 建在 Cordis fiber 上，撤下的 fiber 会回滚自己
      // 注册的 Provider / 路由 / 监听；每个版本一个目录，换版本就是换模块 URL，不会命中 ESM 缓存。
      // 同名插件不能并存，所以是「先卸后装」——这段空窗无法消除，只能靠装回旧版本兜住失败。
      const runtime = deps.runtime;
      if (!runtime?.available()) return "restart-required";
      if (!directory) {
        // 卸载：撤下运行期实例即可，插件清单与指针由调用方处理。
        try {
          await runtime.remove(extensionId);
        } catch (error) {
          log({ event: "extension-runtime-remove-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        }
      } else {
        const current = requireHandle();
        const previous = options.previousDirectory !== undefined
          ? options.previousDirectory
          : current.read().extensions[extensionId]?.previous
            ? current.layout.versionDir(extensionId, current.read().extensions[extensionId]!.previous!)
            : null;
        try {
          // `previousVersion` 只在「同目录不同模块」的开发者模式下与目录名不同；受管版本取目录 basename 即可。
          await runtime.swap(extensionId, directory, path.basename(directory), previous, previous ? path.basename(previous) : null);
          log({ event: "extension-swapped", extensionId, directory });
        } catch (error) {
          const cause = (error as { code?: unknown })?.code;
          throw new ExtensionManagerError("MARKETPLACE_SWAP_FAILED", `新版本未能在进程内就绪${typeof cause === "string" ? `（${cause}）` : ""}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!deps.publishBrowserRelease) return "installed";
    }
    if (!deps.publishBrowserRelease) return "restart-required";
    try {
      await deps.publishBrowserRelease(directory ? { upsert: [{ extensionId, directory }] } : { remove: [extensionId] });
    } catch (error) {
      const failure = toManagerError(error, "MARKETPLACE_PREFLIGHT_FAILED");
      throw new ExtensionManagerError("MARKETPLACE_PREFLIGHT_FAILED", `发布浏览器产物失败：${failure.message}`);
    }
    return "installed";
  };

  /** 把指针切回 previous（安装后重载失败 / 观察期失败 / 手动回滚共用）。返回切换后的记录与是否需重启。 */
  const switchPointer = (extensionId: string, target: string, action: string, actor: string, rejected?: string) => {
    let result: { record: InstallationRecord | null; restart: boolean; backend: boolean } = { record: null, restart: false, backend: false };
    commit((draft) => {
      const record = draft.extensions[extensionId];
      if (!record) throw new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`);
      const from = record.current;
      const backend = Boolean(record.requiresRestart);
      const hotSwappable = record.hotSwappable !== false;
      const restart = backend && (!deps.runtime?.available() || !hotSwappable);
      let next: InstallationRecord = {
        ...record,
        current: target,
        previous: from === target ? record.previous ?? null : from,
        state: "active",
        observeUntil: null,
        observeAfterRestart: false,
        restartPending: restart || record.restartPending === true,
        ...(rejected ? { rejected: [...new Set([...(record.rejected ?? []), rejected])] } : {})
      };
      next = history(next, { revision: draft.revision + 1, action, version: target, from, actor });
      draft.extensions[extensionId] = next;
      result = { record: next, restart, backend };
    });
    return result;
  };

  return {
    deps,
    handle,
    toolkit,
    now,
    log,
    sleep,
    maxPackageBytes,
    observeMs,
    failureThreshold,
    retentionMs,
    drainTimeoutMs,
    drainPollMs,
    board,
    healthFailures,
    restartPendingRemoved,
    status: { closed: false },
    requireHandle,
    commit,
    history,
    stagingFor,
    cleanupStaging,
    assertNotAborted,
    reload,
    switchPointer
  };
}