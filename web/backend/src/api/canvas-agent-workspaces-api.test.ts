import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccessEnforcer, createFakeRequestAuthenticator, testPrincipal, type CanvasAgentWorkspaceService } from "@woohaa3/application-service";
import { createCanvasAgentWorkspacesApi } from "./canvas-agent-workspaces-api.js";

const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
async function fixture({ desktop = true, admin = true, controlled = false } = {}) {
  const calls = {
    settings: vi.fn(async () => ({ available: true, rootPath: "/files", rootRevision: 1, generation: 1 })),
    location: vi.fn(async () => "/files/canvas"), migrate: vi.fn(async () => ({ operationId: "move", phase: "waiting-for-idle" })),
    cancelMigration: vi.fn(async () => ({ phase: "cancelled" })), clean: vi.fn(async () => ({ removed: [], retained: [] }))
  };
  const authenticate = createFakeRequestAuthenticator(() => testPrincipal("actual-owner", { identityProvider: "test" }));
  const accessEnforcer = createAccessEnforcer({
    runtime: { enabled: controlled, instance: { kind: "instance", id: "instance:test", ownerId: "local-owner", credentialOwnerId: "local-owner" } },
    siteAccessPolicy: () => ({ policyId: "test", policyVersion: () => "1", allowedActions: async () => admin ? ["extensions.configure"] : [], authorize: async () => admin ? { allowed: true } : { allowed: false, code: "forbidden" } }),
    resourceAccessPolicy: () => null
  });
  const authorizeCanvas = vi.fn(async (_owner: string, canvasId: string) => canvasId === "allowed");
  const handler = createCanvasAgentWorkspacesApi({ workspace: () => desktop ? calls as unknown as CanvasAgentWorkspaceService : null, instanceOwner: "local-owner", authenticator: authenticate, accessEnforcer, authorizeCanvas });
  const server = http.createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/agent-workspaces`;
  const post = (suffix: string, body: unknown) => fetch(url + suffix, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { calls, authorizeCanvas, url, post };
}
describe("desktop workspace settings HTTP boundary", () => {
  it("rejects non-desktop callers and requires the existing settings action", async () => {
    const web = await fixture({ desktop: false });
    expect((await web.post("/migrate", { desktop: true, targetPath: "/pretend" })).status).toBe(403);
    expect(web.calls.migrate).not.toHaveBeenCalled();
    const denied = await fixture({ controlled: true, admin: false });
    expect((await fetch(denied.url)).status).toBe(403); expect(denied.calls.settings).not.toHaveBeenCalled();
  });
  it("derives owners from authentication and rejects foreign canvases and owner injection", async () => {
    const f = await fixture({ controlled: true });
    expect((await f.post("/clean", { canvasId: "allowed" })).status).toBe(200);
    expect(f.calls.clean).toHaveBeenCalledWith({ owner: "actual-owner", canvasId: "allowed" });
    expect((await f.post("/clean", { canvasId: "allowed", owner: "forged" })).status).toBe(400);
    expect((await f.post("/clean", { canvasId: "foreign" })).status).toBe(403);
    expect((await fetch(f.url + "/location?canvasId=foreign")).status).toBe(403);
    expect(f.calls.clean).toHaveBeenCalledTimes(1); expect(f.calls.location).not.toHaveBeenCalled();
  });
  it("accepts migration identities and reports conflicts without rewriting inputs", async () => {
    const f = await fixture(), input = { operationId: "same", targetPath: "/next", expectedRootRevision: 1 };
    expect((await f.post("/migrate", input)).status).toBe(202); expect(f.calls.migrate).toHaveBeenCalledWith(input);
    f.calls.migrate.mockRejectedValueOnce(Object.assign(new Error("revision conflict"), { code: "workspace-conflict" }));
    const failed = await f.post("/migrate", input); expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: "workspace-conflict", message: "revision conflict" });
    expect((await f.post("/cancel-migration", { operationId: "same" })).status).toBe(200); expect(f.calls.cancelMigration).toHaveBeenCalledWith("same");
  });
  it("rejects malformed, oversized and unknown fields before side effects", async () => {
    const f = await fixture();
    for (const body of [null, [], { operationId: "move", targetPath: "/next", expectedRootRevision: "1" }, { operationId: "move", targetPath: "/next", expectedRootRevision: 1, handle: {} }]) expect((await f.post("/migrate", body)).status).toBe(400);
    expect((await f.post("/migrate", { big: "x".repeat(65537) })).status).toBe(413);
    expect((await fetch(f.url + "/migrate", { method: "POST", body: "{" })).status).toBe(400);
    expect(f.calls.migrate).not.toHaveBeenCalled();
    expect((await fetch(f.url.replace("/agent-workspaces", "/other"))).status).toBe(404);
  });
});
