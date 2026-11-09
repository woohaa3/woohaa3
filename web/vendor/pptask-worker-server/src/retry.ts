export const DEFAULT_RETRY_LIMIT = 5;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const RETRY_DELAY_CAP_MS = 60_000;

/**
 * Classification ported from the reference implementation: only transient
 * infrastructure failures consume the retry budget — provider-side validation
 * errors should surface immediately.
 */
const RETRYABLE_ERROR_PATTERN =
  /timeout|timed out|超时|网络|network|fetch failed|econnreset|enotfound|socket|temporar|rate limit|too many requests|http (?:408|425|429|5\d\d)|\b(?:408|425|429|5\d\d)\b/i;

/**
 * Provider 明确声明"不值得重试"的错误优先于正文推断。
 *
 * 只看正文是不够的：远端托管生成的失败由服务端判定，`worker-lost`（算力节点失联）的短语
 * 里也可能出现"不可用/失联"这类字面量，但它重试只会再占一次队列、再花一次 GPU。带
 * `retryable === false` 的错误一律按不可重试处理；只认 `false`——缺省表示 provider 没判断，
 * 仍走正文推断。
 */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { retryable?: unknown }).retryable === false) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_PATTERN.test(message);
}

export function retryDelayMs(attempt: number, retryBaseMs: number): number {
  return Math.min(RETRY_DELAY_CAP_MS, retryBaseMs * 2 ** Math.max(0, attempt - 1));
}
