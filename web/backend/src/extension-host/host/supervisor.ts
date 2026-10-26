/**
 * 崩溃、自动重启与熔断（change: 2026-10-21-isolate-extension-host-process，D7，任务 7.1–7.4）。
 *
 * 每个受管扩展一个 supervisor，订阅隔离控制器的 `onCrash`（控制器已按实例 id 去重、已撤 Provider 与路由、
 * RPC 层已让在途调用以 `extension-crashed` 失败）。supervisor 只决定**下一步**：
 *
 * 1. 观察期内（P1 Extension Manager 报告）且有上一版本 → 交给 Manager 回滚（优先于隔离）；
 * 2. 滑动窗口 5 分钟内第 3 次崩溃 → `quarantined`（停止重启，诊断 `crash-loop`）；
 * 3. 否则按指数退避（1s → 60s，±20% 抖动）重启同一版本目录与当前配置；ready 后稳定 60s 退避归零。
 *
 * 解除隔离：`unquarantine()`（管理员）或 `reset()`（升级到其他版本）清空窗口后重新激活；`desiredEnabled` 不改写。
 */
import type { IsolatedController } from "./controller.js";
import type { InstanceExit } from "./manager.js";

export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_LOOP_THRESHOLD = 3;
export const RESTART_BACKOFF_INITIAL_MS = 1_000;
export const RESTART_BACKOFF_MAX_MS = 60_000;
export const RESTART_STABLE_MS = 60_000;
export const RESTART_JITTER = 0.2;

export type SupervisorState = "idle" | "running" | "restarting" | "quarantined";

export type SupervisorSnapshot = {
  state: SupervisorState;
  /** 窗口内的崩溃次数。 */
  crashCount: number;
  quarantinedAt: string | null;
  /** 下一次重启的延迟（仅 restarting）。 */
  nextRestartMs: number | null;
};

export type SupervisorOptions = {
  controller: IsolatedController;
  log: (event: Record<string, unknown>) => void;
  /** 观察期内崩溃：返回 true 表示 Manager 已接手回滚（supervisor 不再重启 / 隔离）。 */
  onObservationCrash?: (extensionId: string, exit: InstanceExit) => Promise<boolean> | boolean;
  /**
   * 进入 / 解除隔离（站点控制面投影 `quarantined`，D7）。控制面负责实例的释放与重新激活：
   * 进入隔离时经站点门禁 release 代理插件；解除时按 desiredEnabled 重新协调（启用即重新激活）。
   * 未接控制面（嵌入式 / 测试）时 supervisor 自己重新激活。
   */
  onQuarantine?: (extensionId: string, diagnostic: { code: "crash-loop"; message: string }) => void | Promise<unknown>;
  onUnquarantine?: (extensionId: string, actor: string) => void | Promise<unknown>;
  /** 状态变化（设置面 crashCount / quarantinedAt）。 */
  onChange?: (snapshot: SupervisorSnapshot) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type ExtensionSupervisor = {
  /** 控制器的 onCrash 接到这里。 */
  handleCrash(exit: InstanceExit): void;
  /** 激活成功（含首次与每次重启）：开始稳定计时。 */
  handleActivated(): void;
  /** 宿主主动停用：取消待重启，保留窗口。 */
  handleDeactivated(): void;
  quarantined(): boolean;
  /** 管理员解除隔离：清空窗口；有控制面时由它重新激活，否则自己激活。 */
  unquarantine(actor?: string): Promise<void>;
  /** 换版本（升级 / 回滚）：清空窗口与退避；隔离中则解除（不自动激活，由调用方切换实例）。 */
  reset(): void;
  snapshot(): SupervisorSnapshot;
  dispose(): void;
};

/** 第 n 次（从 1 开始）连续重启的基础延迟。 */
export function backoffDelay(attempt: number): number {
  return Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempt - 1));
}

export function createExtensionSupervisor(options: SupervisorOptions): ExtensionSupervisor {
  const { controller } = options;
  const extensionId = controller.extensionId;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = (event: Record<string, unknown>) => options.log({ extension: extensionId, ...event });

  let state: SupervisorState = "idle";
  let crashes: number[] = [];
  let quarantinedAt: string | null = null;
  let attempt = 0;
  let restartTimer: unknown = null;
  let stableTimer: unknown = null;
  let nextRestartMs: number | null = null;
  let disposed = false;

  const snapshot = (): SupervisorSnapshot => ({
    state,
    crashCount: crashes.filter((at) => now() - at <= CRASH_WINDOW_MS).length,
    quarantinedAt,
    nextRestartMs
  });
  const changed = () => options.onChange?.(snapshot());
  const clearTimers = () => {
    if (restartTimer !== null) clearTimer(restartTimer);
    if (stableTimer !== null) clearTimer(stableTimer);
    restartTimer = null;
    stableTimer = null;
    nextRestartMs = null;
  };

  const quarantine = () => {
    clearTimers();
    state = "quarantined";
    quarantinedAt = new Date(now()).toISOString();
    const message = `${CRASH_WINDOW_MS / 60_000} 分钟内崩溃 ${CRASH_LOOP_THRESHOLD} 次，已停止自动重启`;
    log({ event: "extension-host-quarantined", crashCount: snapshot().crashCount, code: "crash-loop" });
    changed();
    // 先停止自动重启（上面已清计时器），再交给控制面：它会 release 代理插件，避免与重启竞争。
    void Promise.resolve(options.onQuarantine?.(extensionId, { code: "crash-loop", message })).catch((error: unknown) =>
      log({ event: "extension-host-quarantine-projection-failed", message: error instanceof Error ? error.message : String(error) })
    );
  };

  const restart = () => {
    restartTimer = null;
    nextRestartMs = null;
    if (disposed || state !== "restarting") return;
    log({ event: "extension-host-restarting", attempt, directory: controller.directory() });
    controller.activate(controller.values(), controller.directory()).then(
      () => supervisor.handleActivated(),
      (error: unknown) => {
        // 激活失败等价于又一次崩溃（计入窗口），走同一判定。
        log({ event: "extension-host-restart-failed", attempt, message: error instanceof Error ? error.message : String(error) });
        supervisor.handleCrash({ instanceId: "restart-failed", reason: "exit", exitCode: null, signal: null, message: "restart-failed" });
      }
    );
  };

  const supervisor: ExtensionSupervisor = {
    handleCrash(exit) {
      if (disposed || state === "quarantined") return;
      clearTimers();
      const at = now();
      crashes = [...crashes.filter((time) => at - time <= CRASH_WINDOW_MS), at];
      log({ event: "extension-host-crashed", reason: exit.reason, exitCode: exit.exitCode, signal: exit.signal, crashCount: crashes.length });
      state = "restarting";
      changed();
      void (async () => {
        // 观察期内崩溃：Manager 有上一版本时回滚（回滚本身是一次 swap），优先于隔离。
        const handled = await Promise.resolve(options.onObservationCrash?.(extensionId, exit)).catch(() => false);
        if (disposed || state !== "restarting") return;
        if (handled) {
          log({ event: "extension-host-crash-handed-to-rollback" });
          state = "idle";
          changed();
          return;
        }
        if (crashes.length >= CRASH_LOOP_THRESHOLD) {
          quarantine();
          return;
        }
        attempt += 1;
        const base = backoffDelay(attempt);
        const delay = Math.round(base * (1 + (random() * 2 - 1) * RESTART_JITTER));
        nextRestartMs = delay;
        restartTimer = setTimer(restart, delay);
        changed();
      })();
    },
    handleActivated() {
      if (disposed) return;
      clearTimers();
      state = "running";
      // 稳定运行一段时间后退避归零（窗口里的崩溃仍按时间自然过期）。
      stableTimer = setTimer(() => {
        stableTimer = null;
        attempt = 0;
      }, RESTART_STABLE_MS);
      changed();
    },
    handleDeactivated() {
      if (state === "quarantined") return;
      clearTimers();
      state = "idle";
      changed();
    },
    quarantined: () => state === "quarantined",
    async unquarantine(actor = "system:extension-host") {
      if (state !== "quarantined") return;
      crashes = [];
      attempt = 0;
      quarantinedAt = null;
      state = "idle";
      log({ event: "extension-host-unquarantined", actor });
      changed();
      if (options.onUnquarantine) {
        // 控制面按 desiredEnabled 重新协调：启用 → 经站点门禁 acquire → 代理插件 apply → 激活。
        await options.onUnquarantine(extensionId, actor);
        return;
      }
      await controller.activate(controller.values(), controller.directory());
      supervisor.handleActivated();
    },
    reset() {
      clearTimers();
      const wasQuarantined = state === "quarantined";
      crashes = [];
      attempt = 0;
      quarantinedAt = null;
      state = controller.active() ? "running" : "idle";
      if (wasQuarantined) {
        void Promise.resolve(options.onUnquarantine?.(extensionId, "system:extension-upgrade")).catch((error: unknown) =>
          log({ event: "extension-host-unquarantine-projection-failed", message: error instanceof Error ? error.message : String(error) })
        );
      }
      changed();
    },
    snapshot,
    dispose() {
      disposed = true;
      clearTimers();
    }
  };
  return supervisor;
}
