/**
 * 站点扩展版本激活的有界时限（change: 2026-10-21-harden-extension-fault-isolation，D4；从 control-plane.ts 拆出）。
 *
 * 超时只是放弃等待：返回 `activation-timeout`，不自动重试；原激活迟到成功且没有成为 public 版本时，
 * 立即释放该实例，不装进当前状态。
 */
import type { ExtensionActivationResult } from "./host-types.js";

/** 版本激活缺省时限（D4）。 */
export const DEFAULT_SITE_ACTIVATION_TIMEOUT_MS = 30_000;

export type DeadlineActivationOutcome =
  | { ok: true }
  | { ok: false; code: "activation-failed" | "activation-timeout"; message: string };

/** 把配置的时限收敛为正有限数，非法值回退缺省。 */
export function resolveActivationTimeout(value: number | undefined): number {
  const candidate = value ?? DEFAULT_SITE_ACTIVATION_TIMEOUT_MS;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_SITE_ACTIVATION_TIMEOUT_MS;
}

/**
 * 在 `timeoutMs` 内等待一次激活。`releaseLate` 只在超时后、激活迟到成功时调用（由调用方判断是否已成为 public）。
 */
export async function awaitActivationWithDeadline(
  pending: Promise<ExtensionActivationResult>,
  timeoutMs: number,
  releaseLate: () => Promise<void> | void
): Promise<DeadlineActivationOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const result = await Promise.race([pending, timedOut]);
    if (result === "timeout") {
      // 迟到结果不装进当前状态（D4）：成功的实例立即释放；失败本身已回滚。
      void pending.then(
        async (late) => {
          if (late.ok) await releaseLate();
        },
        () => undefined
      );
      return { ok: false, code: "activation-timeout", message: `插件激活超过 ${timeoutMs}ms 仍未完成` };
    }
    if (!result.ok) {
      const code = (result as { code?: string }).code === "activation-timeout" || /activation-timeout/.test(result.message) ? "activation-timeout" : "activation-failed";
      return { ok: false, code, message: result.message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "activation-failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
