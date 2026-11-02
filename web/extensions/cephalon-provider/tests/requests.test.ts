import { describe, expect, it, vi } from "vitest";
import { createCephalonProvider } from "../src/provider.js";
import type { DiscoveredModel } from "../src/discovery.js";

const MODELS: DiscoveredModel[] = [
  { id: "gemini-3.5-flash", modelType: "language", title: "gemini-3.5-flash", supportsVision: true, maxOutputTokens: 65536 },
  { id: "deepseek-v4-pro", modelType: "language", title: "deepseek-v4-pro", maxOutputTokens: 393216 },
  { id: "NanoBanana2", modelType: "image", title: "NanoBanana2" },
  { id: "seedance-2.5", modelType: "video", title: "seedance-2.5" }
];

const PNG = new Uint8Array([137, 80, 78, 71]);

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

function harness(options: { chatReply?: unknown; imageReply?: unknown } = {}) {
  const calls: Call[] = [];
  let statusCall = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, ...(body === undefined ? {} : { body }) });

    if (url === "https://cdn.example/out.png") {
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/chat/completions")) {
      return Response.json(
        options.chatReply ?? { choices: [{ message: { content: "你好" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
      );
    }
    if (url.endsWith("/images/generations")) {
      return Response.json(options.imageReply ?? { data: [{ url: "https://cdn.example/out.png" }] });
    }
    if (url.endsWith("/video/tasks") && method === "POST") {
      return Response.json({ Response: { RequestId: "r-1", TaskId: "task-1" } });
    }
    if (url.endsWith("/video/tasks/task-1")) {
      statusCall += 1;
      return Response.json(
        statusCall === 1
          ? { Response: { Status: "PROCESSING", AigcVideoTask: { Status: "PROCESSING", Progress: 30 } } }
          : {
              Response: {
                Status: "FINISH",
                AigcVideoTask: {
                  Status: "FINISH",
                  Progress: 100,
                  ErrCode: 0,
                  Output: { FileInfos: [{ FileUrl: "https://cdn.example/out.mp4" }] }
                }
              }
            }
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const provider = createCephalonProvider({
    apiKey: "test-key",
    models: MODELS,
    fetch: fetchMock as unknown as typeof fetch
  });
  return { provider, calls };
}

describe("端脑云请求", () => {
  it("文本走 /chat/completions，参考图按视觉能力下发", async () => {
    const { provider, calls } = harness();
    const result = await provider.languageModel("gemini-3.5-flash").doGenerate?.({
      prompt: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
      maxOutputTokens: 32,
      providerOptions: { cephalon: { urls: ["https://cdn.example/ref.png"], jsonMode: true } }
    } as never);

    expect(calls[0]).toMatchObject({
      url: "https://cephalon.cloud/user-center/v1/model/chat/completions",
      method: "POST"
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({ model: "gemini-3.5-flash", max_tokens: 32 });
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(calls[0]?.body.messages)).toContain("https://cdn.example/ref.png");
    expect(result && "content" in result ? result.content : []).toEqual([{ type: "text", text: "你好" }]);
  });

  it("无视觉能力的模型丢弃参考图，提示词照常执行", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-v4-pro").doGenerate?.({
      prompt: [{ role: "user", content: [{ type: "text", text: "看图" }] }],
      providerOptions: { cephalon: { urls: ["https://cdn.example/ref.png"] } }
    } as never);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("image_url");
    expect(calls[0]?.body.messages).toEqual([{ role: "user", content: "看图" }]);
  });

  it("图片同步提交并下载结果字节", async () => {
    const { provider, calls } = harness();
    const result = await provider.imageModel("NanoBanana2").doGenerate?.({
      prompt: "一只猫",
      n: 1,
      providerOptions: { cephalon: { resolution: "2K" } }
    } as never);
    expect(calls[0]).toMatchObject({
      url: "https://cephalon.cloud/user-center/v1/model/images/generations",
      method: "POST"
    });
    expect(calls[0]?.body).toMatchObject({ model: "NanoBanana2", prompt: "一只猫", size: "2K" });
    expect(calls[1]?.url).toBe("https://cdn.example/out.png");
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(PNG);
  });

  it("图片 b64 结果也能入库", async () => {
    const { provider } = harness({
      imageReply: { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }
    });
    const result = await provider.imageModel("NanoBanana2").doGenerate?.({ prompt: "一只猫" } as never);
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(PNG);
  });

  it("图片空结果按失败结束", async () => {
    const { provider } = harness({ imageReply: { data: [] } });
    await expect(provider.imageModel("NanoBanana2").doGenerate?.({ prompt: "一只猫" } as never)).rejects.toThrow(
      "端脑云没有返回图片"
    );
  });

  it("图片业务错误码按失败结束", async () => {
    const { provider } = harness({ imageReply: { code: 30002, msg: "余额不足，请充值后重试" } });
    await expect(provider.imageModel("NanoBanana2").doGenerate?.({ prompt: "一只猫" } as never)).rejects.toThrow(
      "余额不足，请充值后重试"
    );
  });

  it("视频先提交再用任务 ID 轮询，模型名放 Model-Name 头", async () => {
    const { provider, calls } = harness();
    const video = provider.videoModel("seedance-2.5");
    if (!video.doStart || !video.doStatus) throw new Error("视频模型必须是异步模型");

    const started = await video.doStart({
      prompt: "镜头推进",
      aspectRatio: "16:9",
      resolution: "720P",
      duration: 4,
      inputReferences: [{ type: "url", url: "https://cdn.example/ref.png" }]
    } as never);

    expect(calls[0]?.url).toBe("https://cephalon.cloud/user-center/v1/model/video/tasks");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["model-name"]).toBe("seedance-2.5");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({
      Prompt: "镜头推进",
      OutputConfig: { Resolution: "720P", AspectRatio: "16:9", Duration: 4 }
    });
    expect(calls[0]?.body).not.toHaveProperty("model");
    expect(started.operation).toEqual({ taskId: "task-1" });

    const pending = await video.doStatus({ operation: started.operation } as never);
    expect(calls[1]).toMatchObject({
      url: "https://cephalon.cloud/user-center/v1/model/video/tasks/task-1",
      method: "GET"
    });
    expect(calls[1]?.headers["model-name"]).toBe("seedance-2.5");
    expect(pending).toMatchObject({ status: "pending", phase: "running", progress: 30 });

    const completed = await video.doStatus({ operation: started.operation } as never);
    expect(completed.status).toBe("completed");
    expect(completed.status === "completed" ? completed.videos[0] : undefined).toMatchObject({
      type: "url",
      url: "https://cdn.example/out.mp4"
    });
  });

  it("模态不符时 validateModel 抛错", () => {
    const { provider } = harness();
    expect(() => provider.imageModel("seedance-2.5")).toThrow(/seedance-2\.5/);
    expect(() => provider.videoModel("NanoBanana2")).toThrow(/NanoBanana2/);
    expect(() => provider.languageModel("   ")).toThrow("端脑云模型 id 不能为空");
  });

  it("描述由 provider 自己提供", async () => {
    const { provider } = harness();
    const description = await provider.describe(provider.languageModel("gemini-3.5-flash") as never);
    expect(description).toMatchObject({ providerId: "cephalon", modelId: "gemini-3.5-flash", modelType: "language" });
  });
});
