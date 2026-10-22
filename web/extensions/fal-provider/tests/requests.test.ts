import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createFalProvider, type FalCatalog } from "../src/provider.js";
import { classifyFalModel, type FalModel } from "../src/schema.js";

const IMAGE = new Uint8Array([9, 8, 7]);

function model(fixture: string, id: string): FalModel {
  const parsed = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url)), "utf8"));
  const result = classifyFalModel(id, parsed);
  if (!result) throw new Error(`fixture ${fixture} 不是可执行模型`);
  return result;
}

function harness(models: FalModel[]) {
  const catalog: FalCatalog = { models };
  const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, ...(body === undefined ? {} : { body }), authorization: headers.get("authorization") });
    if (url === "https://v3.fal.media/out.png") return new Response(IMAGE, { headers: { "content-type": "image/png" } });
    if (!url.startsWith("https://queue.fal.run/")) return new Response("missing", { status: 404 });
    if (method === "POST") return Response.json({ request_id: "req-1", status: "IN_QUEUE", queue_position: 0 });
    if (method === "PUT") return Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 });
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED", request_id: "req-1" });
    const current = catalog.models[0];
    if (current?.modelType === "language") return Response.json({ output: "hello world", partial: false });
    if (current?.modelType === "video") return Response.json({ video: { url: "https://v2.fal.media/out.mp4", content_type: "video/mp4" } });
    return Response.json({ images: [{ url: "https://v3.fal.media/out.png", width: 1024, height: 1024, content_type: "image/png" }] });
  });
  const provider = createFalProvider({
    apiKey: "fal_test",
    baseURL: "https://queue.fal.run/",
    catalog,
    fetch: fetchImpl as typeof fetch,
    pollIntervalMs: 1
  });
  return { provider, requests };
}

describe("fal 队列请求", () => {
  it("提交时把画布字段映成 endpoint 输入，并用 Key 认证", async () => {
    const { provider, requests } = harness([model("flux-schnell", "fal-ai/flux/schnell")]);
    const result = await (await provider.jobs.start<{ images: Uint8Array[] }>({
      model: provider.imageModel("fal-ai/flux/schnell"),
      input: { prompt: "a cat", num_inference_steps: 6, n: 2 }
    })).wait();

    expect(requests[0]).toMatchObject({
      url: "https://queue.fal.run/fal-ai/flux/schnell",
      method: "POST",
      authorization: "Key fal_test",
      body: { prompt: "a cat", num_inference_steps: 6, num_images: 2 }
    });
    expect(requests.some((request) => request.url === "https://queue.fal.run/fal-ai/flux/schnell/requests/req-1/status")).toBe(true);
    // 图片由共享输出解析下载，媒体地址不再带凭据。
    expect(requests.find((request) => request.url === "https://v3.fal.media/out.png")?.authorization).toBeNull();
    expect(result.images[0]).toEqual(IMAGE);
  });

  it("视频完成时保留地址，文本收成一段文本", async () => {
    const video = harness([model("kling-text-to-video", "fal-ai/kling-video/v1.6/standard/text-to-video")]);
    const clip = await (await video.provider.jobs.start<{ videos: Array<{ url: string }> }>({
      model: video.provider.videoModel("fal-ai/kling-video/v1.6/standard/text-to-video"),
      input: { prompt: "pan" }
    })).wait();
    expect(clip.videos[0]?.url).toBe("https://v2.fal.media/out.mp4");

    const llm = harness([model("any-llm", "fal-ai/any-llm")]);
    const answer = await (await llm.provider.jobs.start<{ content: Array<{ text?: string }> }>({
      model: llm.provider.languageModel("fal-ai/any-llm"),
      input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    })).wait();
    expect(answer.content?.[0]?.text).toBe("hello world");
    expect(llm.requests[0]?.body).toEqual({ prompt: "hi" });
  });

  it("取消走 PUT，已经结束的请求不报错", async () => {
    const { provider, requests } = harness([model("kling-text-to-video", "fal-ai/kling-video/v1.6/standard/text-to-video")]);
    const job = await provider.jobs.start({
      model: provider.videoModel("fal-ai/kling-video/v1.6/standard/text-to-video"),
      input: { prompt: "stop" }
    });
    await job.cancel();
    expect(requests.some((request) => request.method === "PUT" && request.url.endsWith("/requests/req-1/cancel"))).toBe(true);
  });

  it("未登记的模型直接报错，类型不符也拒绝", async () => {
    const { provider } = harness([model("flux-schnell", "fal-ai/flux/schnell")]);
    expect(() => provider.imageModel("fal-ai/not-there")).toThrow(/未登记/);
    expect(() => provider.videoModel("fal-ai/flux/schnell")).toThrow(/类型是 image/);
  });
});
