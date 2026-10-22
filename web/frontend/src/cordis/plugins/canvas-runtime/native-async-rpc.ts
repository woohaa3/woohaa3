/** 异步 native 请求；支持参数与取消，随 renderer realm 释放。 */
import { nativeProtocolUrl } from "../../../desktop/native-protocol.js";
export function createNativeAsyncRpc(target: typeof globalThis, token: string) {
  let disposed = false;
  const pending = new Set<XMLHttpRequest>();
  return {
    call(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (disposed) { reject(new Error("Native canvas disposed")); return; }
        if (signal?.aborted) { reject(new Error("Native request cancelled")); return; }
        const xhr = new target.XMLHttpRequest();
        pending.add(xhr);
        const fail = () => reject(new Error("Native request unavailable"));
        xhr.open("POST", nativeProtocolUrl("rpc", target), true);
        xhr.setRequestHeader("X-Woohaa-Token", token);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.timeout = 5000;
        xhr.onload = () => {
          try {
            const result = JSON.parse(xhr.responseText) as { ok: boolean; value?: unknown };
            if (disposed || xhr.status !== 200 || !result.ok) return fail();
            resolve(result.value);
          } catch { fail(); }
        };
        xhr.onerror = xhr.ontimeout = xhr.onabort = fail;
        const abort = () => xhr.abort();
        const cleanup = () => { pending.delete(xhr); signal?.removeEventListener("abort", abort); };
        xhr.onloadend = cleanup;
        signal?.addEventListener("abort", abort, { once: true });
        try { xhr.send(JSON.stringify({ method, args })); }
        catch { cleanup(); fail(); }
      });
    },
    dispose() { disposed = true; for (const xhr of pending) xhr.abort(); pending.clear(); }
  };
}
