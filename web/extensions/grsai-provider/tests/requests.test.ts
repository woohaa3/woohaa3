import { describe, expect, it, vi } from "vitest";
import type { GrsaiModel } from "../src/discovery.js";
import type { PptaskProvider } from "@sdppp/pptask";
import { createGrsaiProvider } from "../src/provider.js";
import { createGrsaiRegistration } from "../src/backend.js";

const IMAGE = new Uint8Array([1, 2, 3]);

const imageModel: GrsaiModel = { id: "nano-banana-2", kind: "image", title: "nano-banana-2" };
const videoModel: GrsaiModel = { id: "minimax-h3", kind: "video", title: "minimax-h3" };
const textModel: GrsaiModel = { id: "gpt-5.5", kind: "language", title: "gpt-5.5" };

function harness(models: GrsaiModel[], options: { resultStatus?: number } = {}) {
  const catalog = { models };
  const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, ...(body === undefined ? {} : { body }), authorization: headers.get("authorization") });
    if (url === "https://files.test/a.png") return new Response(IMAGE, { headers: { "content-type": "image/png" } });
    if (url.endsWith("/v1/api/generate")) return Response.json({ id: "gr-1", status: "running" });
    if (url.includes("/v1/api/result")) {
      if (options.resultStatus && options.resultStatus !== 200) {
        return Response.json({ error: "result not exist, valid for 2 hours" }, { status: options.resultStatus });
      }
      if (catalog.models[0]?.kind === "video") {
        return Response.json({ id: "gr-1", status: "succeeded", progress: 100, results: [{ url: "https://files.test/out.mp4" }] });
      }
      return Response.json({ id: "gr-1", status: "succeeded", progress: 100, results: [{ url: "https://files.test/a.png" }] });
    }
    if (url.endsWith("/v1/chat/completions")) return Response.json({ choices: [{ message: { content: "你好" } }], usage: {} });
    return new Response("missing", { status: 404 });
  });
  const provider = createGrsaiProvider({
    apiKey: "test-key",
    baseURL: "https://grsai.dakka.com.cn/",
    catalog,
    fetch: fetchImpl as typeof fetch,
    pollIntervalMs: 1
  });
  return { provider, requests };
}

describe("grsai 请求", () => {
  it("图片用统一生成接口提交并下载输出", async () => {
    const { provider, requests } = harness([imageModel]);
    const result = await (await provider.jobs.start<{ images: Uint8Array[] }>({
      model: provider.imageModel("nano-banana-2"),
      input: { prompt: "a cat", urls: ["https://files.test/ref.png"], imageSize: "2K", aspectRatio: "" }
    })).wait();

    expect(requests[0]).toMatchObject({
      url: "https://grsai.dakka.com.cn/v1/api/generate",
      method: "POST",
      authorization: "Bearer test-key",
      body: { model: "nano-banana-2", prompt: "a cat", replyType: "async", images: ["https://files.test/ref.png"], imageSize: "2K" }
    });
    expect(requests.some((request) => request.url === "https://grsai.dakka.com.cn/v1/api/result?id=gr-1")).toBe(true);
    expect(result.images[0]).toEqual(IMAGE);
  });

  it("视频完成时保留地址", async () => {
    const { provider, requests } = harness([videoModel]);
    const result = await (await provider.jobs.start<{ videos: Array<{ url: string }> }>({
      model: provider.videoModel("minimax-h3"),
      input: { prompt: "pan", resolution: "1080p", duration: 8 }
    })).wait();
    expect(requests[0]?.body).toMatchObject({ model: "minimax-h3", prompt: "pan", replyType: "async", resolution: "1080p", duration: 8 });
    expect(result.videos[0]?.url).toBe("https://files.test/out.mp4");
  });

  it("文本走 Chat Completions", async () => {
    const { provider, requests } = harness([textModel]);
    const result = await provider.languageModel("gpt-5.5").doGenerate?.({
      prompt: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
      maxOutputTokens: 32
    } as never);
    expect(requests[0]).toMatchObject({ url: "https://grsai.dakka.com.cn/v1/chat/completions", method: "POST", authorization: "Bearer test-key" });
    expect(requests[0]?.body).toMatchObject({ model: "gpt-5.5", max_tokens: 32 });
    expect(result?.content?.[0]).toMatchObject({ type: "text", text: "你好" });
  });

  it("结果过期（HTTP 404）按失败收口，未登记的模型直接拒绝", async () => {
    const { provider } = harness([imageModel], { resultStatus: 404 });
    const job = await provider.jobs.start({
      model: provider.imageModel("nano-banana-2"),
      input: { prompt: "a cat" }
    });
    await expect(job.wait()).rejects.toThrow(/result not exist/);

    expect(() => provider.imageModel("nope")).toThrow(/未登记/);
    expect(() => provider.videoModel("nano-banana-2")).toThrow(/类型是 image/);
  });
});

describe("grsai registration preserves normalized aspect ratio", () => {
  function registrationHarness(model: GrsaiModel) {
    const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    const { registration } = createGrsaiRegistration({
      apiKey: "test-only-key",
      baseUrl: "https://grsai-registration.test",
      discovered: [model],
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== "https://grsai-registration.test" || url.pathname !== "/v1/api/generate" || init?.method !== "POST") {
          throw new Error("Unexpected request in intercepted registration test");
        }
        requests.push({ path: url.pathname, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json({ id: "intercepted-task", status: "running" });
      }
    });
    if (!registration.provider) throw new Error("Provider was not registered");
    return { provider: registration.provider as PptaskProvider, requests };
  }

  it.each([
    { label: "public camel", parameters: { aspectRatio: "1:1" } },
    { label: "normalized snake", parameters: { aspect_ratio: "1:1" } },
    { label: "public camel over conflicting snake", parameters: { aspectRatio: "1:1", aspect_ratio: "16:9" } }
  ])("sends image aspect ratio from $label through imageModel.doStart", async ({ parameters }) => {
    const { provider, requests } = registrationHarness(imageModel);
    const model = provider.imageModel("nano-banana-2");
    await model.doStart!({ prompt: "a product", ...parameters, imageSize: "1K", urls: ["https://reference.test/product.png"] } as never);
    expect(requests).toEqual([{ path: "/v1/api/generate", method: "POST", body: {
      model: "nano-banana-2", prompt: "a product", replyType: "async", aspectRatio: "1:1", imageSize: "1K",
      images: ["https://reference.test/product.png"]
    } }]);
  });

  it("sends video aspect ratio through the same registration conversion boundary", async () => {
    const { provider, requests } = registrationHarness(videoModel);
    const model = provider.videoModel("minimax-h3");
    await model.doStart!({ prompt: "pan", aspectRatio: "16:9", resolution: "1080p", duration: 8 } as never);
    expect(requests).toEqual([{ path: "/v1/api/generate", method: "POST", body: {
      model: "minimax-h3", prompt: "pan", replyType: "async", aspectRatio: "16:9", resolution: "1080p", duration: 8
    } }]);
  });
});
