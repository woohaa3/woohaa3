import { describe, expect, it, vi } from "vitest";
import {
  cephalonModelDefinitions,
  classifyModelType,
  discoverCephalonModels,
  parseModelList,
  safeReason
} from "../src/discovery.js";
import { CEPHALON_MODELS_PATH, CEPHALON_ORIGIN, CEPHALON_PLUGIN_METADATA, CEPHALON_PROVIDER_ID } from "../src/shared.js";
import MODELS from "./fixtures/models.json";

describe("端脑云模型发现", () => {
  it("身份与地址是常量", () => {
    expect(CEPHALON_ORIGIN).toBe("https://cephalon.cloud");
    expect(CEPHALON_MODELS_PATH).toBe("/user-center/v1/models");
    expect(CEPHALON_PROVIDER_ID).toBe("cephalon");
    expect(CEPHALON_PLUGIN_METADATA.extensionId).toBe("cephalon-provider");
    expect(CEPHALON_PLUGIN_METADATA.host).toBe("backend");
  });

  it("真实 37 条响应：31 文本 / 1 图片 / 3 视频，reader 与 search 被跳过", () => {
    const models = parseModelList(MODELS);
    const counts = models.reduce<Record<string, number>>((acc, model) => {
      acc[model.modelType] = (acc[model.modelType] ?? 0) + 1;
      return acc;
    }, {});
    expect(models).toHaveLength(35);
    expect(counts).toEqual({ language: 31, image: 1, video: 3 });
    const ids = models.map((model) => model.id);
    expect(ids).not.toContain("reader");
    expect(ids).not.toContain("apiSearchBrave");
    expect(ids).toContain("NanoBanana2");
    expect(ids).toContain("seedance-2.5");
  });

  it("模态只看 model_type：picture 映射 image，未知值跳过且不按 id 猜", () => {
    expect(classifyModelType("language")).toBe("language");
    expect(classifyModelType("picture")).toBe("image");
    expect(classifyModelType("video")).toBe("video");
    expect(classifyModelType("reader")).toBeUndefined();
    expect(classifyModelType("search")).toBeUndefined();
    expect(classifyModelType("embedding")).toBeUndefined();
    expect(classifyModelType(undefined)).toBeUndefined();

    const models = parseModelList({
      data: [
        { id: "some-image-looking-name", model_type: "search" },
        { id: "image-model-id-but-language", model_type: "language" },
        { id: "unknown-type", model_type: "audio" }
      ]
    });
    expect(models).toEqual([{ id: "image-model-id-but-language", modelType: "language", title: "image-model-id-but-language" }]);
  });

  it("视觉能力与输出上限只取平台声明，缺省不带", () => {
    const models = parseModelList(MODELS);
    const vision = models.find((model) => model.id === "deepseek-v4-flash");
    expect(vision).toMatchObject({ supportsVision: true, maxOutputTokens: 393216 });
    const noMeta = models.find((model) => model.id === "nexus-router");
    expect(noMeta).not.toHaveProperty("supportsVision");
    expect(noMeta).not.toHaveProperty("maxOutputTokens");
    // 图片与视频没有参数元数据：不伪造能力。
    const image = models.find((model) => model.id === "NanoBanana2");
    expect(image).not.toHaveProperty("supportsVision");
    expect(image).not.toHaveProperty("maxOutputTokens");
  });

  it("顺序稳定：先文本、再图片、再视频，同模态保持平台顺序，且无重复", () => {
    const models = parseModelList(MODELS);
    const order = models.map((model) => model.modelType);
    expect(order.indexOf("image")).toBeGreaterThan(order.lastIndexOf("language"));
    expect(order.indexOf("video")).toBeGreaterThan(order.lastIndexOf("image"));
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);

    const duplicated = parseModelList({
      data: [
        { id: "b", model_type: "video" },
        { id: "a", model_type: "language" },
        { id: "a", model_type: "language" }
      ]
    });
    expect(duplicated.map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("模型定义身份为 cephalon:<id>，标题取平台 id", () => {
    const definitions = cephalonModelDefinitions(parseModelList(MODELS));
    expect(definitions).toHaveLength(35);
    expect(definitions.every((definition) => definition.providerId === "cephalon")).toBe(true);
    const seedance = definitions.find((definition) => definition.providerModelId === "seedance-2.5");
    expect(seedance).toMatchObject({
      providerId: "cephalon",
      providerModelId: "seedance-2.5",
      modelType: "video",
      title: "seedance-2.5",
      promptRequirement: "required",
      // 平台没有取消端点。
      cancel: "unsupported"
    });
  });

  it("用 Bearer 读取固定地址的模型列表", async () => {
    const fetchImpl = vi.fn(async () => Response.json(MODELS));
    const result = await discoverCephalonModels({ apiKey: "secret-key", fetchImpl: fetchImpl as typeof fetch });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cephalon.cloud/user-center/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer secret-key", accept: "application/json" }
      })
    );
  });

  it("非 2xx 返回稳定原因", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await discoverCephalonModels({ apiKey: "secret-key", fetchImpl: fetchImpl as typeof fetch });
    expect(result).toEqual({ ok: false, message: "读取端脑云模型目录失败（HTTP 401）" });
  });

  it("超时与不可解析的响应都判定失败", async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    await expect(discoverCephalonModels({ apiKey: "k", fetchImpl: timeout as unknown as typeof fetch })).resolves.toEqual({
      ok: false,
      message: "读取端脑云模型目录失败：请求超时"
    });

    const notJson = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(discoverCephalonModels({ apiKey: "k", fetchImpl: notJson as unknown as typeof fetch })).resolves.toEqual({
      ok: false,
      message: "读取端脑云模型目录失败：响应不是合法 JSON"
    });

    const noData = vi.fn(async () => Response.json({ object: "list" }));
    await expect(discoverCephalonModels({ apiKey: "k", fetchImpl: noData as unknown as typeof fetch })).resolves.toEqual({
      ok: false,
      message: "读取端脑云模型目录失败：响应缺少模型列表"
    });
  });

  it("空 data 是合法的空目录，不是失败", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ object: "list", data: [] }));
    await expect(discoverCephalonModels({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch })).resolves.toEqual({
      ok: true,
      models: []
    });
  });

  it("错误原因不含 API Key", () => {
    const key = "sk-very-secret-value";
    const reason = safeReason(new Error(`failed for ${key} at https://cephalon.cloud`), key);
    expect(reason).not.toContain(key);
    expect(reason).toContain("[redacted]");
    expect(safeReason(new Error("   "))).toBe("请求失败");
  });
});
