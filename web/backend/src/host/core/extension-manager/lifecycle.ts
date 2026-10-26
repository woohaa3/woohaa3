/**
 * 生命周期：启动恢复、卸载、回滚、观察期判定与孤儿版本清理（从 manager.ts 拆出）。
 * 所有共享状态经 `ManagerContext` 显式传入。
 */
import fs from "node:fs";
import { MARKETPLACE_LOCAL_FILE_SOURCE_ID, type ExtensionInstallJobView } from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";
import { failedJob, runJob, unavailableError } from "./install-pipeline.js";
import type { ManagerContext } from "./manager-context.js";

/** 启动恢复：清 staging；上一进程待重启的版本已按新指针装配，观察期从现在开始。 */
export function recoverOnStartup(ctx: ManagerContext): void {
  const { handle, commit, now, observeMs, log } = ctx;
if (handle) {
  try {
    handle.clearStaging();
    const state = handle.read();
    const resumed = Object.entries(state.extensions).filter(([, record]) => record.restartPending);
    if (resumed.length > 0) {
      // 新进程：上一进程待重启的版本已按新指针装配，观察期从现在开始。
      commit((draft) => {
        for (const [id] of resumed) {
          const record = draft.extensions[id];
          if (!record) continue;
          draft.extensions[id] = {
            ...record,
            restartPending: false,
            ...(record.observeAfterRestart ? { observeAfterRestart: false, state: "observing" as const, observeUntil: new Date(now().getTime() + observeMs).toISOString() } : {})
          };
        }
      });
    }
  } catch (error) {
    log({ event: "extension-manager-recover-failed", message: error instanceof Error ? error.message : String(error) });
  }
}
}

export function uninstall(ctx: ManagerContext, extensionId: string, options: { purgeData?: boolean; actor: string }): ExtensionInstallJobView {
  const { handle, deps, board, commit, history, now, sleep, drainTimeoutMs, drainPollMs, restartPendingRemoved, reload, log } = ctx;
  if (!handle) return failedJob(ctx, "uninstall", MARKETPLACE_LOCAL_FILE_SOURCE_ID, unavailableError(), extensionId);
  const record = handle.read().extensions[extensionId];
  if (!record) return failedJob(ctx, "uninstall", MARKETPLACE_LOCAL_FILE_SOURCE_ID, new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`), extensionId);
  const { job, existing } = board.create({ action: "uninstall", sourceId: record.sourceId, dedupeKey: `uninstall:${extensionId}`, extensionId, version: record.current });
  if (existing) return job.view;
  runJob(ctx, job, () =>
    board.serial(async () => {
      job.committing = true;
      board.update(job, { phase: "commit" });
      commit((draft) => {
        const current = draft.extensions[extensionId];
        if (!current) throw new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`);
        draft.extensions[extensionId] = history({ ...current, state: "uninstalling", observeUntil: null }, { revision: draft.revision + 1, action: "uninstall-begin", version: current.current, actor: options.actor });
      });
      // 先停用（复用站点控制面 draining），等 disabled 再删指针。
      if (deps.disableSite) {
        const state = await deps.disableSite(extensionId, options.actor);
        if (state === "draining") {
          const deadline = now().getTime() + drainTimeoutMs;
          while (deps.siteState?.(extensionId) === "draining") {
            if (now().getTime() >= deadline) {
              throw new ExtensionManagerError("MARKETPLACE_UNINSTALL_DRAINING", `扩展 ${extensionId} 仍有在途工作，停用未完成；稍后重试卸载`);
            }
            await sleep(drainPollMs);
          }
        }
      }
      const hasBackend = Boolean(record.requiresRestart);
      // C 方向下含后端的扩展卸载同样要重启才彻底生效。
      const needsRestart = hasBackend;
      commit((draft) => {
        delete draft.extensions[extensionId];
      });
      if (needsRestart) restartPendingRemoved.add(extensionId);
      board.update(job, { phase: "reload" });
      const outcome = await reload(extensionId, null, hasBackend);
      // 指针已删、扩展已卸载：清除数据失败不回滚卸载，只记日志（数据保留，重复卸载/清除是幂等的）。
      let purged: boolean | "failed" = false;
      if (options.purgeData && deps.purgeData) {
        try {
          await deps.purgeData(extensionId);
          purged = true;
        } catch (error) {
          purged = "failed";
          log({ event: "extension-purge-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        }
      }
      log({ event: "extension-uninstalled", extensionId, version: record.current, purgeData: purged });
      return outcome;
    })
  );
  return job.view;
}

export function rollback(ctx: ManagerContext, extensionId: string, options: { toVersion?: string; actor: string }): ExtensionInstallJobView {
  const { handle, board, requireHandle, switchPointer, reload } = ctx;
  if (!handle) return failedJob(ctx, "rollback", MARKETPLACE_LOCAL_FILE_SOURCE_ID, unavailableError(), extensionId);
  const record = handle.read().extensions[extensionId];
  if (!record) return failedJob(ctx, "rollback", MARKETPLACE_LOCAL_FILE_SOURCE_ID, new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`), extensionId);
  const target = options.toVersion ?? record.previous ?? null;
  const { job, existing } = board.create({ action: "rollback", sourceId: record.sourceId, dedupeKey: `rollback:${extensionId}`, extensionId, ...(target ? { version: target } : {}) });
  if (existing) return job.view;
  runJob(ctx, job, () =>
    board.serial(async () => {
      job.committing = true;
      board.update(job, { phase: "commit" });
      const latest = requireHandle().read().extensions[extensionId];
      if (!latest) throw new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`);
      if (target && latest.current === target) return "already-current";
      if (!target || (target !== latest.previous)) {
        throw new ExtensionManagerError("MARKETPLACE_NO_PREVIOUS_VERSION", target ? `${extensionId} 没有可回滚的版本 ${target}` : `${extensionId} 没有上一版本`);
      }
      const dir = requireHandle().layout.versionDir(extensionId, target);
      if (!fs.existsSync(dir)) throw new ExtensionManagerError("MARKETPLACE_NO_PREVIOUS_VERSION", `上一版本目录已不存在：${extensionId}@${target}`);
      const { backend } = switchPointer(extensionId, target, "rollback", options.actor);
      board.update(job, { phase: "reload" });
      // 回滚也是一次切换：含后端且子进程托管时对上一版本目录 swap（D10 第 5 步）；失败则指针切回原版本。
      try {
        return await reload(extensionId, dir, backend);
      } catch (error) {
        switchPointer(extensionId, latest.current, "rollback-failed-restore", "system");
        throw error;
      }
    })
  );
  return job.view;
}

/** 观察期一轮判定。 */
export async function observe(ctx: ManagerContext): Promise<void> {
  const { handle, deps, board, now, failureThreshold, healthFailures, commit, history, log } = ctx;
  if (!handle || ctx.status.closed) return;
  const state = handle.read();
  const at = now().getTime();
  for (const [extensionId, record] of Object.entries(state.extensions)) {
    if (record.state !== "observing" || record.restartPending) continue;
    const health = deps.health?.(extensionId) ?? "unknown";
    const failures = health === "failed" ? failureThreshold : health === "degraded" ? (healthFailures.get(extensionId) ?? 0) + 1 : 0;
    healthFailures.set(extensionId, failures);
    if (failures >= failureThreshold) {
      healthFailures.delete(extensionId);
      const rejected = record.current;
      if (!record.previous) {
        log({ event: "extension-observe-failed-no-previous", extensionId, version: rejected, health });
        await board.serial(async () => {
          commit((draft) => {
            const current = draft.extensions[extensionId];
            if (!current) return;
            draft.extensions[extensionId] = history({ ...current, state: "active", observeUntil: null, rejected: [...new Set([...(current.rejected ?? []), rejected])] }, { revision: draft.revision + 1, action: "observe-failed", version: rejected, actor: "system" });
          });
        });
        continue;
      }
      await autoRollback(ctx, extensionId, record.current, record.previous, `health:${health}`);
      continue;
    }
    if (record.observeUntil && Date.parse(record.observeUntil) <= at) {
      healthFailures.delete(extensionId);
      await board.serial(async () => {
        commit((draft) => {
          const current = draft.extensions[extensionId];
          if (!current || current.state !== "observing") return;
          draft.extensions[extensionId] = { ...current, state: "active", observeUntil: null };
        });
      });
    }
  }
}

/**
 * 自动回滚到上一版本（观察期健康失败 / 观察期内子进程崩溃共用）：指针切回 previous 并标记 rejected，
 * 再按分级重载（含后端且子进程托管 → 对上一版本目录 swap）。重载失败只记日志：指针已在 previous，
 * 下一次激活或重启时按它装配（不会再把坏版本切回来）。串行在 Manager 的提交队列里。
 */
export async function autoRollback(ctx: ManagerContext, extensionId: string, rejected: string, previous: string, reason: string): Promise<void> {
  const { board, handle, switchPointer, reload, log } = ctx;
  if (!handle) return;
  await board.serial(async () => {
    const { backend } = switchPointer(extensionId, previous, "auto-rollback", "system", rejected);
    const dir = handle.layout.versionDir(extensionId, previous);
    try {
      await reload(extensionId, dir, backend);
    } catch (error) {
      log({ event: "extension-auto-rollback-reload-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
    }
  });
  log({ event: "extension-auto-rollback", extensionId, from: rejected, to: previous, reason });
}

/**
 * 观察期内子进程崩溃（supervisor 回调；D7「观察期内的崩溃先回滚」）。
 * 记录处于 observing 且有上一版本 → 自动回滚并返回 true；否则 false（supervisor 继续按崩溃窗口处理）。
 */
export async function handleObservationCrash(ctx: ManagerContext, extensionId: string): Promise<boolean> {
  const { handle, healthFailures } = ctx;
  if (!handle || ctx.status.closed) return false;
  let record;
  try {
    record = handle.read().extensions[extensionId];
  } catch {
    return false;
  }
  if (!record || record.state !== "observing" || record.restartPending || !record.previous || record.previous === record.current) return false;
  healthFailures.delete(extensionId);
  await autoRollback(ctx, extensionId, record.current, record.previous, "crash");
  return true;
}

/** 清理保留期已过的孤儿版本目录。 */
export function sweep(ctx: ManagerContext): number {
  const { handle, deps, toolkit, now, retentionMs, log } = ctx;
  if (!handle) return 0;
  let removed = 0;
  const state = handle.read();
  const cutoff = now().getTime() - retentionMs;
  for (const orphan of toolkit.listOrphanVersionDirs(deps.managedRoot, state)) {
    try {
      if (fs.statSync(orphan.dir).mtimeMs > cutoff) continue;
      fs.rmSync(orphan.dir, { recursive: true, force: true });
      removed += 1;
      log({ event: "extension-version-swept", extensionId: orphan.extensionId, version: orphan.version });
    } catch (error) {
      log({ event: "extension-version-sweep-failed", extensionId: orphan.extensionId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return removed;
}
