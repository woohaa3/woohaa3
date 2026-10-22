import { describe, expect, it, vi } from "vitest";
import { classifyListedModel, discoverGrsaiModels, grsaiModelDefinitions, parseModelList } from "../src/discovery.js";

const LIST = {
  code: 0,
  msg: "success",
  data: {
    list: [
      { name: "minimax-h3", type: "video", closeModel: false, maintenance: "", cost: 0 },
      { name: "nano-banana-2", type: "image", closeModel: false, maintenance: "" },
      { name: "nano-banana-2-lite", type: "image", closeModel: true, maintenance: "该模型修复中" },
      { name: "gpt-image-2.5-sunburst", type: "image", closeModel: true, maintenance: "维护中，模型正在修复" },
      { name: "gemini-2.5-pro", type: "text", closeModel: true, maintenance: "该模型修复中" },
      { name: "gpt-5.5", type: "text", closeModel: false, maintenance: "" },
      { name: "some-3d-thing", type: "3d", closeModel: false, maintenance: "" }
    ]
  }
};

describe("grsai 模型发现", () => {
  it("跳过下线/维护中的模型与不支持的类型", () => {
    const models = parseModelList(LIST);
    expect(models.map((model) => `${model.kind}:${model.id}`)).toEqual([
      "image:nano-banana-2",
      "language:gpt-5.5",
      "video:minimax-h3"
    ]);
    expect(grsaiModelDefinitions(models)[0]).toMatchObject({ providerId: "grsai", providerModelId: "nano-banana-2", modelType: "image" });
    expect(classifyListedModel("IMAGE")).toBe("image");
    expect(classifyListedModel("chat")).toBe("language");
    expect(classifyListedModel("audio")).toBeUndefined();
  });

  it("调用公开模型表接口，不需要 Key", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(LIST));
    const result = await discoverGrsaiModels({ baseUrl: "https://grsai.dakka.com.cn/", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://grsai.dakka.com.cn/client/serverGrsai/getModelListV2");
    expect(call[1].method).toBe("POST");
    expect(new Headers(call[1].headers).get("authorization")).toBeNull();
  });

  it("接口失败或没有可用模型时报原因", async () => {
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await discoverGrsaiModels({ baseUrl: "https://g.test", fetchImpl: failing as unknown as typeof fetch }))
      .toEqual({ ok: false, message: "读取 grsai 模型表失败（HTTP 500）" });

    const empty = vi.fn(async () => Response.json({ code: 0, data: { list: [] } }));
    const result = await discoverGrsaiModels({ baseUrl: "https://g.test", fetchImpl: empty as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, message: "模型表里没有可用的图片、视频或文本模型" });

    const denied = vi.fn(async () => Response.json({ code: -1, msg: "apikey error" }));
    expect(await discoverGrsaiModels({ baseUrl: "https://g.test", fetchImpl: denied as unknown as typeof fetch }))
      .toEqual({ ok: false, message: "apikey error" });
  });
});
