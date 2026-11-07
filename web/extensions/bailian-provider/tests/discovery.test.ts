import { describe, expect, it, vi } from "vitest";
import { bailianResolvedOrigin } from "../src/backend.js";
import { discoverBailianModels, parseBailianModels } from "../src/discovery.js";
import { bailianWorkspaceOrigin } from "../src/shared.js";

const ORIGIN = "https://dashscope.aliyuncs.com";

function listing(models: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { request_id: "req-1", output: { total: models.length, page_no: 1, page_size: 100, models, ...extra } };
}

function fetchReturning(payloads: unknown[]) {
  let index = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    const payload = payloads[Math.min(index++, payloads.length - 1)];
    return Response.json(payload, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("百炼模型发现", () => {
  it("从 output.models 读出 id / 名称 / 推理厂商，并按 model 去重", () => {
    const parsed = parseBailianModels(listing([
      { model: "qwen-image-3.0-pro", name: "Qwen-Image 3.0 Pro", inference_provider: "alibaba" },
      { model: "wan2.7-image", name: "万相 2.7", provider: "aliyun" },
      // 同一模型可能被多条 provider 记录重复返回。
      { model: "qwen-image-3.0-pro", name: "Qwen-Image 3.0 Pro", inference_provider: "aliyun" }
    ]));
    expect(parsed.total).toBe(3);
    expect(parsed.models.map((model) => model.id)).toEqual(["qwen-image-3.0-pro", "wan2.7-image"]);
    expect(parsed.models[0]).toMatchObject({ name: "Qwen-Image 3.0 Pro", inferenceProvider: "alibaba" });
    expect(parsed.models[1]).toMatchObject({ provider: "aliyun" });
  });

  it("只问生图能力，并把上游给出的清单和卡片对账", async () => {
    const { fetchImpl, calls } = fetchReturning([listing([
      { model: "qwen-image-3.0-pro", name: "Qwen-Image 3.0 Pro" },
      { model: "qwen-image-2.1-pro", name: "Qwen-Image 2.1 Pro" },
      // 上游新上的模型没有卡片：不能注册（没有参数事实），只能报告。
      { model: "qwen-image-3.0", name: "Qwen-Image 3.0" }
    ])]);
    const result = await discoverBailianModels({
      baseUrl: ORIGIN,
      apiKey: "sk-secret",
      known: ["qwen-image-3.0-pro", "qwen-image-2.1-pro", "wan2.7-image"],
      fetchImpl
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((model) => model.id)).toEqual([
      "qwen-image-3.0-pro",
      "qwen-image-2.1-pro",
      "qwen-image-3.0"
    ]);
    // 卡片登记了但上游没返回（下架/未开通）。
    expect(result.missing).toEqual(["wan2.7-image"]);
    expect(result.uncovered).toEqual(["qwen-image-3.0"]);

    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/api/v1/models`);
    // capabilities=IG 是官方的「图片生成」能力值。
    expect(url.searchParams.get("capabilities")).toBe("IG");
  });

  it("按 total 翻页，直到拿全", async () => {
    const page = (ids: string[], total: number, pageNo: number) => ({
      request_id: "req",
      output: {
        total,
        page_no: pageNo,
        page_size: 2,
        models: ids.map((model) => ({ model, name: model }))
      }
    });
    const { fetchImpl, calls } = fetchReturning([
      page(["a-image", "b-image"], 3, 1),
      page(["c-image"], 3, 2)
    ]);
    const result = await discoverBailianModels({ baseUrl: ORIGIN, apiKey: "sk-secret", fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((model) => model.id)).toEqual(["a-image", "b-image", "c-image"]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!).searchParams.get("page_no")).toBe("2");
  });

  it("没有 API Key 就不发请求", async () => {
    const { fetchImpl, calls } = fetchReturning([listing([])]);
    const result = await discoverBailianModels({ baseUrl: ORIGIN, apiKey: "  ", fetchImpl });
    expect(result).toEqual({ ok: false, message: "先配置 API Key" });
    expect(calls).toEqual([]);
  });

  it("HTTP 错误与空清单都给出可操作的原因", async () => {
    const failing = vi.fn(async () => Response.json({ code: "InvalidApiKey" }, { status: 401 }));
    expect(await discoverBailianModels({
      baseUrl: ORIGIN,
      apiKey: "sk-secret",
      fetchImpl: failing as unknown as typeof fetch
    })).toEqual({ ok: false, message: "读取百炼模型列表失败（HTTP 401）" });

    const { fetchImpl } = fetchReturning([listing([])]);
    const empty = await discoverBailianModels({ baseUrl: ORIGIN, apiKey: "sk-secret", fetchImpl });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    // 空清单通常不是「没有生图模型」，而是 Key / 地域 / 业务空间不对。
    expect(empty.message).toContain("业务空间");
  });
});

describe("百炼地址", () => {
  it("业务空间 ID 拼专属域名，未知地域回落到华北 2", () => {
    expect(bailianWorkspaceOrigin("ws-123", "cn-beijing"))
      .toBe("https://ws-123.cn-beijing.maas.aliyuncs.com");
    expect(bailianWorkspaceOrigin("ws-123", "ap-southeast-1"))
      .toBe("https://ws-123.ap-southeast-1.maas.aliyuncs.com");
    expect(bailianWorkspaceOrigin("ws-123", "mars-1"))
      .toBe("https://ws-123.cn-beijing.maas.aliyuncs.com");
    expect(bailianWorkspaceOrigin("ws-123")).toBe("https://ws-123.cn-beijing.maas.aliyuncs.com");
  });

  it("非法业务空间 ID 不拼域名（免得拼出一个 DNS 都不成立的主机）", () => {
    for (const bad of ["", "  ", "ws 123", "ws_123", "-ws", "a".repeat(64), "http://x"]) {
      expect(bailianWorkspaceOrigin(bad), bad).toBeUndefined();
    }
  });

  it("填了业务空间就走专属域名，否则用 API 地址", () => {
    expect(bailianResolvedOrigin({ workspaceId: "ws-123", region: "cn-beijing", baseUrl: "https://dashscope.aliyuncs.com" }))
      .toBe("https://ws-123.cn-beijing.maas.aliyuncs.com");
    expect(bailianResolvedOrigin({ workspaceId: "", baseUrl: "https://dashscope-intl.aliyuncs.com/" }))
      .toBe("https://dashscope-intl.aliyuncs.com");
    // 没填地址时退回老公开域名。
    expect(bailianResolvedOrigin({})).toBe(ORIGIN);
  });
});
