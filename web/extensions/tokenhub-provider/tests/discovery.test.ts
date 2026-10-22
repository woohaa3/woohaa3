import { describe, expect, it, vi } from "vitest";
import { classifyListedModel, discoverTokenHubModels, parseModelList } from "../src/discovery.js";
import { createTokenHubRegistration } from "../src/backend.js";

const LIST = {
  object: "list",
  data: [
    { id: "hy3", name: "Hy3", status: "online" },
    { id: "hy-image-v3", name: "Hy-Image-3.0", status: "online" },
    { id: "kling-video-v3", name: "Kling-Video-V3", status: "pre-offline" },
    { id: "vidu-video-q3", name: "Vidu-Video-q3", status: "online" },
    { id: "hy-3d-3.1", name: "HY-3D-3.1", status: "online" },
    { id: "minimax-speech-2.8-hd", name: "MiniMax Speech", status: "online" },
    { id: "old-model", name: "Old", status: "offline" },
    { id: "hy3", name: "Hy3 duplicate", status: "online" }
  ]
};

describe("TokenHub 模型发现", () => {
  it("保留在线和即将下线的文本、图片、视频，丢掉没有协议的模型", () => {
    expect(parseModelList(LIST)).toEqual([
      { id: "hy-image-v3", modelType: "image", title: "Hy-Image-3.0" },
      { id: "hy3", modelType: "language", title: "Hy3" },
      { id: "kling-video-v3", modelType: "video", title: "Kling-Video-V3" }
    ]);
    expect(classifyListedModel("kinfra-text-embedding-0.6b")).toBeUndefined();
    expect(classifyListedModel("wand-vega-image-pro")).toBeUndefined();
  });

  it("把发现结果注册成可执行模型", async () => {
    const { registration } = createTokenHubRegistration({
      apiKey: "key",
      baseUrl: "https://tokenhub.tencentmaas.com",
      fetchImpl: vi.fn() as typeof fetch,
      models: parseModelList(LIST)
    });
    expect(registration.available).toBe(true);
    expect(registration.models.map((model) => `${model.modelType}:${model.providerModelId}`)).toEqual([
      "image:hy-image-v3",
      "language:hy3",
      "video:kling-video-v3"
    ]);
    expect((await registration.describeModel?.(registration.models[0]!))?.modelType).toBe("image");
  });

  it("用 Bearer 读取 /v1/models，地址末尾的 /v1 不重复", async () => {
    const fetchImpl = vi.fn(async () => Response.json(LIST));
    const result = await discoverTokenHubModels({
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      apiKey: "secret",
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://tokenhub.tencentmaas.com/v1/models", expect.objectContaining({
      method: "GET",
      headers: { authorization: "Bearer secret", accept: "application/json" }
    }));
  });

  it("目录接口失败时返回原因", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await discoverTokenHubModels({
      baseUrl: "https://tokenhub.tencentmaas.com",
      apiKey: "secret",
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(result).toEqual({ ok: false, message: "读取 TokenHub 模型目录失败（HTTP 401）" });
  });
});
