import http from "node:http";
import { expect, it, vi } from "vitest";
import { createServiceConnectionFetch } from "./service-connection-fetch.js";

it("rejects DNS private/rebinding targets, cross-origin calls and revocation before credential dispatch", async () => {
  const validate = vi.fn(async () => {});
  const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
  const fetch = createServiceConnectionFetch({ endpoint: "https://relay.example/v1", validate, allowHttp: false, lookup });
  await expect(fetch("https://relay.example/v1/chat/completions", { headers: { authorization: "Bearer key" } })).rejects.toThrow("非公网");
  expect(validate).toHaveBeenCalledOnce();
  await expect(fetch("https://other.example/v1")).rejects.toThrow("未获准");
  expect(lookup).toHaveBeenCalledOnce();
});
it("pins allowed loopback test transport, streams responses and refuses credential redirects", async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url!);
    if (req.url === "/redirect") { res.writeHead(302, { location: "/secret" }); res.end(); }
    else { expect(req.headers.authorization).toBe("Bearer key"); res.end("data: response\n\n"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://localhost:${address.port}`;
  let active = true;
  const fetch = createServiceConnectionFetch({ endpoint: origin, allowHttp: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }], validate: async () => { if (!active) throw Object.assign(new Error("revoked"), { sourceStale: true }); } });
  try {
    expect(await (await fetch(`${origin}/stream`, { headers: { authorization: "Bearer key" } })).text()).toBe("data: response\n\n");
    await expect(fetch(`${origin}/redirect`, { headers: { authorization: "Bearer key" } })).rejects.toThrow("重定向");
    active = false;
    await expect(fetch(`${origin}/stream`, { headers: { authorization: "Bearer new-key" } })).rejects.toMatchObject({ sourceStale: true });
    expect(calls).toEqual(["/stream", "/redirect"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
