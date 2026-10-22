import { describe, expect, it, vi } from "vitest";
import { ARK_CONFIG } from "../src/backend.js";
import { createArkImageMaterializer, resolveArkAssetConfig, type ArkAssetSettings } from "../src/assets.js";
import { createArkProvider } from "../src/provider/index.js";

const settings: ArkAssetSettings = {
  groupId: "group-1",
  projectName: "default",
  region: "cn-beijing",
  service: "ark",
  endpoint: "https://ark.cn-beijing.volcengineapi.com",
  pollIntervalMs: 1,
  pollTimeoutMs: 2000
};
const keys = { accessKeyId: "access", secretAccessKey: "secret" };
const config = resolveArkAssetConfig(settings, keys)!;

describe("Ark 素材库配置", () => {
  it("未配置关闭，完整配置启用", () => {
    expect(resolveArkAssetConfig({ ...settings, groupId: undefined }, {})).toBeUndefined();
    expect(config).toMatchObject({ groupId: "group-1", region: "cn-beijing", pollIntervalMs: 1, accessKeyId: "access" });
  });
  it("部分配置报错且不泄露凭据；无效轮询参数被 Config schema 拒绝", () => {
    expect(() => resolveArkAssetConfig({ ...settings, groupId: undefined }, { accessKeyId: "private" })).toThrow(/secretAccessKey、groupId/);
    expect(() => resolveArkAssetConfig({ ...settings, groupId: undefined }, { accessKeyId: "private" })).not.toThrow(/private/);
    const result = ARK_CONFIG["~standard"].validate({ assetPollIntervalMs: -1 });
    expect("issues" in result && result.issues[0]?.message).toMatch(/assetPollIntervalMs/);
  });
});

it("Processing → Active 后提交素材 URI，保留角色和顺序，重复图只创建一次", async () => {
  let polls = 0;
  const bodies: Record<string, any>[] = [];
  const actions: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const action = new URL(String(url)).searchParams.get("Action") ?? "generate";
    actions.push(action);
    bodies.push(JSON.parse(String(init?.body)));
    if (action === "CreateAsset") return Response.json({ Result: { Id: "asset-1" } });
    if (action === "GetAsset") return Response.json({ Result: { Status: ++polls === 1 ? "Processing" : "Active" } });
    return Response.json({ id: "task-1" });
  });
  const model = createArkProvider({ apiKey: "key", materializeImage: createArkImageMaterializer(config, fetcher), fetch: fetcher }).videoModel("doubao-seedance-2-0-260128");
  await model.doStart!({ prompt: "p", n: 1, providerOptions: { ark: {
    urls: [{ url: "https://cdn/image.png", role: "first_frame" }, { url: "https://cdn/image.png", role: "last_frame" }, "asset://existing"],
    videoUrls: ["https://cdn/video.mp4"]
  } } } as never);
  expect(actions).toEqual(["CreateAsset", "GetAsset", "GetAsset", "generate"]);
  expect(bodies[0]).toMatchObject({ GroupId: "group-1", URL: "https://cdn/image.png", AssetType: "Image" });
  expect(bodies.at(-1)?.content).toEqual([
    { type: "text", text: "p" },
    { type: "image_url", role: "first_frame", image_url: { url: "asset://asset-1" } },
    { type: "image_url", role: "last_frame", image_url: { url: "asset://asset-1" } },
    { type: "image_url", role: "reference_image", image_url: { url: "asset://existing" } },
    { type: "video_url", role: "reference_video", video_url: { url: "https://cdn/video.mp4" } }
  ]);
});

it("拒绝素材时不提交生成请求", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const action = new URL(String(url)).searchParams.get("Action");
    return Response.json({ Result: action === "CreateAsset" ? { Id: "a" } : { Status: "Rejected" } });
  });
  const model = createArkProvider({ apiKey: "k", materializeImage: createArkImageMaterializer(config, fetcher), fetch: fetcher }).videoModel("doubao-seedance-2-0-260128");
  await expect(model.doStart!({ prompt: "p", providerOptions: { ark: { urls: ["https://cdn/i.png"] } } } as never)).rejects.toThrow("Rejected");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("轮询超时以及取消均停止等待", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ Result: { Id: "a", Status: "Processing" } }));
  const materialize = createArkImageMaterializer({ ...config, pollTimeoutMs: 15, pollIntervalMs: 1 }, fetcher);
  await expect(materialize("https://cdn/i.png")).rejects.toThrow("超时");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(materialize("https://cdn/i.png", controller.signal)).rejects.toThrow("cancelled");
});
