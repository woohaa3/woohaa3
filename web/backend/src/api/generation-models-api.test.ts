/**
 * 生成模型管理 API 测试
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1 / design D2；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.2/3.5）。
 *
 * 验证：公开 snapshot、具名 action 写入、expectedRevision 冲突、无身份/无权限拒绝。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createGenerationModelsApiHandler } from "./generation-models-api.js";
import {
  createAccessEnforcer,
  createFakeRequestAuthenticator,
  createUnauthenticatedAuthenticator,
  testPrincipal
} from "@woohaa3/application-service";
import type { SiteAccessPolicy } from "@woohaa3/contracts";

function makeRequest(options: { method: string; url: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = options.method;
  req.url = options.url;
  for (const [key, value] of Object.entries(options.headers ?? {})) req.headers[key] = value;
  if (options.body !== undefined) {
    const payload = JSON.stringify(options.body);
    setImmediate(() => {
      req.emit("data", Buffer.from(payload));
      req.emit("end");
    });
  }
  return req;
}

function mockResponse(req: IncomingMessage): { res: ServerResponse; written: string[] } {
  const written: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  return { res, written };
}

async function call(handler: ReturnType<typeof createGenerationModelsApiHandler>, req: IncomingMessage) {
  const { res, written } = mockResponse(req);
  await handler(req, res);
  const text = written.join("");
  return { status: res.statusCode, body: text === "" ? null : JSON.parse(text) };
}

/** 测试 site-access：仅 `admin` subject 有 models.manage。 */
function modelPolicy(): SiteAccessPolicy {
  const grant = (subject: string) => subject === "admin";
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions() {
      return [];
    },
    async authorize({ principal }: { principal: import("@woohaa3/contracts").PrincipalContext }) {
      return grant(principal.subject) ? { allowed: true } : { allowed: false, code: "forbidden" };
    }
  };
}

function harness() {
  let revision = 0;
  const models: Array<{ modelKey: string; enabled: boolean }> = [];
  return createGenerationModelsApiHandler({
    authenticator: createFakeRequestAuthenticator((req) => {
      const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
      return actor ? testPrincipal(actor, { identityProvider: "test" }) : null;
    }),
    accessEnforcer: createAccessEnforcer({ siteAccessPolicy: () => modelPolicy(), resourceAccessPolicy: () => null }),
    snapshot: async () => ({ revision, initialized: revision > 0, models: models.map((m) => ({ modelKey: m.modelKey, providerId: "p", modelType: "image" as const, enabled: m.enabled, isDefault: false, executable: true })) }),
    write: async (input) => {
      if (input.expectedRevision !== revision) return { ok: false, code: "revision-conflict", message: "冲突", currentRevision: revision };
      const known = new Set(["p:a"]);
      const unknown = input.models.find((m) => !m.tombstone && !known.has(m.modelKey));
      if (unknown) return { ok: false, code: "config-invalid", message: `未知模型 ${unknown.modelKey}` };
      models.length = 0;
      for (const m of input.models) models.push({ modelKey: m.modelKey, enabled: m.enabled });
      revision += 1;
      return { ok: true, revision, snapshot: await Promise.resolve({ revision, initialized: true, models: models.map((m) => ({ modelKey: m.modelKey, providerId: "p", modelType: "image" as const, enabled: m.enabled, isDefault: false, executable: true })) }) };
    },
    logger: () => {}
  });
}

describe("生成模型管理 API（任务 5.1）", () => {
  it("公开 snapshot 无需令牌", async () => {
    const handler = harness();
    const result = await call(handler, makeRequest({ method: "GET", url: "/api/generation-models" }));
    expect(result.status).toBe(200);
    expect((result.body as { models: unknown[] }).models).toEqual([]);
  });

  it("无 models.manage 的已认证用户被拒（403）；管理员写入成功", async () => {
    const handler = harness();
    const denied = await call(handler, makeRequest({
      method: "PUT", url: "/api/generation-models/config",
      headers: { "content-type": "application/json", "x-woohaa3-test-actor": "u" },
      body: { expectedRevision: 0, models: [{ modelKey: "p:a", enabled: true }] }
    }));
    expect(denied.status).toBe(403);

    const ok = await call(handler, makeRequest({
      method: "PUT", url: "/api/generation-models/config",
      headers: { "content-type": "application/json", "x-woohaa3-test-actor": "admin" },
      body: { expectedRevision: 0, models: [{ modelKey: "p:a", enabled: true }] }
    }));
    expect(ok.status).toBe(200);
    expect((ok.body as { revision: number }).revision).toBe(1);
  });

  it("未知 identity 拒绝；冲突返回 409", async () => {
    const handler = harness();
    const headers = { "content-type": "application/json", "x-woohaa3-test-actor": "admin" };
    const unknown = await call(handler, makeRequest({ method: "PUT", url: "/api/generation-models/config", headers, body: { expectedRevision: 0, models: [{ modelKey: "ghost", enabled: true }] } }));
    expect(unknown.status).toBe(400);
    await call(handler, makeRequest({ method: "PUT", url: "/api/generation-models/config", headers, body: { expectedRevision: 0, models: [{ modelKey: "p:a", enabled: true }] } }));
    const conflict = await call(handler, makeRequest({ method: "PUT", url: "/api/generation-models/config", headers, body: { expectedRevision: 0, models: [{ modelKey: "p:a", enabled: false }] } }));
    expect(conflict.status).toBe(409);
  });

  it("未认证时写入拒绝（401）", async () => {
    const handler = createGenerationModelsApiHandler({
      authenticator: createUnauthenticatedAuthenticator(),
      snapshot: async () => ({ revision: 0, initialized: false, models: [] }),
      write: async () => ({ ok: false, code: "unauthorized", message: "no" }),
      logger: () => {}
    });
    const result = await call(handler, makeRequest({ method: "PUT", url: "/api/generation-models/config", headers: { "content-type": "application/json" }, body: { expectedRevision: 0, models: [] } }));
    expect(result.status).toBe(401);
  });
});
