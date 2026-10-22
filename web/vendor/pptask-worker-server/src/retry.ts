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

export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_PATTERN.test(message);
}

export function retryDelayMs(attempt: number, retryBaseMs: number): number {
  return Math.min(RETRY_DELAY_CAP_MS, retryBaseMs * 2 ** Math.max(0, attempt - 1));
}
