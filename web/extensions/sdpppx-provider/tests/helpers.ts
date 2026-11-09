/** 测试共享：最小部署环境与可控 fetch 替身。 */
import { vi } from "vitest";
import { readSdpppxConfig } from "../src/backend/config.js";
import type { SdpppxDeployment } from "../src/backend/deployment-config.js";

/** 测试用部署身份；生产身份编译在 `deployment-config.ts`。 */
export const TEST_DEPLOYMENT: SdpppxDeployment = {
  tenantId: "tenant-1",
  supabaseUrl: "https://project.supabase.co/",
  supabaseAnonKey: "anon-key"
};

export const EMPTY_DEPLOYMENT: SdpppxDeployment = {
  tenantId: "",
  supabaseUrl: "",
  supabaseAnonKey: ""
};

export function readTestConfig(
  env: Record<string, string | undefined> = FULL_ENV,
  deployment: SdpppxDeployment = TEST_DEPLOYMENT
) {
  return readSdpppxConfig(env, deployment);
}

export const FULL_ENV: Record<string, string> = {
  SDPPPX_AUTHING_APP_ID: "app-1"
};

export type FetchCall = { url: string; init: RequestInit };

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

/** 构造 `POST /tasks/create_stream` 的 SSE 响应体。 */
export function sseResponse(
  events: Array<{ event: string; data: unknown }>,
  init: ResponseInit = {}
): Response {
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init
  });
}

/** 记录每次调用，并交给处理器决定响应。 */
export function createFetch(
  handler: (call: FetchCall) => Response | Promise<Response>
): { fetchImpl: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

export function bodyOf(call: FetchCall): Record<string, unknown> {
  return typeof call.init.body === "string" ? (JSON.parse(call.init.body) as Record<string, unknown>) : {};
}

export function headersOf(call: FetchCall): Record<string, string> {
  return { ...(call.init.headers as Record<string, string> | undefined) };
}

/** 一张 1x1 PNG（只用于字节与媒体类型检测，不参与渲染）。 */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

export function pngResponse(): Response {
  return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
}
