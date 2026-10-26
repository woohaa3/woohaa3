/**
 * 扩展激活 / 释放的有界时限（change: 2026-10-21-harden-extension-fault-isolation，design D4）。
 *
 * 超时只是**放弃等待**：原 promise 仍在跑，迟到结果由调用方按 attempt 计数丢弃（迟到的 fiber 立即
 * dispose）。这里不做重试，避免一个慢扩展被反复拉起。
 */

export const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
export const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;
/** 宿主设置允许的范围（1s–10min）。 */
export const MIN_EXTENSION_TIMEOUT_MS = 1_000;
export const MAX_EXTENSION_TIMEOUT_MS = 600_000;

export class DeadlineError extends Error {
  readonly code: string;
  readonly timeoutMs: number;
  constructor(code: string, timeoutMs: number, message?: string) {
    super(message ?? `操作超过 ${timeoutMs}ms 仍未完成（${code}）`);
    this.name = "DeadlineError";
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

export function isDeadlineError(error: unknown): error is DeadlineError {
  return error instanceof DeadlineError;
}

/** 在 `ms` 内等到 `promise`；超时以 `DeadlineError(code)` 拒绝。计时器不阻止进程退出。 */
export function withDeadline<T>(promise: PromiseLike<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(code, ms)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 把设置值收敛到有界范围；非数字回退缺省。 */
export function boundedTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_EXTENSION_TIMEOUT_MS, Math.max(MIN_EXTENSION_TIMEOUT_MS, Math.round(value)));
}
