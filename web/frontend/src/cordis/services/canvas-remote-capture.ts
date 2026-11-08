import type { CanvasCaptureFreezeResult } from "../contract/remote.js";

// Budgets apply to one host read/upload, never to the complete animated recording.
export function captureRequestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Uint8Array → base64（分块避免参数上限）；无 DOM 时用 Buffer 兜底。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 把页面渲染的 PNG 提交给宿主校验、保存并冻结；返回 binding 或稳定错误。 */
export async function postPageCommit(
  captureBase: string,
  fetchImpl: typeof globalThis.fetch,
  input: { attemptId?: string; cameraId: string; key: unknown; png: Uint8Array; width: number; height: number; signal?: AbortSignal }
): Promise<CanvasCaptureFreezeResult> {
  let committed: Response;
  try {
    committed = await fetchImpl(`${captureBase}-page-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cameraId: input.cameraId,
        attemptId: input.attemptId,
        key: input.key,
        pngBase64: bytesToBase64(input.png),
        width: input.width,
        height: input.height
      }),
      signal: captureRequestSignal(input.signal, 90_000)
    });
  } catch {
    return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
  }
  const committedBody = (await committed.json().catch(() => null)) as Record<string, unknown> | null;
  if (committedBody && committedBody.ok === true && committedBody.binding && typeof committedBody.binding === "object") {
    return {
      ok: true,
      binding: committedBody.binding as import("@woohaa3/contracts").WorldCaptureGenerationBinding
    };
  }
  return {
    ok: false,
    code: typeof committedBody?.code === "string" ? committedBody.code : `http-${committed.status}`,
    error: typeof committedBody?.message === "string" && committedBody.message !== ""
      ? committedBody.message
      : `取景冻结失败（HTTP ${committed.status}）`,
    ...(committedBody?.requestedKey ? { requestedKey: committedBody.requestedKey as import("@woohaa3/contracts").WorldCaptureVersionKey } : {}),
    ...(committedBody?.currentKey ? { currentKey: committedBody.currentKey as import("@woohaa3/contracts").WorldCaptureVersionKey } : {})
  };
}
