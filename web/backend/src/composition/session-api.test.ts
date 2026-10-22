import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createProviderRegistry, type ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import { createSessionApi } from "./session-api.js";
import type { AccessRuntime } from "@woohaa3/contracts";

async function request(runtime: AccessRuntime, authenticate: ApplicationRequestAuthenticator, providers = createProviderRegistry()) {
  const handler = createSessionApi(authenticate, providers, runtime);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/application/session`, { headers: { "x-forwarded-for": "198.51.100.1", "x-owner": "other" } });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
it("默认 session 不认证或自造 subject，归属只来自启动配置", async () => {
  const authenticate = vi.fn(async () => { throw new Error("must not authenticate"); });
  const result = await request({ enabled: false, instance: { kind: "instance", id: "instance:fixed", ownerId: "instance:fixed", credentialOwnerId: "instance:fixed" } }, authenticate);
  expect(result).toEqual({ status: 200, body: { accessControl: false, dataScopeId: "instance:fixed" } });
  expect(authenticate).not.toHaveBeenCalled();
});
it("受控缺登录 401，provider 故障 503", async () => {
  expect((await request({ enabled: true }, async () => null)).status).toBe(401);
  expect((await request({ enabled: true }, async () => { throw new Error("offline"); })).status).toBe(503);
  expect((await request({ enabled: true }, async () => ({ subject: "a", identityProvider: "verified" }))).status).toBe(503);
});
