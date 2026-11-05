import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { proxyAccountRequest } from "../src/account-routes.js";

/**
 * 账户转发的请求头规则。
 *
 * 这里只测「带不带 X-Tenant-ID」这一件事，因为它是 `auth/` 前缀下**两种相反规则**的分界：
 * - 桥接与刷新：租户放 body，带租户头会让 WebView 预检失败；
 * - `auth/me` 与 `auth/logout`：要业务 Bearer **加**租户头，缺了会拿到 400 `TENANT_ID_REQUIRED`。
 *
 * 早期实现笼统按 `auth/` 前缀判断，等于把所有 `/auth/*` 都当成「不带」——
 * 接新接口时会直接调不通，而现象是 400，很容易误判成令牌问题。
 */

const ORIGIN = "https://api.sixiai.com.cn";
const TENANT = "d531fe93-2b6a-4941-a3c9-3fd312053379";

function makeReq(url: string, method = "GET", body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  return Object.assign(stream, { url, method, headers: {} }) as unknown as IncomingMessage;
}

/** 调一次转发，回传实际发给上游的头。 */
async function headersFor(path: string, method = "GET", body?: string): Promise<Headers> {
  let seen: Headers | undefined;
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return Response.json({});
  });

  await proxyAccountRequest({
    req: makeReq(`/api/ppserver/account/${path}`, method, body),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    origin: ORIGIN,
    accessToken: "token-1",
    tenantId: TENANT,
  });

  if (!seen) throw new Error("没有发出请求");
  return seen;
}

describe("账户转发 · 租户头", () => {
  it("桥接与刷新把租户放 body，不带 X-Tenant-ID", async () => {
    for (const path of ["auth/refresh", "auth/authing-bridge3"]) {
      const headers = await headersFor(path, "POST", "{}");
      expect(headers.get("x-tenant-id"), path).toBeNull();
    }
  });

  it("auth/me 带 X-Tenant-ID", async () => {
    const headers = await headersFor("auth/me");
    expect(headers.get("x-tenant-id")).toBe(TENANT);
  });

  it("auth/logout 带 X-Tenant-ID", async () => {
    const headers = await headersFor("auth/logout", "POST", "{}");
    expect(headers.get("x-tenant-id")).toBe(TENANT);
  });

  it("业务路径都带 X-Tenant-ID 与 Bearer", async () => {
    for (const path of ["client/v1/balance", "sixi/check-in", "billing", "memberships/current"]) {
      const headers = await headersFor(path);
      expect(headers.get("x-tenant-id"), path).toBe(TENANT);
      expect(headers.get("authorization"), path).toBe("Bearer token-1");
    }
  });

  it("白名单外仍然 404", async () => {
    const fetchImpl = vi.fn();
    const result = await proxyAccountRequest({
      req: makeReq("/api/ppserver/account/unknown/thing"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      origin: ORIGIN,
      accessToken: "token-1",
      tenantId: TENANT,
    });

    expect(result).toMatchObject({ status: 404 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
