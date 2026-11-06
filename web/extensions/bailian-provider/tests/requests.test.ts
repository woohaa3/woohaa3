import { describe, expect, it, vi } from "vitest";
import { createBailianProvider } from "../src/provider.js";
import { createBailianRegistration } from "../src/backend.js";

const IMAGE = new Uint8Array([1, 2, 3]);
const ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

type Captured = { url: string; method: string; authorization: string | null; body?: Record<string, unknown> };

const SUCCESS = {
  output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: "https://oss.example/out.png" }] } }] },
  usage: { image_count: 1, width: 2048, height: 2048 },
  request_id: "req-1"
};

function harness(payload: unknown = SUCCESS, status = 200) {
  const requests: Captured[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oss.example/out.png") {
      return new Response(IMAGE, { headers: { "content-type": "image/png" } });
    }
    const headers = new Headers(init?.headers);
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    requests.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      ...(body === undefined ? {} : { body })
    });
    return Response.json(payload, { status });
  });
  const provider = createBailianProvider({
    apiKey: "sk-secret",
    baseURL: "https://dashscope.aliyuncs.com/",
    fetch: fetchImpl as unknown as typeof fetch
  });
  return { provider, requests };
}

describe("百炼请求", () => {
  it("文生图发单轮多模态请求并下载输出", async () => {
    const { provider, requests } = harness();
    const result = await provider.imageModel("qwen-image-2.0-pro").doGenerate?.({
      prompt: "一只猫",
      aspectRatio: "16:9",
      resolution: "2K"
    } as never);

    expect(requests[0]).toMatchObject({
      url: ENDPOINT,
      method: "POST",
      authorization: "Bearer sk-secret"
    });
    expect(requests[0]?.body).toMatchObject({
      model: "qwen-image-2.0-pro",
      input: { messages: [{ role: "user", content: [{ text: "一只猫" }] }] },
      parameters: { size: "2688*1536", watermark: false, prompt_extend: true }
    });
    // 任务服务只落第一张图，所以永远不请求 n>1。
    expect(requests[0]?.body).not.toHaveProperty("input.messages.0.content.0.image");
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(IMAGE);
  });

  it("参考图排在文本之前，并受模型上限约束", async () => {
    const { provider, requests } = harness();
    await provider.imageModel("qwen-image-2.0").doGenerate?.({
      prompt: "把两张图合成一张",
      urls: ["https://oss.example/a.png", "https://oss.example/b.png", "https://oss.example/c.png", "https://oss.example/d.png"],
      aspectRatio: "1:1",
      resolution: "2K"
    } as never);

    const content = (requests[0]?.body?.input as { messages: Array<{ content: unknown[] }> }).messages[0]?.content;
    // qwen-image-2.0 只收三张参考图：第四张必须被丢掉而不是让上游报错。
    expect(content).toEqual([
      { image: "https://oss.example/a.png" },
      { image: "https://oss.example/b.png" },
      { image: "https://oss.example/c.png" },
      { text: "把两张图合成一张" }
    ]);
  });

  it("只有声明支持的模型才发 negative_prompt 与 prompt_extend", async () => {
    const { provider, requests } = harness();
    await provider.imageModel("qwen-image-2.0-pro").doGenerate?.({
      prompt: "一只猫",
      negativePrompt: "低清",
      promptExtend: false,
      aspectRatio: "1:1",
      resolution: "2K"
    } as never);
    expect(requests[0]?.body?.parameters).toMatchObject({ negative_prompt: "低清", prompt_extend: false });

    const wan = harness();
    await wan.provider.imageModel("wan2.7-image-pro").doGenerate?.({
      prompt: "一只猫",
      negativePrompt: "低清",
      promptExtend: true,
      aspectRatio: "1:1",
      resolution: "4K"
    } as never);
    const parameters = wan.requests[0]?.body?.parameters as Record<string, unknown>;
    expect(parameters).toEqual({ size: "4096*4096", watermark: false });
  });

  it("万相 4K 只给文生图：带参考图时压回 2K", async () => {
    const { provider, requests } = harness();
    // 纯文生图按 4K 走。
    await provider.imageModel("wan2.7-image-pro").doGenerate?.({
      prompt: "一只猫",
      aspectRatio: "16:9",
      resolution: "4K"
    } as never);
    expect(requests[0]?.body?.parameters).toMatchObject({ size: "4096*2304" });

    // 带参考图时 4K 上游会 400，插件自己压回 2K。
    await provider.imageModel("wan2.7-image-pro").doGenerate?.({
      prompt: "改一下这张图",
      urls: ["https://oss.example/a.png"],
      aspectRatio: "16:9",
      resolution: "4K"
    } as never);
    expect(requests[1]?.body?.parameters).toMatchObject({ size: "2688*1536" });
  });

  it("z-image 只能文生图，参考图被忽略", async () => {
    const { provider, requests } = harness();
    await provider.imageModel("z-image-turbo").doGenerate?.({
      prompt: "一只猫",
      urls: ["https://oss.example/a.png"],
      aspectRatio: "2:3",
      resolution: "1K"
    } as never);
    expect((requests[0]?.body?.input as { messages: Array<{ content: unknown[] }> }).messages[0]?.content).toEqual([
      { text: "一只猫" }
    ]);
    expect(requests[0]?.body?.parameters).toMatchObject({ size: "1024*1536" });
  });

  it("把 DashScope 的业务错误翻成人能读的原因", async () => {
    // 参数错误与审核失败都是 HTTP 400，业务原因只在 body 的 code/message 里。
    const { provider } = harness({
      request_id: "req-2",
      code: "DataInspectionFailed",
      message: "Input data may contain inappropriate content."
    }, 400);
    await expect(
      provider.imageModel("qwen-image-2.0").doGenerate?.({ prompt: "违禁内容" } as never)
    ).rejects.toThrow(/内容审核.*HTTP 400/);

    const throttled = harness({ request_id: "req-3", code: "Throttling", message: "Requests rate limit exceeded." }, 429);
    await expect(
      throttled.provider.imageModel("qwen-image-2.0").doGenerate?.({ prompt: "一只猫" } as never)
    ).rejects.toThrow(/限流/);
  });

  it("200 但 body 里带错误码时也当失败", async () => {
    const { provider } = harness({ request_id: "req-4", code: "InvalidParameter", message: "size is invalid." });
    await expect(
      provider.imageModel("qwen-image-2.0").doGenerate?.({ prompt: "一只猫" } as never)
    ).rejects.toThrow(/size is invalid/);
  });

  it("未配置 Key 时不注册 provider，但仍列出模型", () => {
    const registration = createBailianRegistration({ apiKey: "", baseUrl: "https://dashscope.aliyuncs.com" });
    expect(registration.available).toBe(false);
    expect(registration.provider).toBeUndefined();
    expect(registration.models.length).toBeGreaterThan(0);
    expect(registration.models.every((model) => model.modelType === "image")).toBe(true);
  });

  it("注册的每个模型都能被 describe 出参数面板", async () => {
    const registration = createBailianRegistration({ apiKey: "sk-secret", baseUrl: "https://dashscope.aliyuncs.com" });
    for (const model of registration.models) {
      const description = await registration.describeModel?.(model);
      expect(description?.inputSchema).toMatchObject({ type: "object", required: ["prompt"] });
      expect(description?.defaultInput).toMatchObject({ prompt: "" });
    }
  });

  it("拒绝非生图模型类型与未登记模型", () => {
    const { provider } = harness();
    expect(() => provider.languageModel("qwen-image-2.0")).toThrow();
    expect(() => provider.imageModel("wan9.9-image")).toThrow(/未登记/);
  });
});
