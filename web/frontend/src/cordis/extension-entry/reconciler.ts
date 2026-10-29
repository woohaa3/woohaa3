/**
 * 站点插件前端入口 reconciliation（异步加载版）
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 4.3 / design D5；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 4.1/4.2；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 5.4/5.5 / design D7/D9：
 *  入口改为**异步 loadDescriptor**，本 controller 维护 epoch/pending/owned/closing/failedEpoch，
 *  只有最新实际 active 才允许安装，旧 epoch 的迟到结果不得安装或覆盖新诊断）。
 *
 * 前端 controller 按**服务端权威状态** reconcile 站点应用插件的可信前端入口：
 * - 服务端 `actualState === "active"` 允许加载并装配；代码/CSS 就绪且 Fiber apply 成功才 active；
 * - 停用（或 failed/degraded/unconfigured/draining）时释放该入口的 fiber（幂等、可等待）；
 * - 只 reconcile **站点插件入口**，绝不重置核心宿主、画布会话或 browser-local 插件装配；
 * - 重复相同权威通知不推进 epoch、不重复加载/apply；相同 failed epoch 需显式重试或新激活 epoch；
 * - **加载失败自动有界重试**（2026-10-28 现场：宿主重启窗口里的 5xx 让入口永久失联）：入口代码/CSS 经宿主
 *   同源代理取，宿主重启窗口里会拿到 5xx；那种一次性失败不得把入口永久钉在 load-failed 上
 *   （否则只能刷新页面才恢复）。重试预算按入口计，用尽后回到「同一 epoch 不自动重试」语义；
 * - 旧 owner 异步释放完成前不创建替代 owner；partial apply 失败主动 dispose + await 回滚。
 *
 * 实现地址来自发布 loader；本 controller 只按 extensionId 决定是否加载已登记入口。
 */
import type { Context, Fiber } from "@deepseek-ai/cordis";
import type { ApplicationExtensionStatus } from "@woohaa3/contracts";
import { fiberStatus } from "../diagnostics.js";
import { scopedExtensionServices } from "../slots.js";
import type { ExtensionFaultService } from "../extension-faults.js";
import type { ApplicationExtensionFrontendEntryRegistry, RegisteredApplicationExtensionEntry } from "./contract.js";

export type ApplicationExtensionEntryReconcilerOptions = {
  registry: ApplicationExtensionFrontendEntryRegistry;
  /** 安装 fiber 的目标 scope Context。 */
  ctx: Context;
  /** 异步加载实现的函数（缺省 registry entry.loadDescriptor）；测试可注入。 */
  loadDescriptor?: (entry: RegisteredApplicationExtensionEntry) => Promise<{ plugin: () => import("@deepseek-ai/cordis").Plugin }>;
  /** 该 scope 是否仍然存活（page dispose 后为 false）。 */
  isScopeAlive?: () => boolean;
  logger?: (event: Record<string, unknown>) => void;
  /**
   * 加载失败后的自动重试间隔（毫秒，按序消费）；缺省 1s / 3s / 6s。
   *
   * 只用于**加载**失败（descriptor 取不到），不用于插件构造或 apply 失败——后者是确定性失败。
   * 传空数组即关闭自动重试。
   */
  retryDelaysMs?: readonly number[];
};

/** 单个入口的运行时诊断。 */
export type ApplicationExtensionEntryDiagnostic = {
  extensionId: string;
  status:
    | "registered"
    | "loading"
    | "load-failed"
    | "waiting"
    | "active"
    | "failed"
    | "unloading"
    | "disposed";
  missingServices: string[];
  error: string | null;
};

export type ApplicationExtensionEntryReconciler = {
  /** 按状态集合 reconcile（幂等；重复相同通知不重复加载/apply）。 */
  reconcile: (plugins: readonly ApplicationExtensionStatus[]) => void;
  /** 显式重试某入口（解除相同 failed epoch 抑制）。 */
  retry: (extensionId: string) => void;
  /** 当前已装配（或正在装配）的插件 id。 */
  activeExtensionIds: () => string[];
  /** 每个入口的运行状态与缺失依赖诊断。 */
  diagnostics: () => ApplicationExtensionEntryDiagnostic[];
  /** 释放全部 fiber（page scope dispose）；返回可等待的清理 Promise。 */
  dispose: () => Promise<void>;
};

type EntryState = {
  /** 最新权威 actual active。 */
  desired: boolean;
  /** 激活 epoch：停用、失效、重新激活都推进。 */
  epoch: number;
  /** 当前 pending 加载请求身份（用于 finally 比较，旧请求不删新记录）。 */
  pending: object | null;
  /** 已安装 owner（含 epoch）。 */
  owned: { fiber: Fiber; epoch: number } | null;
  /** 正在进行的异步释放。 */
  closing: Promise<void> | null;
  /** 已报告失败的 epoch（相同 epoch 不自动重试）。 */
  failedEpoch: number | null;
  /** 熔断注销（change: 2026-10-21-harden-extension-fault-isolation，design D3）。 */
  detachFaults: (() => void) | null;
  /** 当前 epoch 内已用掉的自动重试次数（显式 retry 清零）。 */
  retries: number;
  /** 待触发的自动重试定时器。 */
  retryTimer: unknown | null;
  /** 可公开诊断。 */
  status: ApplicationExtensionEntryDiagnostic["status"];
  error: string | null;
};

/**
 * 加载失败后的自动重试间隔（毫秒）：第 1 次 1s、第 2 次 3s、第 3 次 6s，之后交给显式重试。
 *
 * 只用来盖住宿主重启/短暂 5xx 的窗口（dev 的宿主 watch、受管扩展安装后的受控重启）；
 * 不是心跳，不会无限重试。
 */
export const DEFAULT_LOAD_RETRY_DELAYS_MS = [1_000, 3_000, 6_000] as const;

export function createApplicationExtensionEntryReconciler(
  options: ApplicationExtensionEntryReconcilerOptions
): ApplicationExtensionEntryReconciler {
  const log = options.logger ?? (() => undefined);
  const isScopeAlive = options.isScopeAlive ?? (() => true);
  const states = new Map<string, EntryState>();
  let disposed = false;

  const stateOf = (extensionId: string): EntryState => {
    let state = states.get(extensionId);
    if (!state) {
      state = {
        desired: false,
        epoch: 0,
        pending: null,
        owned: null,
        closing: null,
        failedEpoch: null,
        detachFaults: null,
        retries: 0,
        retryTimer: null,
        status: "registered",
        error: null
      };
      states.set(extensionId, state);
    }
    return state;
  };

  const loader = options.loadDescriptor ?? ((entry) => entry.loadDescriptor());
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_LOAD_RETRY_DELAYS_MS;

  const clearRetry = (state: EntryState): void => {
    if (state.retryTimer === null) return;
    clearTimeoutRef(state.retryTimer);
    state.retryTimer = null;
  };

  /**
   * 安排一次自动重试；返回 false 表示预算已用尽（调用方记 failedEpoch，回到显式重试语义）。
   *
   * 只用于**加载**失败：加载没有副作用，代价是再发一次请求；插件构造/apply 失败是确定性
   * 失败，重试只会重复同一次抛错，仍走显式 retry。
   */
  const scheduleRetry = (extensionId: string, state: EntryState, epoch: number): boolean => {
    if (disposed || !isScopeAlive()) return false;
    const delay = retryDelaysMs[state.retries];
    if (delay === undefined) return false;
    state.retries += 1;
    clearRetry(state);
    state.retryTimer = setTimeoutRef(() => {
      state.retryTimer = null;
      if (disposed || !isScopeAlive()) return;
      if (!state.desired || state.epoch !== epoch) return;
      if (state.owned || state.pending || state.closing) return;
      log({ event: "site-extension-entry-load-retry", extensionId, attempt: state.retries });
      void enter(extensionId, epoch);
    }, delay);
    return true;
  };

  const enter = async (extensionId: string, epoch: number): Promise<void> => {
    const state = stateOf(extensionId);
    if (disposed || !isScopeAlive()) return;
    // 已有 owner / 正在释放：不创建第二个 owner。
    if (state.owned || state.closing) return;
    if (state.pending) return;
    const registryEntry = options.registry.get(extensionId);
    if (!registryEntry) return;

    const request = {};
    state.pending = request;
    state.status = "loading";
    state.error = null;
    try {
      const descriptor = await loader(registryEntry);
      // 复验资格：scope 存活、epoch 未变、仍 desired、无 owner/closing。
      if (disposed || !isScopeAlive()) return;
      if (state.epoch !== epoch) return;
      if (!state.desired) return;
      if (state.owned || state.closing) return;
      // 同步区间内再次检查，再创建 Fiber 并立即登记 owner。
      if (state.epoch !== epoch || !state.desired || state.owned || state.closing) return;
      let fiber: Fiber;
      // 来源身份由宿主盖章（design D1）：扩展经代理 slots 注册，嵌套插件同样继承。
      const scoped = scopedExtensionServices(options.ctx, extensionId);
      const assemblyEpoch = scoped.epoch;
      try {
        fiber = options.ctx.extend({ slots: scoped.slots, dialogs: scoped.dialogs } as never).plugin(descriptor.plugin()) as Fiber;
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : "插件构造失败";
        state.failedEpoch = epoch;
        log({ event: "site-extension-entry-failed", extensionId, message: state.error });
        return;
      }
      state.owned = { fiber, epoch };
      state.retries = 0;
      clearRetry(state);
      state.status = "waiting";
      attachFaults(extensionId, fiber, assemblyEpoch, registryEntry.metadata.required === true);
      void fiber.await().catch((error: unknown) => {
        // apply 失败：主动 dispose + await 回滚，避免留下部分 contribution。
        void rollback(extensionId, fiber, error);
      });
    } catch (error) {
      if (state.epoch === epoch) {
        state.status = "load-failed";
        state.error = error instanceof Error ? error.message : "功能加载失败，请重试";
        // 一次性失败（宿主重启窗口的 5xx、CSS 超时）自动重试；预算用尽才记 failedEpoch。
        if (!scheduleRetry(extensionId, state, epoch)) state.failedEpoch = epoch;
      }
      log({ event: "site-extension-entry-load-failed", extensionId, message: state.error });
    } finally {
      // 只在仍是当前请求时清理（旧请求 finally 不删新 pending 记录）。
      if (state.pending === request) state.pending = null;
    }
  };

  /**
   * 向 App 级 `extensionFaults` 登记本次装配（design D3）：
   * - 熔断：标记 failed（原因 render-fault-threshold）、failedEpoch=当前 epoch 并释放 fiber，
   *   同一 epoch 内不自动重试；
   * - 重新加载：等价显式 `retry`（推进 epoch 后重新装配）。
   */
  const attachFaults = (extensionId: string, fiber: Fiber, assemblyEpoch: number, required: boolean) => {
    const faults = options.ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined;
    if (!faults) return;
    const state = stateOf(extensionId);
    state.detachFaults?.();
    state.detachFaults = faults.attach(extensionId, {
      required,
      epoch: assemblyEpoch,
      trip: (reason) => {
        if (state.owned?.fiber !== fiber) return;
        log({ event: "site-extension-entry-failed", extensionId, message: reason });
        void disposeOne(extensionId).then(() => {
          state.status = "failed";
          state.error = "本次会话已停用：渲染错误过多";
          state.failedEpoch = state.epoch;
        });
        // disposeOne 的 finally 会在 desired 时重新装配；熔断语义是同一 epoch 不重试。
        state.failedEpoch = state.epoch;
      },
      reload: () => retryOne(extensionId)
    });
  };

  const rollback = async (extensionId: string, fiber: Fiber, error: unknown): Promise<void> => {
    const state = stateOf(extensionId);
    log({ event: "site-extension-entry-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
    try {
      await fiber.dispose();
    } catch (disposeError) {
      log({ event: "site-extension-entry-dispose-failed", extensionId, message: disposeError instanceof Error ? disposeError.message : String(disposeError) });
    }
    if (state.owned?.fiber === fiber) {
      state.owned = null;
      state.detachFaults?.();
      state.detachFaults = null;
      state.status = "failed";
      state.error = error instanceof Error ? error.message : "插件激活失败";
      state.failedEpoch = state.epoch;
    }
  };

  const disposeOne = (extensionId: string): Promise<void> => {
    const state = stateOf(extensionId);
    if (state.closing) return state.closing;
    const owned = state.owned;
    if (!owned) return Promise.resolve();
    state.owned = null;
    state.detachFaults?.();
    state.detachFaults = null;
    state.status = "unloading";
    const pending = Promise.resolve(owned.fiber.dispose())
      .catch((error: unknown) => {
        log({ event: "site-extension-entry-dispose-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        state.closing = null;
        state.status = state.desired ? "loading" : "registered";
        // 释放完成后，若最新权威状态仍要求 active，则按最新 epoch 重新装配；
        // 当前 epoch 已失败（例如渲染熔断）时不自动重试，等显式 retry 或新激活 epoch。
        if (!disposed && state.desired && isScopeAlive() && !state.owned && state.failedEpoch !== state.epoch) {
          void enter(extensionId, state.epoch);
        }
      });
    state.closing = pending;
    return pending;
  };

  const reconcile: ApplicationExtensionEntryReconciler["reconcile"] = (plugins) => {
    if (disposed) return;
    for (const status of plugins) options.ctx.persistentSurfaces?.setEnabled(status.extensionId, status.actualState === "active");
    const activeIds = new Set(plugins.filter((status) => status.actualState === "active").map((status) => status.extensionId));
    for (const extensionId of activeIds) {
      const entry = options.registry.get(extensionId);
      // 只 reconcile 服务端状态驱动入口；常驻（always）由 kernel 清单装配，避免双重 owner。
      if (!entry || entry.metadata.activation !== "server-active") continue;
      const state = stateOf(extensionId);
      if (!state.desired) {
        state.desired = true;
        state.epoch += 1;
        state.failedEpoch = null;
        state.retries = 0;
        clearRetry(state);
        void enter(extensionId, state.epoch);
        continue;
      }
      // 重复相同通知：不推进 epoch。只在**空转**时补一次装载——覆盖两种情况：
      // 1) 首次 reconcile 时发布目录还没有这个 id（入口后来经热登记注册进来）；
      // 2) 上一次装载的迟到结果被 epoch 变化作废，而当前没有 pending/owner。
      if (state.owned || state.pending || state.closing || state.retryTimer) continue;
      if (state.failedEpoch === state.epoch) continue;
      void enter(extensionId, state.epoch);
    }
    // 非 active：失效并释放。
    for (const [extensionId, state] of states) {
      if (activeIds.has(extensionId)) continue;
      if (!state.desired && !state.owned && !state.pending && !state.closing) continue;
      state.desired = false;
      state.epoch += 1; // 使旧 pending 加载失效
      state.failedEpoch = null;
      state.retries = 0;
      clearRetry(state);
      if (state.owned) void disposeOne(extensionId);
      else if (!state.pending) state.status = "registered";
    }
  };

  function retryOne(extensionId: string): void {
    const state = stateOf(extensionId);
    state.failedEpoch = null;
    state.error = null;
    state.retries = 0; // 显式重试重新给满自动重试预算
    clearRetry(state);
    state.status = "registered";
    if (state.desired && !state.owned && !state.closing && !state.pending) {
      state.epoch += 1;
      void enter(extensionId, state.epoch);
    }
  }

  return {
    reconcile,
    retry: retryOne,
    activeExtensionIds: () => [...states.entries()].filter(([, state]) => state.owned).map(([id]) => id),
    diagnostics: () =>
      [...states.entries()].map(([extensionId, state]) => {
        let status = state.status;
        if (state.owned) {
          const fiberState = fiberStatus(state.owned.fiber);
          status = fiberState === "active" ? "active" : fiberState === "failed" ? "failed" : "waiting";
        }
        return {
          extensionId,
          status,
          missingServices: state.owned ? Object.keys(state.owned.fiber.inject).filter((name) => !state.owned!.fiber.store?.[name]) : [],
          error: state.error
        };
      }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // 使所有 pending 加载失效，再释放已创建 Fiber。
      for (const state of states.values()) {
        state.desired = false;
        state.epoch += 1;
        clearRetry(state);
      }
      await Promise.allSettled([...states.keys()].map((extensionId) => disposeOne(extensionId)));
      await Promise.allSettled([...states.values()].map((state) => state.closing).filter((p): p is Promise<void> => p !== null));
      for (const state of states.values()) {
        state.detachFaults?.();
        state.detachFaults = null;
        state.owned = null;
        state.pending = null;
        state.closing = null;
        state.retryTimer = null;
        state.retries = 0;
      }
      states.clear();
    }
  };
}

/** setTimeout 引用；测试可用 vitest fake timers。 */
function setTimeoutRef(callback: () => void, ms: number): unknown {
  return (globalThis as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout(callback, ms);
}

function clearTimeoutRef(handle: unknown): void {
  (globalThis as { clearTimeout: (h: unknown) => void }).clearTimeout(handle);
}
