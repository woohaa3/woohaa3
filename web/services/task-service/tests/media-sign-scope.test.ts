import { describe, expect, it } from "vitest";
import { createMediaClient } from "../src/clients/media-client.js";

describe("Media HTTP 签名作用域", () => {
  it("画布请求携带 canvasId，独立任务省略 canvasId", async () => {
    const bodies: unknown[] = [];
    const client = createMediaClient({
      baseUrl: "https://media.example",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ url: "https://storage.example/reference.png" });
      }
    });
    await client.sign("reference.png", 900, { canvasId: "canvas-remote" });
    await client.sign("reference.png", 900);
    expect(bodies).toEqual([
      { storageKey: "reference.png", expiresSeconds: 900, canvasId: "canvas-remote" },
      { storageKey: "reference.png", expiresSeconds: 900 }
    ]);
  });
});
