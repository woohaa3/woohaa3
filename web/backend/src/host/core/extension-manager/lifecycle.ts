/**
 * 生命周期：启动恢复、卸载、回滚、观察期判定与孤儿版本清理（从 manager.ts 拆出）。
 * 所有共享状态经 `ManagerContext` 显式传入。
 */
import fs from "node:fs";
import { MARKETPLACE_LOCAL_FILE_SOURCE_ID, type ExtensionInstallJobView } from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";
import { failedJob, runJob, unavailableError } from "./install-pipeline.js";
import type { ManagerContext } from "./manager-context.js";
import { withVersionEvidence } from "./version-evidence.js";

/** 周期性信任复核的默认间隔：与签名元数据刷新周期一致（1 小时）。 */
const DEFAULT_TRUST_CHECK_MS = 60 * 60 * 1000;

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
          if (!record || record.quarantine) continue;
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
      // 只有 hostPlugin 能运行期撤下；站点 backend 工厂随后仍提示重启。
      const hotSwappable = record.hotSwappable !== false;
      const needsRestart = hasBackend && (!ctx.deps.runtime?.available() || !hotSwappable);
      commit((draft) => {
        delete draft.extensions[extensionId];
      });
      if (needsRestart) restartPendingRemoved.add(extensionId);
      board.update(job, { phase: "reload" });
      // 受管版本覆盖过内置版本：卸载后回到内置版本（能热切换就当场装回，否则等下一次启动）。
      const builtin = deps.builtins?.().get(extensionId);
      const managedDir = handle.layout.versionDir(extensionId, record.current);
      let outcome: Awaited<ReturnType<typeof reload>>;
      try {
        if (builtin?.requiresBackend && builtin.hotSwappable) {
          outcome = await reload(extensionId, builtin.directory, true, { previousDirectory: managedDir, hotSwappable: true });
        } else if (builtin?.requiresBackend) {
          // 站点后端内置扩展没有运行期装配入口：撤下受管实例，下一次启动按内置目录装配。
          if (deps.runtime?.available()) await deps.runtime.remove(extensionId);
          restartPendingRemoved.add(extensionId);
          outcome = await reload(extensionId, null, false);
        } else if (builtin) {
          if (record.requiresRestart && deps.runtime?.available()) await deps.runtime.remove(extensionId);
          outcome = await reload(extensionId, builtin.directory, false);
        } else {
          outcome = await reload(extensionId, null, hasBackend, { hotSwappable });
        }
      } catch (error) {
        // 指针已经删除：卸载本身不回滚，装回内置失败只记日志（下次启动仍会扫描内置根）。
        log({ event: "extension-uninstall-reload-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        outcome = "installed";
      }
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
      await ctx.toolkit.verifyManagedActivation?.({dir,record:withVersionEvidence(latest,target),fresh:true});
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
  await enforceTrust(ctx);
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
    const dir = handle.layout.versionDir(extensionId, previous);
    const record=handle.read().extensions[extensionId];
    try { await ctx.toolkit.verifyManagedActivation?.({dir,record:record?withVersionEvidence(record,previous):undefined}); }
    catch(error) { await quarantine(ctx,extensionId,error);return; }
    const { backend } = switchPointer(extensionId, previous, "auto-rollback", "system", rejected);
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

/**
 * 隔离一个未通过信任校验的扩展：先落状态，再尽力停用 / 撤下运行期实例 / 撤浏览器产物。
 * 清理动作只在首次进入隔离时执行；重试只为失败的清理补一次，避免每轮观察都全量重复。
 */
async function quarantine(ctx:ManagerContext,extensionId:string,error:unknown):Promise<void>{
 const record=ctx.handle?.read().extensions[extensionId];if(!record)return;
 const message=error instanceof Error?error.message:String(error);
 // 首次隔离：落状态并清理一次。已经隔离且清理成功（restartPending=false）：不再重复执行。
 if(record.quarantine&&record.quarantineCleanupPending===false)return;
 if(!record.quarantine){
  ctx.commit(draft=>{const current=draft.extensions[extensionId];if(current&&!current.quarantine)draft.extensions[extensionId]={...current,quarantine:message,quarantineCleanupPending:true,state:"active",observeUntil:null};});
  ctx.log({event:"extension-quarantined",extensionId,message});
 }
 const outcomes=await Promise.allSettled([
  Promise.resolve().then(()=>ctx.deps.disableSite?.(extensionId,"trust-revocation")),
  Promise.resolve().then(()=>ctx.deps.runtime?.remove(extensionId)),
  Promise.resolve().then(()=>ctx.deps.publishBrowserRelease?.({remove:[extensionId]}))
 ]);
 let failed=false;
 for(const outcome of outcomes)if(outcome.status==="rejected"){
  failed=true;
  ctx.log({event:"extension-quarantine-restart-required",extensionId,message:String(outcome.reason)});
 }
 ctx.commit(draft=>{const latest=draft.extensions[extensionId];if(latest)draft.extensions[extensionId]={...latest,quarantineCleanupPending:failed,restartPending:failed||Boolean(latest.requiresRestart&&(!ctx.deps.runtime?.available()||latest.hotSwappable===false))};});
 ctx.log({event:"extension-quarantine-cleanup",extensionId,failed});
}

/**
 * 周期性信任复核。完整验签会同步读取整个版本目录（含 WASM / 字体）并重算摘要，
 * 所以每个扩展按 trustCheckMs 限流（缺省 1 小时，与信任元数据刷新周期一致）：
 * 新出现或换了版本的记录立即检查，其余到点再查；同一时刻只跑一轮，
 * 避免 observe 重入后并发隔离。
 */
type TrustSweep = { inFlight: Promise<void> | null; checked: Map<string, { stamp: string; at: number }> };
const trustSweeps = new WeakMap<ManagerContext, TrustSweep>();
async function enforceTrust(ctx:ManagerContext):Promise<void>{
 const handle=ctx.handle;
 const verify=ctx.toolkit.verifyManagedActivation;
 if(!handle||!verify)return;
 let book=trustSweeps.get(ctx);
 if(!book){book={inFlight:null,checked:new Map()};trustSweeps.set(ctx,book);}
 const current=book;
 if(current.inFlight)return current.inFlight;
 const interval=ctx.deps.trustCheckMs??DEFAULT_TRUST_CHECK_MS;
 current.inFlight=(async()=>{
  // 信任元数据每轮只算一次；读不出来说明信任配置本身坏了，按扩展逐个隔离并说明原因。
  let trustStamp: string|null = null;
  let stampError: unknown = null;
  try { trustStamp=ctx.toolkit.trustStateStamp?.()??""; } catch(error) { stampError=error; }
  const state=handle.read();
  for(const [id,record] of Object.entries(state.extensions)){
   if(ctx.status.closed)return;
   if(record.quarantine){await ctx.board.serial(()=>quarantine(ctx,id,new Error(record.quarantine)));continue;}
   if(trustStamp===null){await ctx.board.serial(()=>quarantine(ctx,id,stampError));continue;}
   const stamp=record.current+":"+(record.filesDigest??"")+":"+trustStamp;
   const previous=current.checked.get(id);
   const at=ctx.now().getTime();
   if(previous&&previous.stamp===stamp&&at-previous.at<interval)continue;
   try{
    await verify({dir:handle.layout.versionDir(id,record.current),record});
    current.checked.set(id,{stamp,at});
   }catch(error){await ctx.board.serial(()=>quarantine(ctx,id,error));}
  }
 })();
 try{await current.inFlight}finally{current.inFlight=null}
}
