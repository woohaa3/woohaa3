import { describe, expect, it, vi } from "vitest";
import { createReplicateProvider, type ReplicateCatalog } from "../src/provider.js";
import type { ReplicateModel } from "../src/schema.js";

const VERSION = "c".repeat(64);
const IMAGE = new Uint8Array([9, 8, 7]);

function model(partial: Pick<ReplicateModel, "id" | "modelType"> & Partial<ReplicateModel>): ReplicateModel {
  return {
    version: VERSION,
    title: partial.id,
    promptRequirement: "required",
    inputSchema: {},
    defaultInput: {},
    allowed: ["prompt"],
    promptKey: "prompt",
    ...partial
  };
}

function harness(models: ReplicateModel[]) {
  const catalog: ReplicateCatalog = { models };
  const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, ...(body === undefined ? {} : { body }), authorization: headers.get("authorization") });
    if (url === "https://replicate.delivery/out.png") {
      return new Response(IMAGE, { headers: { "content-type": "image/png" } });
    }
    if (method === "POST" && url.endsWith("/predictions")) {
      return Response.json({ id: "pred-1", status: "starting" });
    }
    if (url.endsWith("/predictions/pred-1/cancel")) {
      return Response.json({ id: "pred-1", status: "canceled" });
    }
    if (url.endsWith("/predictions/pred-1")) {
      const current = catalog.models[0];
      if (current?.modelType === "language") {
        return Response.json({ id: "pred-1", status: "succeeded", output: ["hello", " world"] });
      }
      if (current?.modelType === "video") {
        return Response.json({ id: "pred-1", status: "succeeded", output: "https://replicate.delivery/out.mp4" });
      }
      return Response.json({ id: "pred-1", status: "succeeded", output: ["https://replicate.delivery/out.png"] });
    }
    return new Response("missing", { status: 404 });
  });
  const provider = createReplicateProvider({
    apiKey: "r8_test",
    baseURL: "https://api.replicate.com/v1",
    catalog,
    fetch: fetchImpl as typeof fetch,
    pollIntervalMs: 1
  });
  return { provider, requests };
}

describe("Replicate 预测请求", () => {
  it("用 owner/name:version 提交图片，并把参考图映到 image", async () => {
    const { provider, requests } = harness([model({
      id: "black-forest-labs/flux-schnell",
      modelType: "image",
      allowed: ["prompt", "image", "aspect_ratio"],
      image: { key: "image", many: false }
    })]);
    const result = await (await provider.jobs.start<{ images: Uint8Array[] }>({
      model: provider.imageModel("black-forest-labs/flux-schnell"),
      input: { prompt: "a cat", urls: ["https://cdn.example/in.png"], aspect_ratio: "16:9", n: 1 }
    })).wait();

    expect(requests[0]).toMatchObject({
      url: "https://api.replicate.com/v1/predictions",
      method: "POST",
      authorization: "Bearer r8_test",
      body: {
        version: `black-forest-labs/flux-schnell:${VERSION}`,
        input: { prompt: "a cat", image: "https://cdn.example/in.png", aspect_ratio: "16:9" }
      }
    });
    expect(result.images[0]).toEqual(IMAGE);
  });

  it("把语言模型的流式字符串拼成一段文本", async () => {
    const { provider, requests } = harness([model({ id: "meta/llama", modelType: "language" })]);
    const result = await (await provider.jobs.start<{ content: Array<{ text?: string }> }>({
      model: provider.languageModel("meta/llama"),
      input: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    })).wait();
    expect(requests[0]?.body).toMatchObject({
      input: { prompt: "hi" }
    });
    expect(result.content?.[0]?.text).toBe("hello world");
  });

  it("视频完成时保留输出地址，并可以取消预测", async () => {
    const { provider, requests } = harness([model({ id: "owner/clip", modelType: "video" })]);
    const job = await provider.jobs.start<{ videos: Array<{ url: string }> }>({
      model: provider.videoModel("owner/clip"),
      input: { prompt: "pan" }
    });
    const result = await job.wait();
    expect(result.videos[0]?.url).toBe("https://replicate.delivery/out.mp4");

    const cancelJob = await provider.jobs.start({
      model: provider.videoModel("owner/clip"),
      input: { prompt: "stop" }
    });
    await cancelJob.cancel();
    expect(requests.some((request) => request.url.endsWith("/predictions/pred-1/cancel") && request.method === "POST")).toBe(true);
  });
});
