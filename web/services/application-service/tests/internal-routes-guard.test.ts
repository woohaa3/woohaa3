/**
 * 内部 work 路由：浏览器上下文隔离与内部服务身份
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.6）。
 *
 * 公开浏览器即使持有有效 service token，也不能进入 system 调用路径；服务间调用（不带
 * Origin/Referer/Cookie）仍按服务令牌准入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleInternal } from "../src/api/extension-api/internal-routes.js";
import type { ApplicationExtensionApiDependencies } from "../src/api/extension-api/types.js";

type Captured = { status: number; body: unknown; headers: Record<string, string> };

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    end: (payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
    get statusCode() {
      return captured.status;
    },
    set statusCode(value: number) {
      captured.status = value;
    }
  } as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function deps(serviceToken: string, admitted = true): ApplicationExtensionApiDependencies {
  return {
    serviceToken,
    controlPlane: {
      workLease: () => ({
        admit: () => (admitted ? { ok: true, workId: "w1", configVersion: 1 } : { ok: false, reason: "disabled" }),
        resume: () => null
      })
    } as never
  } as unknown as ApplicationExtensionApiDependencies;
}

const log = () => undefined;

describe("handleInternal 浏览器上下文隔离（任务 1.6）", () => {
  it("带 Origin 的浏览器请求即使持有有效 service token 也拒绝，且不触达 work lease", () => {
    const { res, captured } = fakeRes();
    const handled = handleInternal(
      fakeReq("POST", { "x-woohaa3-service-token": "tok", origin: "https://app.example" }),
      res,
      deps("tok"),
      "/sample/work",
      log
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(403);
    expect(captured.body).toMatchObject({ code: "browser-cannot-enter-system" });
  });

  it("带 Cookie（用户会话）的请求同样拒绝", () => {
    const { res, captured } = fakeRes();
    handleInternal(
      fakeReq("POST", { "x-woohaa3-service-token": "tok", cookie: "woohaa3_session=abc" }),
      res,
      deps("tok"),
      "/sample/work",
      log
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toMatchObject({ code: "browser-cannot-enter-system" });
  });

  it("无 service token 一律 401（不因浏览器上下文而区分）", () => {
    const { res, captured } = fakeRes();
    handleInternal(fakeReq("POST", {}), res, deps("tok"), "/sample/work", log);
    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({ code: "unauthorized" });
  });

  it("服务间调用（无浏览器头 + 有效令牌）进入 work lease", () => {
    const { res, captured } = fakeRes();
    const handled = handleInternal(
      fakeReq("POST", { "x-woohaa3-service-token": "tok" }),
      res,
      deps("tok"),
      "/sample/work",
      log
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, workId: "w1" });
  });
});
