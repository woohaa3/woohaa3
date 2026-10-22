/**
 * 游戏炼丹炉后台收尾 worker（任务 6.9 / 6.10）
 * （change: 2026-10-10-add-game-furnace-extension，design D9）。
 *
 * 完成后的构建组装由后端**继续**，不要求浏览器轮询：即使没有前端在线，worker 也会按固定
 * 间隔扫描本 owner 的项目，对其在途生成查询 Task 状态并调用既有 `runFinalize` 收尾——成功即
 * 原子登记不可变构建，失败/取消即持久化 disposition 并结算工作。后端重启后，实例重新装配时
 * `start()` 会立刻处理一次已恢复的在途生成（recovery），随后继续轮询。
 *
 * 纯编排：只用 `Runtime` 的进程内 Task/Media facade 与既有 `runFinalize`；不知道宿主实现，
 * 也不产生第二事实源（收尾结果仍写回内容寻址项目）。
 */
import type { Runtime } from "./support.js";
import type { GameFurnaceState } from "../shared.js";
import { runFinalize } from "./flows.js";

export type FinalizeWorker = {
  /** 启动（幂等）：立即处理一次恢复，再按间隔轮询。 */
  start: () => void;
  /** 停止（幂等）：清理定时器，不再处理。 */
  stop: () => void;
  /** 处理此刻所有在途生成；返回本轮处理的（成功/终态）数量。测试可 await。 */
  sweep: () => Promise<{ processed: number }>;
  /** 项目恢复/变更后请求尽快处理一次（自动，不阻塞调用方）。 */
  kick: () => void;
  /** 当前是否在运行。 */
  running: () => boolean;
};

/**
 * 挑选仍需收尾的生成：站点模型生成（非 Agent 源码）、尚未登记候选构建、且未处于终态。
 * Agent 提交是源码编译工作，不对应站点模型 Task，不在此处理。
 */
export function pendingFinalizations(state: GameFurnaceState): GameFurnaceState["generations"] {
  return state.generations.filter((generation) =>
    generation.origin !== "agent"
    && !generation.executionDetached
    && typeof generation.workerTaskKey === "string" && generation.workerTaskKey !== ""
    && !generation.candidateBuildId
    && generation.disposition !== "cancelled"
    && generation.disposition !== "failed"
    && generation.disposition !== "discarded"
  );
}

export function createFinalizeWorker(rt: Runtime, options: { intervalMs?: number } = {}): FinalizeWorker {
  const intervalMs = options.intervalMs ?? 5_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<{ processed: number }> | null = null;
  let stopped = false;

  const runSweep = async (): Promise<{ processed: number }> => {
    let processed = 0;
    // 快照键：sweep 期间项目可能被删除/替换；按最新快照身份继续，避免误关联。
    for (const [key, snapshot] of [...rt.projects]) {
      const pending = pendingFinalizations(snapshot.state);
      for (const generation of pending) {
        const latest = rt.projects.get(key);
        if (!latest || latest.projectStorageKey !== snapshot.projectStorageKey) break;
        try {
          const result = await runFinalize(rt, { canvasId: latest.canvasId, nodeId: latest.nodeId, generationId: generation.generationId });
          if (result.ok === true && (result.state === "succeeded" || result.state === "failed" || result.state === "cancelled")) {
            processed += 1;
            const finalized = rt.projects.get(key);
            if (finalized && finalized.projectStorageKey !== latest.projectStorageKey
              && finalized.state.projectId === latest.state.projectId && finalized.inputHash === latest.inputHash) {
              // Preserve only this automatic advance, not arbitrary saves/history changes.
              rt.projects.set(key, { ...finalized, recoveredFromStorageKeys: [...new Set([
                ...(latest.recoveredFromStorageKeys ?? []), latest.projectStorageKey
              ])] });
            }
          }
        } catch (error) {
          // 单个生成收尾失败不影响其它项目/生成；worker 自身幂等，下轮重试。
          rt.log({ event: "game-furnace-finalize-worker-error", generationId: generation.generationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { processed };
  };

  const sweep = (): Promise<{ processed: number }> => {
    if (inFlight) return inFlight.then(() => sweep());
    const current = runSweep();
    const tracked = current.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  return {
    start() {
      if (stopped || timer) return;
      // recovery：重启/启动时立刻处理一次已恢复的在途生成，再进入轮询。
      void sweep();
      timer = setInterval(() => { void sweep(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    sweep,
    kick() { void sweep(); },
    running: () => timer !== undefined
  };
}
