/**
 * Canvas → Media 的 extension-read 请求体（分立部署）。
 *
 * canvas-service 不持有存储凭据：它只把 storageKey 发给 media-service。远端画布的媒体字节
 * 只存在服务端托管存储里（键 `<canvasId>/media/<key>`），因此能拿到画布 id 时必须把
 * canvasId 放进请求体；省略表示与画布无关，保持旧行为。
 */
import { describe, expect, it } from "vitest";
import { createCanvasMediaClient } from "./media-client.js";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;

function recordingFetch(): { bodies: unknown[]; fetchImpl: typeof globalThis.fetch } {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
    return new Response(JSON.stringify({ bytesBase64: "AQID", contentType: "image/png" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetchImpl };
}

describe("CanvasMediaClient.read 画布作用域", () => {
  it("调用方声明的扩展作用域原样进入请求体", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const client = createCanvasMediaClient({ baseUrl: "http://media.local", serviceToken: "token", fetchImpl });
    const media = await client.read!(STORAGE_KEY, "canvas-a", "studio-media");
    expect(Array.from(media.bytes)).toEqual([1, 2, 3]);
    expect(bodies).toEqual([{ extensionId: "studio-media", storageKey: STORAGE_KEY, canvasId: "canvas-a" }]);
  });

  it("没有画布时仍发送调用方声明的扩展作用域", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const client = createCanvasMediaClient({ baseUrl: "http://media.local", serviceToken: "token", fetchImpl });
    await client.read!(STORAGE_KEY, undefined, "studio-media");
    expect(bodies).toEqual([{ extensionId: "studio-media", storageKey: STORAGE_KEY }]);
  });

  it("没有扩展作用域时拒绝，不替调用方填片场身份", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const client = createCanvasMediaClient({ baseUrl: "http://media.local", serviceToken: "token", fetchImpl });
    await expect(client.read!(STORAGE_KEY, "canvas-a")).rejects.toMatchObject({ code: "extension-scope-required" });
    expect(bodies).toEqual([]);
  });
});
