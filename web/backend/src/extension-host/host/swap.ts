/**
 * 蓝绿切换（change: 2026-10-21-isolate-extension-host-process，D10，任务 8.1）。
 *
 * `swap(nextDirectory)`：
 * 1. 起新（绿）：以新版本目录 fork，走完 hello → 激活 → 首次健康；期间旧实例（蓝）继续服务；
 * 2. 检查：时限内 ready 且首次健康不是 failed（degraded 允许）；失败 → 绿已停止，蓝不动，抛 `MARKETPLACE_SWAP_FAILED`；
 * 3. 切换：`controller.commit(green)` 在同一 tick 原子替换 Provider 注册与路由目标；
 * 4. 排空：蓝不接新调用（桩与路由已指向绿），在途 RPC 继续完成；清零或 `drainTimeoutMs` 后停止
 *    （超时在途以 `extension-replaced` 失败）。swap 不等排空完成。
 *
 * 幂等：同一控制器的 swap 串行；同版本目录为 no-op；没有活跃实例时只记下新目录（站点开关决定何时激活）。
 */
import type { ActiveInstance, IsolatedController } from "./controller.js";

export type SwapResult =
  | { outcome: "swapped"; previousInstanceId?: string }
  | { outcome: "noop" }
  | { outcome: "activated" };

export class ExtensionSwapError extends Error {
  readonly code = "MARKETPLACE_SWAP_FAILED";
  constructor(message: string, readonly reason: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtensionSwapError";
  }
}

export type SwapperOptions = {
  controller: IsolatedController;
  log: (event: Record<string, unknown>) => void;
  /** 蓝实例排空时限（`extensions.host.drainTimeoutMs`，按调用现取）。 */
  drainTimeoutMs: () => number;
  /** 切换成功后（换版本即清空崩溃窗口 / 解除隔离）。 */
  onSwapped?: (directory: string) => void;
  /** 排空轮询间隔（测试注入）。 */
  drainPollMs?: number;
};

export type ExtensionSwapper = {
  swap(nextDirectory: string): Promise<SwapResult>;
  /** 正在排空的旧实例数（测试 / 诊断）。 */
  draining(): number;
};

/** 等蓝实例在途请求清零或超时；超时后停止（RPC 层让剩余在途以 `extension-replaced` 失败）。 */
async function drain(blue: ActiveInstance, controller: IsolatedController, timeoutMs: number, pollMs: number, log: SwapperOptions["log"]): Promise<void> {
  const started = Date.now();
  while (!blue.binding.rpc.closed && blue.binding.rpc.inFlight() > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const remaining = blue.binding.rpc.closed ? 0 : blue.binding.rpc.inFlight();
  if (remaining > 0) {
    log({ event: "extension-host-drain-timeout", instanceId: blue.instance.instanceId, inFlight: remaining, timeoutMs });
    blue.binding.rpc.close("extension-replaced", "扩展已升级，旧实例排空超时");
  }
  await controller.stopInstance(blue);
  log({ event: "extension-host-drained", instanceId: blue.instance.instanceId, abandoned: remaining });
}

export function createExtensionSwapper(options: SwapperOptions): ExtensionSwapper {
  const { controller } = options;
  const log = (event: Record<string, unknown>) => options.log({ extension: controller.extensionId, ...event });
  const pollMs = options.drainPollMs ?? 100;
  let queue: Promise<unknown> = Promise.resolve();
  let drainingCount = 0;

  const run = async (nextDirectory: string): Promise<SwapResult> => {
    const active = controller.active();
    if (!active) {
      if (controller.wanted()) {
        // 应当运行但没有实例（崩溃后、等待重启中；典型是观察期崩溃交给 Manager 回滚）：直接激活新目录。
        // 失败与 swap 失败同语义（MARKETPLACE_SWAP_FAILED），Manager 保留指针回滚结果，supervisor 已不再管这次崩溃。
        options.onSwapped?.(nextDirectory);
        try {
          await controller.activate(controller.values(), nextDirectory);
        } catch (error) {
          const reason = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "activation-failed";
          log({ event: "extension-host-swap-failed", to: nextDirectory, reason });
          throw new ExtensionSwapError(`新版本未能就绪（${reason}）`, reason, { cause: error });
        }
        log({ event: "extension-host-activated-after-crash", directory: nextDirectory });
        return { outcome: "activated" };
      }
      // 停用 / 隔离 / 未激活：不替站点开关做决定，只把下一次激活指向新目录。
      if (controller.directory() === nextDirectory) return { outcome: "noop" };
      controller.retarget(nextDirectory);
      options.onSwapped?.(nextDirectory);
      log({ event: "extension-host-retargeted", directory: nextDirectory });
      return { outcome: "activated" };
    }
    if (active.directory === nextDirectory) return { outcome: "noop" };
    log({ event: "extension-host-swap-begin", from: active.directory, to: nextDirectory });
    let green: ActiveInstance;
    try {
      green = await controller.prepare(nextDirectory);
    } catch (error) {
      // controller.prepare 失败时已停止绿实例；蓝实例不受影响。
      const reason = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "activation-failed";
      log({ event: "extension-host-swap-failed", to: nextDirectory, reason, message: error instanceof Error ? error.message : String(error) });
      throw new ExtensionSwapError(`新版本未能就绪（${reason}），保持旧版本`, reason, { cause: error });
    }
    // 准备期间蓝实例崩溃：没有可替换的蓝，绿直接成为活跃实例。
    const blue = controller.commit(green);
    options.onSwapped?.(nextDirectory);
    log({ event: "extension-host-swapped", to: nextDirectory, instanceId: green.instance.instanceId, ...(blue ? { previousInstanceId: blue.instance.instanceId } : {}) });
    if (blue) {
      drainingCount += 1;
      void drain(blue, controller, options.drainTimeoutMs(), pollMs, log)
        .catch((error: unknown) => log({ event: "extension-host-drain-failed", message: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          drainingCount -= 1;
        });
    }
    return { outcome: "swapped", ...(blue ? { previousInstanceId: blue.instance.instanceId } : {}) };
  };

  return {
    swap(nextDirectory) {
      const next = queue.then(() => run(nextDirectory));
      queue = next.catch(() => undefined);
      return next;
    },
    draining: () => drainingCount
  };
}
