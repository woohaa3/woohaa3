/**
 * Image pixels are uploaded immediately; only the loading-state scene rebuild is
 * coalesced. Do not restart the timer on new completions: continuous pan/zoom must
 * still publish the latest loading state at a bounded interval.
 */
export function createImageResourceInvalidation(notify?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    request() {
      if (disposed || !notify || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) notify();
      }, 80);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}
