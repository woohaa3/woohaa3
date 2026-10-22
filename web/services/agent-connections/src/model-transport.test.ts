import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createModelTransport } from "./model-transport.js";
import { createEndpointPolicy } from "./endpoint-policy.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handler?: RequestListener) {
  const seen: Array<{ url?: string; auth?: string; body: string }> = [];
  const server = createServer(handler ?? ((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"text":"first"}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 10);
    });
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}
async function transport(upstream: string, extra: Partial<Parameters<typeof createModelTransport>[0]> = {}) {
  const result = await createModelTransport({ apiType: "openai", upstream, apiKey: "real-secret", policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1", "allowed.example"], allowHttp: true }), valid: () => true, ...extra });
  cleanup.push(result.close);
  return result;
}

describe("connection-bound model transport", () => {
  it("streams and replaces local credentials without forwarding grant/arbitrary headers", async () => {
    const upstream = await fixture(); const relay = await transport(upstream.upstream);
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}`, "x-mcp-grant": "grant-secret" }, body: '{"model":"test"}' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(upstream.seen).toEqual([{ url: "/v1/responses", auth: "Bearer real-secret", body: '{"model":"test"}' }]);
  });
  it("rejects missing auth, arbitrary paths, target parameters and stale epochs before contacting upstream", async () => {
    const upstream = await fixture(); let valid = true;
    const relay = await transport(upstream.upstream, { valid: () => valid });
    expect((await fetch(`${relay.baseUrl}/responses`, { method: "POST" })).status).toBe(401);
    for (const path of ["/chat/completions", "/responses?url=https://evil.example", "/responses?alt=other"]) {
      expect((await fetch(relay.baseUrl + path, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } })).ok).toBe(false);
    }
    valid = false;
    expect((await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } })).status).toBe(410);
    expect(upstream.seen).toHaveLength(0);
  });
  it("does not follow any 3xx or disclose upstream error bodies", async () => {
    const upstream = await fixture((_req, res) => { res.writeHead(302, { location: "https://evil.example" }); res.end("real-secret"); });
    const relay = await transport(upstream.upstream);
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("real-secret");
  });
  it("refuses private DNS addresses for a permitted HTTPS host before sending secrets", async () => {
    const relay = await transport("https://allowed.example/v1", { lookup: async () => [{ address: "10.0.0.1", family: 4 }] });
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } });
    expect(response.status).toBe(403);
  });
  it("revocation aborts a live stream and closes the old endpoint", async () => {
    let ended!: () => void;
    const disconnected = new Promise<void>((resolve) => { ended = resolve; });
    const upstream = await fixture((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: start\n\n"); res.on("close", ended); });
    const relay = await transport(upstream.upstream);
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } });
    await relay.close();
    await disconnected;
    await expect(response.text()).rejects.toThrow();
    await expect(fetch(`${relay.baseUrl}/responses`)).rejects.toThrow();
  });
  it("SDK retries recheck the same connection and cannot cross a changed generation", async () => {
    let attempts = 0;
    const upstream = await fixture((_req, res) => { attempts++; res.writeHead(503); res.end("private-upstream-detail"); });
    let valid = true;
    const relay = await transport(upstream.upstream, { valid: () => valid });
    const retry = () => fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } });
    expect((await retry()).status).toBe(503);
    expect((await retry()).status).toBe(503);
    expect(attempts).toBe(2);
    valid = false;
    expect((await retry()).status).toBe(410);
    expect(attempts).toBe(2);
  });
  it("an upstream stream disconnect is surfaced without replaying the inference request", async () => {
    let attempts = 0;
    const upstream = await fixture((_req, res) => {
      attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      setTimeout(() => res.destroy(), 10);
    });
    const relay = await transport(upstream.upstream);
    const response = await fetch(`${relay.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${relay.token}` } });
    await expect(response.text()).rejects.toThrow();
    expect(attempts).toBe(1);
  });

});
