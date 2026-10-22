import { describe, expect, it, vi } from "vitest";
import { createTokenHubProvider } from "../src/provider.js";

const IMAGE = new Uint8Array([1, 2, 3]);

function harness() {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "https://cdn.example/image.png") {
      return new Response(IMAGE, { headers: { "content-type": "image/png" } });
    }
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    if (url.endsWith("/chat/completions")) {
      return Response.json({
        choices: [{ message: { content: "你好" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      });
    }
    if (url.endsWith("/hunyuan-image/v3-generation")) {
      return Response.json({ data: [{ url: "https://cdn.example/image.png" }] });
    }
    if (url.endsWith("/hunyuan-image/v35-generation")) {
      return Response.json({ data: [{ url: "https://cdn.example/image.png" }] });
    }
    if (url.endsWith("/kling/text-to-video")) {
      return Response.json({ code: 0, data: { id: "task-9", status: "submitted" } });
    }
    if (url.endsWith("/kling/tasks/task-9")) {
      return Response.json({
        code: 0,
        data: [{ status: "succeeded", outputs: [{ type: "video", url: "https://cdn.example/out.mp4" }] }]
      });
    }
    return Response.json({ code: 0 });
  });
  const provider = createTokenHubProvider({
    apiKey: "test-key",
    baseURL: "https://tokenhub.tencentmaas.com",
    fetch: fetchMock as unknown as typeof fetch
  });
  return { provider, requests };
}

describe("TokenHub 请求", () => {
  it("文本走 Chat Completions", async () => {
    const { provider, requests } = harness();
    const result = await provider.languageModel("hy3").doGenerate?.({
      prompt: [
        { role: "system", content: "简洁" },
        { role: "user", content: [{ type: "text", text: "你好" }] }
      ],
      maxOutputTokens: 32,
      providerOptions: { tokenhub: { jsonMode: true } }
    } as never);
    expect(requests[0]).toMatchObject({
      url: "https://tokenhub.tencentmaas.com/v1/chat/completions",
      method: "POST"
    });
    const body = requests[0]?.body as { messages: Array<{ role: string }>; response_format: unknown; max_tokens: number };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.max_tokens).toBe(32);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result && "content" in result ? result.content : []).toEqual([{ type: "text", text: "你好" }]);
  });

  it("混元生图同步返回并下载图片", async () => {
    const { provider, requests } = harness();
    const result = await provider.imageModel("hy-image-v3").doGenerate?.({
      prompt: "一只猫",
      n: 1,
      aspectRatio: "1:1",
      providerOptions: { tokenhub: { resolution: "1K" } }
    } as never);
    expect(requests[0]?.url).toBe("https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation");
    expect(requests[0]?.body).toMatchObject({ model: "hy-image-v3", prompt: "一只猫", size: "1024x1024" });
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(IMAGE);
  });

  it("混元 3.5 自适应不传 size，按分辨率发 generate_max_pixels", async () => {
    const { provider, requests } = harness();
    const result = await provider.imageModel("hy-image-v3.5-preview").doGenerate?.({
      prompt: "一只猫",
      n: 1,
      aspectRatio: "auto",
      providerOptions: { tokenhub: { resolution: "2K" } }
    } as never);
    expect(requests[0]?.url).toBe("https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation");
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: "hy-image-v3.5-preview", generate_max_pixels: 4194304 });
    expect(body).not.toHaveProperty("size");
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(IMAGE);
  });

  it("可灵视频先提交再按任务 ID 查询", async () => {
    const { provider, requests } = harness();
    const video = provider.videoModel("kling-video-v3");
    if (!video.doStart || !video.doStatus) throw new Error("可灵视频应该是异步模型");
    const started = await video.doStart({
      prompt: "一只猫跑过草地",
      n: 1,
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p"
    } as never);
    expect(requests[0]?.url).toBe("https://tokenhub.tencentmaas.com/v1/wand/kling/text-to-video");
    expect(started.operation).toEqual({ taskId: "task-9", family: "kling-video" });
    const status = await video.doStatus({ operation: started.operation } as never);
    expect(requests[1]?.url).toBe("https://tokenhub.tencentmaas.com/v1/wand/kling/tasks/task-9");
    expect(status.status).toBe("completed");
    expect(status.status === "completed" ? status.videos[0] : undefined).toMatchObject({
      type: "url",
      url: "https://cdn.example/out.mp4"
    });
  });
});
