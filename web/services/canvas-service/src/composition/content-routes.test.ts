import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ContentContributionRegistry } from "@woohaa3/contracts";
import { createContentRouteHandler } from "./content-routes.js";

function request(url: string, method: string, body?: unknown) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    url,
    method,
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" }
  }) as never;
}

function response() {
  const captured = { status: 0, body: "", headers: {} as Record<string, string> };
  return {
    set statusCode(value: number) { captured.status = value; },
    get statusCode() { return captured.status; },
    setHeader(name: string, value: string) { captured.headers[name] = value; },
    end(value?: string) { captured.body = value ?? ""; },
    captured
  } as never;
}

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({
    extensionId: "test-route",
    routes: [
      { method: "POST", path: ["echo"], handle: ({ body }) => ({ status: 200, body }) }
    ]
  });
  return result;
}

describe("content route HTTP handler", () => {
  it("dispatches and writes JSON", async () => {
    const handler = createContentRouteHandler({ content: registry() });
    const req = request("/content/test-route/echo?canvasId=c1", "POST", { value: 1 });
    const res = response() as never as { captured: { status: number; body: string } };
    await expect(handler(req, res as never)).resolves.toBe(true);
    expect(res.captured.status).toBe(200);
    expect(JSON.parse(res.captured.body)).toEqual({ value: 1 });
  });

  it("requires canvasId and rejects oversized bodies", async () => {
    const handler = createContentRouteHandler({ content: registry() });
    const missing = response() as never as { captured: { status: number } };
    await handler(request("/content/test-route/echo", "POST", {}), missing as never);
    expect(missing.captured.status).toBe(400);

    const huge = response() as never as { captured: { status: number } };
    await handler(request("/content/test-route/echo?canvasId=c1", "POST", { value: "x".repeat(300 * 1024) }), huge as never);
    expect(huge.captured.status).toBe(400);
  });

  it("returns stable 404 for unknown owners and routes", async () => {
    const handler = createContentRouteHandler({ content: registry() });
    const owner = response() as never as { captured: { status: number; body: string } };
    await handler(request("/content/missing/echo?canvasId=c1", "POST", {}), owner as never);
    expect(owner.captured.status).toBe(404);
    const path = response() as never as { captured: { status: number; body: string } };
    await handler(request("/content/test-route/missing?canvasId=c1", "POST", {}), path as never);
    expect(path.captured.status).toBe(404);
  });
});
