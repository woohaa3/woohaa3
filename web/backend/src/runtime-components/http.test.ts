import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("serves only resolved image assets and releases the lease after streaming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-http-"));
  try {
    const entry = join(directory, "editor.wasm");
    await writeFile(entry, Buffer.from([0, 97, 115, 109]));
    const release = vi.fn();
    const resolve = vi.fn(async () => ({ entry, release }));
    const url = await serve({ resolve });
    const response = await fetch(`${url}/image-editor/asset`);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 97, 115, 109]));
    expect(resolve).toHaveBeenCalledWith("image-editor");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    const unavailable = await serve({ resolve: async () => { throw new Error("missing"); } });
    const missing = await fetch(`${unavailable}/image-editor/asset`);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ message: expect.stringContaining("运行时组件") });
  } finally { await rm(directory, { recursive: true, force: true }); }
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
