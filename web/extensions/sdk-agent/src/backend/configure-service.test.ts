import { describe, expect, it, vi } from "vitest";
import { createConnectionService } from "@woohaa3/agent-connections";
import {
  createInMemoryDocumentStore,
  createInMemorySecretStore,
} from "../../../../services/agent-connections/src/test-doubles.js";
import {
  configureModelService,
  normalizeModelBaseUrl,
} from "./configure-service.js";

function fixture() {
  const documents = createInMemoryDocumentStore(["sdk-agent"]).forExtension(
    "sdk-agent",
  )!;
  const secrets = createInMemorySecretStore();
  const service = createConnectionService({ documents, secrets });
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }],
        }),
      ),
  );
  const deployment = {
    allowedHosts: ["api.example", "api.anthropic.com"],
    allowHttp: false,
    fetchImpl,
  };
  const input = {
    adapterId: "compat-chat",
    baseUrl: "https://api.example/v1/chat/completions",
    secret: "sk-private",
  };
  return { service, secrets, fetchImpl, deployment, input };
}
describe("地址与 Key 一步设置", () => {
  it("接受主流 Base URL 与完整接口地址", () => {
    expect(normalizeModelBaseUrl(" https://api.example/ ")).toBe(
      "https://api.example/v1",
    );
    expect(normalizeModelBaseUrl("https://api.example/v1/responses/")).toBe(
      "https://api.example/v1",
    );
    expect(normalizeModelBaseUrl("https://api.example/api/v3")).toBe(
      "https://api.example/api/v3",
    );
    expect(() =>
      normalizeModelBaseUrl("https://secret:password@api.example/v1"),
    ).toThrow();
    expect(() =>
      normalizeModelBaseUrl("https://api.example/v1?key=secret"),
    ).toThrow();
  });
  it("保存目录模型，不再写入逐模型工具证据（所有文本模型都按支持工具处理）", async () => {
    const { service, fetchImpl, deployment, input } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "catalog-model", capabilities: { tools: false } }, { id: "unknown" }] })));
    expect((await configureModelService(service, deployment, "u1", input)).status).toBe(200);
    const [record] = await service.list("u1");
    expect(record?.models).toEqual(["catalog-model", "unknown"]);
    expect(Object.hasOwn(record!, "modelCapabilities")).toBe(false);
  });
  it("一次保存 Key 并 GET 模型，不生成、不回读秘密，重复保存复用服务", async () => {
    const { service, fetchImpl, deployment, input } = fixture();
    const first = await configureModelService(service, deployment, "u1", input);
    expect(first).toMatchObject({
      status: 200,
      body: { models: ["model-a", "model-b"] },
    });
    expect(JSON.stringify(first)).not.toContain(input.secret);
    const records = await service.list("u1");
    expect(records).toHaveLength(1);
    expect(
      await service.readCredential({
        owner: "u1",
        connectionId: records[0].connectionId,
        purpose: "model-api-key",
      }),
    ).toEqual({ secret: input.secret });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer sk-private",
        }),
      }),
    );
    await configureModelService(service, deployment, "u1", {
      ...input,
      secret: undefined,
      connectionId: records[0].connectionId,
    });
    expect(await service.list("u1")).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it.each([
    ["openai-responses", "/responses", "authorization", "Bearer protocol-key"],
    ["anthropic-messages", "/messages", "x-api-key", "protocol-key"],
    ["compat-chat", "/chat/completions", "authorization", "Bearer protocol-key"],
    ["gemini-agent-adk", "/models", "x-goog-api-key", "protocol-key"],
  ])("%s 在自定义 Base URL 保存并按所选协议读取目录", async (adapterId, suffix, header, value) => {
    const { service, deployment, fetchImpl } = fixture();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify(adapterId === "gemini-agent-adk" ? { models: [{ name: "models/custom-model" }] } : { data: [{ id: "custom-model" }] })));
    const result = await configureModelService(service, deployment, "u1", {
      adapterId, baseUrl: `https://api.example/proxy/v1${suffix}`, secret: "protocol-key",
    });
    expect(result).toMatchObject({ status: 200, body: { models: ["custom-model"] } });
    expect((await service.list("u1"))[0]).toMatchObject({ adapterId, baseUrl: "https://api.example/proxy/v1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example/proxy/v1/models", expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ [header]: value }),
    }));
  });
  it("Gemini 自定义根地址使用该协议的 v1beta 路径", async () => {
    const { service, deployment, fetchImpl } = fixture();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] })));
    expect(await configureModelService(service, deployment, "u1", {
      adapterId: "gemini-agent-adk", baseUrl: "https://api.example/", secret: "gemini-key",
    })).toMatchObject({ status: 200, body: { models: ["gemini-test"] } });
    expect((await service.list("u1"))[0]?.baseUrl).toBe("https://api.example/v1beta");
  });
  it("Anthropic 地址使用 x-api-key 读取模型", async () => {
    const { service, deployment, fetchImpl } = fixture();
    await configureModelService(service, deployment, "u1", {
      adapterId: "anthropic-messages",
      secret: "sk-anthropic",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-anthropic",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });
  it("目录不可用仍保留设置，手填模型可以保存且不再次探测", async () => {
    const { service, deployment, fetchImpl, input } = fixture();
    fetchImpl.mockResolvedValue(new Response("unavailable", { status: 404 }));
    const first = await configureModelService(service, deployment, "u1", input);
    expect(first).toMatchObject({
      status: 200,
      body: { models: [], modelsError: expect.any(String) },
    });
    expect(await service.list("u1")).toHaveLength(1);
    const second = await configureModelService(service, deployment, "u1", {
      ...input,
      models: ["my-model"],
      connectionId: (await service.list("u1"))[0].connectionId,
    });
    expect(second).toMatchObject({
      status: 200,
      body: { models: ["my-model"] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("目录保留模型级 reasoning 元数据；失败时保留上次成功快照", async () => {
    const { service, deployment, fetchImpl, input } = fixture();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "deepseek-exact", model_info: { supports_reasoning: true, reasoning_efforts: ["low", "high"] } },
      { id: "deepseek-boolean", model_info: { supports_reasoning: true } }
    ] })));
    await configureModelService(service, deployment, "u1", input);
    const saved = (await service.list("u1"))[0];
    expect(saved?.modelCatalog?.models).toEqual([
      expect.objectContaining({ id: "deepseek-exact", reasoning: expect.objectContaining({ state: "supported", efforts: [{ id: "low" }, { id: "high" }] }) }),
      expect.objectContaining({ id: "deepseek-boolean", reasoning: expect.objectContaining({ state: "supported", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] }) })
    ]);
    fetchImpl.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const refreshed = await configureModelService(service, deployment, "u1", { ...input, connectionId: saved!.connectionId });
    expect(refreshed).toMatchObject({ status: 200, body: { models: ["deepseek-exact", "deepseek-boolean"], modelsError: expect.any(String) } });
    expect((await service.list("u1"))[0]?.modelCatalog?.models[0]?.reasoning).toMatchObject({ state: "supported", efforts: [{ id: "low" }, { id: "high" }] });
  });
  it("换地址不得复用旧 Key；其他用户无法编辑，旧版本不能覆盖", async () => {
    const { service, deployment, input } = fixture();
    await configureModelService(service, deployment, "u1", input);
    const saved = (await service.list("u1"))[0];
    expect(
      await configureModelService(service, deployment, "u1", {
        ...input,
        connectionId: saved.connectionId,
        baseUrl: "https://api.example/other",
        secret: undefined,
      }),
    ).toMatchObject({ status: 400, body: { code: "credential-missing" } });
    expect(
      await configureModelService(service, deployment, "u2", {
        ...input,
        connectionId: saved.connectionId,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await configureModelService(service, deployment, "u1", {
        ...input,
        connectionId: saved.connectionId,
        expectedEpoch: saved.credentialEpoch - 1,
      }),
    ).toMatchObject({ status: 409 });
    expect((await service.get("u1", saved.connectionId))?.baseUrl).toBe(
      "https://api.example/v1",
    );
  });
  it("地址策略先于保存，跨 origin 重定向不转发 Key", async () => {
    const { service, deployment, fetchImpl, input } = fixture();
    expect(
      await configureModelService(service, deployment, "u1", {
        ...input,
        baseUrl: "https://denied.example/v1",
      }),
    ).toMatchObject({ status: 400 });
    expect(await service.list("u1")).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/models" },
      }),
    );
    expect(
      await configureModelService(service, deployment, "u1", input),
    ).toMatchObject({ status: 200, body: { modelsError: expect.any(String) } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("首次保存凭据失败不发布空配置", async () => {
    const { service, secrets, deployment, input } = fixture();
    vi.spyOn(secrets, "write").mockReturnValue({ ok: false, code: "storage-failed", message: "存储不可用" });
    expect(
      await configureModelService(service, deployment, "u1", input),
    ).toMatchObject({ status: 500 });
    expect(await service.list("u1")).toHaveLength(0);
  });
  it("读取模型期间 Key 被清除，迟到目录不能覆盖新设置", async () => {
    const { service, deployment, input, fetchImpl } = fixture();
    fetchImpl.mockImplementation(async () => {
      const record = (await service.list("u1"))[0];
      await service.clearCredential({
        owner: "u1",
        connectionId: record.connectionId,
        purpose: "model-api-key",
      });
      return new Response(JSON.stringify({ data: [{ id: "stale-model" }] }));
    });
    expect(
      await configureModelService(service, deployment, "u1", input),
    ).toMatchObject({ status: 409 });
    expect((await service.list("u1"))[0].models).toBeUndefined();
  });

  it("未配置 allowedHosts 时允许任意中转站 Base URL", async () => {
    const { service, fetchImpl } = fixture();
    const openDeployment = { allowHttp: false, fetchImpl };
    const result = await configureModelService(service, openDeployment, "u1", {
      adapterId: "compat-chat",
      baseUrl: "https://my-custom-proxy.org/v1/chat/completions",
      secret: "sk-proxy-key",
    });
    expect(result.status).toBe(200);
  });
});
