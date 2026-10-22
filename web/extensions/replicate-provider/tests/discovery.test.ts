import { describe, expect, it, vi } from "vitest";
import { createReplicateRegistration } from "../src/backend.js";
import { discoverReplicateModels } from "../src/discovery.js";

const VERSION = "b".repeat(64);

function payload(id: string, description: string, output: Record<string, unknown>) {
  const [owner, name] = id.split("/");
  return {
    owner,
    name,
    description,
    latest_version: {
      id: VERSION,
      openapi_schema: {
        components: {
          schemas: {
            Input: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", title: "Prompt" } } },
            Output: output
          }
        }
      }
    }
  };
}

describe("Replicate 模型发现", () => {
  it("用 Bearer 读取每个 owner/name，地址末尾斜杠不重复", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/models/black-forest-labs/flux-schnell")) {
        return Response.json(payload("black-forest-labs/flux-schnell", "image model", { type: "string", format: "uri" }));
      }
      return new Response("missing", { status: 404 });
    });
    const result = await discoverReplicateModels({
      baseUrl: "https://api.replicate.com/v1/",
      apiKey: "r8_test",
      modelIds: ["black-forest-labs/flux-schnell", "missing/model"],
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell", expect.objectContaining({
      method: "GET",
      headers: { authorization: "Bearer r8_test", accept: "application/json" }
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((model) => model.id)).toEqual(["black-forest-labs/flux-schnell"]);
    expect(result.message).toContain("missing/model");
  });

  it("一个都读不到时返回原因", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await discoverReplicateModels({
      baseUrl: "https://api.replicate.com/v1",
      apiKey: "r8_test",
      modelIds: ["owner/model"],
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(result).toEqual({ ok: false, message: "owner/model：读取失败（HTTP 401）" });
  });

  it("未填写 Token 或模型时仍注册，但不可执行", async () => {
    const empty = createReplicateRegistration({});
    expect(empty.registration.available).toBe(false);
    expect(empty.registration.provider).toBeUndefined();

    const ready = createReplicateRegistration({
      apiKey: "r8_test",
      models: "owner/model",
      fetchImpl: vi.fn() as typeof fetch,
      discovered: [{
        id: "owner/model",
        version: VERSION,
        modelType: "image",
        title: "owner/model",
        promptRequirement: "required",
        inputSchema: { type: "object", properties: {} },
        defaultInput: {},
        allowed: ["prompt"],
        promptKey: "prompt"
      }]
    });
    expect(ready.registration.available).toBe(true);
    expect(ready.registration.models.map((model) => model.providerModelId)).toEqual(["owner/model"]);
    expect((await ready.registration.describeModel?.(ready.registration.models[0]!))?.cancel).toBe("remote");
  });
});
