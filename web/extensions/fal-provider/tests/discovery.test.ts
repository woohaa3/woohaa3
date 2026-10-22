import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { discoverFalModels } from "../src/discovery.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));
}

/** 取 mock 调用的 init；vi.fn 的元组类型不含第二个参数，这里显式断言。 */
function initOf(call: unknown): RequestInit {
  return ((call as unknown[])[1] ?? {}) as RequestInit;
}

describe("fal 模型发现", () => {
  it("按 endpoint id 读取队列 OpenAPI，跳过不支持的类别", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const id = decodeURIComponent(new URL(String(input)).searchParams.get("endpoint_id") ?? "");
      if (id === "fal-ai/flux/schnell") return Response.json(fixture("flux-schnell"));
      if (id === "fal-ai/whisper") return Response.json(fixture("whisper"));
      return new Response("null", { status: 404 });
    });
    const result = await discoverFalModels({
      modelIds: ["fal-ai/flux/schnell", "fal-ai/whisper", "fal-ai/missing"],
      fetchImpl: fetchImpl as typeof fetch,
      schemaEndpoint: "https://fal.ai/api/openapi/queue/openapi.json"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((model) => model.id)).toEqual(["fal-ai/flux/schnell"]);
    expect(result.message).toContain("fal-ai/whisper");
    expect(result.message).toContain("fal-ai/missing");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("endpoint_id=fal-ai%2Fflux%2Fschnell");
    // 定义接口公开可读：发现请求不带凭据。
    expect(new Headers(initOf(fetchImpl.mock.calls[0]).headers).get("authorization")).toBeNull();
  });

  it("全部读不到时报第一条原因", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", { status: 404 }));
    const result = await discoverFalModels({
      modelIds: ["fal-ai/missing"],
      fetchImpl: fetchImpl as typeof fetch,
      schemaEndpoint: "https://fal.ai/api/openapi/queue/openapi.json"
    });
    expect(result).toEqual({ ok: false, message: "fal-ai/missing：读取定义失败（HTTP 404）" });
  });

  it("没有模型名单时不发请求", async () => {
    const fetchImpl = vi.fn();
    const result = await discoverFalModels({ modelIds: [], fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
