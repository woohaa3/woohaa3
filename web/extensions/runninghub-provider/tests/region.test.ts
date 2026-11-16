import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNNINGHUB_REGION,
  detectRunningHubRegion,
  runningHubAccountStatusURL,
  runningHubApiBaseURL,
  runningHubCatalogURL,
  runningHubLLMBaseURL,
  runningHubLLMCatalogURL,
  runningHubRegionLabel,
  runningHubUploadURL
} from "../src/region.js";

type Reply = () => Response | Promise<Response>;

function fetchFor(ai: Reply, cn: Reply, urls: string[] = []): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://www.runninghub.cn")) return cn();
    if (url.startsWith("https://www.runninghub.ai")) return ai();
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof globalThis.fetch;
}

/** 上传鉴权通过：空文件在上传接口会得到参数错误，而不是 Key 不存在。 */
const accepted = () => Response.json({ code: 1, msg: "file is required" });
/** 站点认出了 Key，但上传能力拒绝（例如 Key 类型不支持）。 */
const acceptedButRejected = () => Response.json({ code: 801, msg: "APIKEY_UNSUPPORTED_FREE_USER" });
/** 错站：上传接口先返回 Key 不存在。 */
const wrongRegion = () => Response.json({ code: 1, msg: "ApiKey verification failed: API Key不存在" });
const unknownPayload = () => Response.json({});
const networkError = () => {
  throw new Error("offline");
};
const serverError = () => new Response("bad gateway", { status: 502 });

describe("RunningHub 区域地址", () => {
  it("国内站与国际站从同一张表派生全部端点", () => {
    expect(DEFAULT_RUNNINGHUB_REGION).toBe("ai");
    expect(runningHubRegionLabel("ai")).toBe("国际站");
    expect(runningHubRegionLabel("cn")).toBe("国内站");
    expect(runningHubApiBaseURL("ai")).toBe("https://www.runninghub.ai/openapi/v2");
    expect(runningHubApiBaseURL("cn")).toBe("https://www.runninghub.cn/openapi/v2");
    expect(runningHubUploadURL("cn")).toBe("https://www.runninghub.cn/openapi/v2/media/upload/binary");
    expect(runningHubCatalogURL("cn")).toBe("https://www.runninghub.cn/call-api/standard-api");
    expect(runningHubAccountStatusURL("ai")).toBe("https://www.runninghub.ai/uc/openapi/accountStatus");
    expect(runningHubLLMBaseURL("ai")).toBe("https://llm.runninghub.ai/v1");
    expect(runningHubLLMBaseURL("cn")).toBe("https://llm.runninghub.cn/v1");
    expect(runningHubLLMCatalogURL("cn")).toBe("https://llm.runninghub.cn/v1/models");
  });
});

describe("RunningHub 区域探测", () => {
  it("探测使用上传端点，不使用两站镜像的账户/队列接口", async () => {
    const urls: string[] = [];
    await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(accepted, wrongRegion, urls) });
    expect([...urls].sort()).toEqual([
      "https://www.runninghub.ai/openapi/v2/media/upload/binary",
      "https://www.runninghub.cn/openapi/v2/media/upload/binary"
    ]);
  });

  it("只有国际站接受上传鉴权 → ai/ready", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(accepted, wrongRegion) });
    expect(result).toMatchObject({ ok: true, region: "ai", accountState: "ready" });
    expect(result.probes.map(probe => probe.outcome)).toEqual(["success", "wrong-region"]);
  });

  it("只有国内站接受上传鉴权 → cn/ready", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(wrongRegion, accepted) });
    expect(result).toMatchObject({ ok: true, region: "cn", accountState: "ready" });
  });

  it("两站都返回未找到用户 → 凭据无效，不猜区域", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(wrongRegion, wrongRegion) });
    expect(result).toMatchObject({ ok: false, reason: "credentials-invalid" });
  });

  it("一个站网络失败、另一个站错站 → 无法确认，不能判成 Key 无效", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(networkError, wrongRegion) });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("两站都超时 → 无法确认", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(networkError, networkError) });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("两站同时接受 → 记录歧义，不静默选边", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(accepted, accepted) });
    expect(result).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("站点认 Key 但上传被拒 → 仍选该站并标记 rejected", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(wrongRegion, acceptedButRejected) });
    expect(result).toMatchObject({ ok: true, region: "cn", accountState: "rejected" });
  });

  it("未知业务码不冒充成功，也不冒充错站", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(unknownPayload, wrongRegion) });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("HTTP 5xx 与错站组合 → 无法确认", async () => {
    const result = await detectRunningHubRegion({ apiKey: "k", fetchImpl: fetchFor(serverError, wrongRegion) });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("空 Key 直接报缺少凭据，不发请求", async () => {
    const fetchImpl = vi.fn(async () => accepted()) as unknown as typeof globalThis.fetch;
    const result = await detectRunningHubRegion({ apiKey: "  ", fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
