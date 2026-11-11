import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeComponentsHandler } from "./http.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
async function serve(manager?: object, allowedOrigins: readonly string[] = []) {
  const handler = createRuntimeComponentsHandler({ getManager: () => manager as never, allowedOrigins });
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/runtime-components`;
}
describe("desktop runtime component routes", () => {
  it("reports unavailable without starting any component outside desktop", async () => {
    const url = await serve();
    expect(await (await fetch(url)).json()).toMatchObject({ available: false, components: [] });
    expect((await fetch(`${url}/codex/install`, { method: "POST" })).status).toBe(409);
  });
  it("rejects LAN requests even without Origin", async () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const handler = createRuntimeComponentsHandler();
    await handler({ url: "/api/runtime-components/codex/install", method: "POST", socket: { remoteAddress: "192.168.1.2" }, headers: {} } as never, { writeHead, end } as never);
    expect(writeHead.mock.calls[0]?.[0]).toBe(403);
  });
  it("rejects cross-origin installation and bounds configuration requests", async () => {
    const configure = vi.fn();
    const url = await serve({ inspect: vi.fn(), configure });
    expect((await fetch(`${url}/codex/install`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${url}/codex/configure`, { method: "POST", body: "x".repeat(9000) })).status).toBe(413);
    expect(configure).not.toHaveBeenCalled();
  });
  it("returns immediately for installs, deduplicates requests and explicitly cancels", async () => {
    let signal: AbortSignal | undefined;
    const install = vi.fn((_id, options) => new Promise<void>((resolve) => { signal = options.signal; signal?.addEventListener("abort", () => resolve()); }));
    const url = await serve({ inspect: vi.fn(), install });
    expect((await fetch(`${url}/codex/install`, { method: "POST" })).status).toBe(202);
    await fetch(`${url}/codex/install`, { method: "POST" });
    expect(install).toHaveBeenCalledTimes(1);
    await fetch(`${url}/codex/cancel`, { method: "POST" });
    expect(signal?.aborted).toBe(true);
  });
});

it.each(["COMPONENT_IN_USE", "COMPONENT_BUSY"])("reports %s as a recoverable conflict", async (code) => {
  const url = await serve({ inspect: vi.fn(), remove: async () => { throw Object.assign(new Error("active operation"), { code }); } });
  const response = await fetch(`${url}/codex/remove`, { method: "POST" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code });
});

it("honors the desktop development origin allowlist without allowing arbitrary sites", async () => {
  const configure = vi.fn();
  const url = await serve({ inspect: vi.fn(), configure }, ["http://127.0.0.1:5174"]);
  const response = await fetch(`${url}/codex/configure`, { method: "POST", headers: { origin: "http://127.0.0.1:5174" }, body: JSON.stringify({ source: "managed" }) });
  expect(response.status).toBe(200);
  expect(configure).toHaveBeenCalledTimes(1);
});

it("explains an unusable selected path while still listing working candidates", async () => {
  const diagnose = vi.fn(async () => ({ error: "env: node: No such file or directory" }));
  const discoverLocal = vi.fn(async () => [{ entry: "/opt/codex", version: "0.163.0", source: "local", kind: "executable" }]);
  const url = await serve({ inspect: vi.fn(), diagnose, discoverLocal });
  const response = await fetch(`${url}/codex/discover`, { method: "POST", body: JSON.stringify({ path: "/Users/me/bin/codex" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    candidates: [{ entry: "/opt/codex" }],
    selected: { path: "/Users/me/bin/codex", error: expect.stringContaining("node") }
  });
  expect(diagnose).toHaveBeenCalledWith("codex", "/Users/me/bin/codex");
  // A working path needs no explanation, and an empty body must not be rejected as over-sized.
  diagnose.mockResolvedValueOnce({ entry: "/opt/codex", version: "0.163.0", source: "local", kind: "executable" } as never);
  expect(await (await fetch(`${url}/codex/discover`, { method: "POST" })).json()).toEqual({ candidates: [{ entry: "/opt/codex", version: "0.163.0", source: "local", kind: "executable" }] });
});

it("explains a disabled install policy instead of claiming desktop-only", async () => {
  const url = await serve();
  expect(await (await fetch(url)).json()).toMatchObject({ available: false, installEnabled: false, message: "管理员未启用运行时安装" });
});

it("exposes the npm registry policy and accepts switching a component to it", async () => {
  const configure = vi.fn(async () => ({ id: "dsh", version: "0.2.2-rc.1", source: "npm-registry", configured: true, status: "missing" }));
  const url = await serve({
    configPath: "/tmp/config.json",
    inspect: vi.fn(),
    configure,
    list: vi.fn(async () => [{ id: "dsh", version: "0.2.2-rc.1", source: "npm-registry", configured: true, status: "missing", engine: "dsh-agent-sdk", registry: "https://registry.npmjs.org/" }]),
    policy: () => ({ installEnabled: true, sources: ["npm-registry", "managed", "local"], registry: "https://registry.npmjs.org/" })
  });
  const snapshot = await (await fetch(url)).json();
  expect(snapshot.available).toBe(true);
  expect(snapshot.policy).toMatchObject({ installEnabled: true, registry: "https://registry.npmjs.org/" });
  expect(snapshot.components[0]).toMatchObject({ id: "dsh", source: "npm-registry", engine: "dsh-agent-sdk" });
  expect((await fetch(`${url}/dsh/configure`, { method: "POST", body: JSON.stringify({ source: "npm-registry" }) })).status).toBe(200);
  expect(configure).toHaveBeenCalledWith("dsh", { source: "npm-registry" });
  expect((await fetch(`${url}/dsh/configure`, { method: "POST", body: JSON.stringify({ source: "arbitrary" }) })).status).toBe(400);
});
