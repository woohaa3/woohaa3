import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createSettingsService } from "../../settings/settings-service.js";
import { createSiteProviderSource, enabledAssistantModels } from "./service-connection-sources.js";
import { createServiceConnectionRegistry } from "../../../../services/application-service/src/service-connections/registry.js";
import { createConnectionService } from "../../../../services/agent-connections/src/index.js";
import { createSdkServiceSource, withServiceSources } from "../../../../extensions/sdk-agent/src/backend/service-source.js";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "../../../../services/agent-connections/src/test-doubles.js";

it("excludes models the site policy does not enable from the assistant directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-assistant-policy-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const provider = () => ({
    providerId: "demo", extensionId: "demo", available: true,
    models: [
      { providerModelId: "llm/enabled", modelType: "language" },
      { providerModelId: "llm/disabled", modelType: "language" },
      { providerModelId: "llm/absent", modelType: "language" },
      { providerModelId: "llm/tombstoned", modelType: "language" },
      { providerModelId: "api/image", modelType: "image" },
      { providerModelId: "api/motion", modelType: "motion" }
    ],
    languageCapabilities: () => ({ tools: true, streaming: true }),
    serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" }
  } as unknown as GenerationProvider);
  const policy = { initialized: true, revision: 3, models: [
    { modelKey: "demo:llm/enabled", enabled: true },
    { modelKey: "demo:llm/disabled", enabled: false },
    { modelKey: "demo:llm/tombstoned", enabled: true, tombstone: true },
    { modelKey: "demo:api/image", enabled: true }
  ] };
  try {
    const adapter = createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider, policy: () => policy });
    const source = (await adapter.get("admin", "demo"))!;
    expect(source.capabilities.some(capability => capability.modelId === "api/motion")).toBe(false);
    expect(source.bindings.find(binding => binding.consumer === "provider")?.modelKeys).not.toContain("demo:api/motion");
    const assistant = source.bindings.find(binding => binding.bindingId === "provider-assistant:demo");
    // 只有策略里启用且未 tombstone 的语言模型能当助手；策略里没有该行的模型同样不算启用。
    expect(assistant?.modelKeys).toEqual(["llm/enabled"]);
    expect(source.capabilities.filter(capability => capability.purpose === "text" && capability.protocol === "chat-completions").map(capability => capability.modelId)).toEqual(["llm/enabled"]);

    // 策略未初始化时与任务目录一致：全开。
    const open = enabledAssistantModels(provider(), { initialized: false, revision: 0, models: [] });
    expect(open.map(model => model.providerModelId)).toEqual(["llm/enabled", "llm/disabled", "llm/absent", "llm/tombstoned"]);

    // 启停结果属于来源内容：关掉模型必须推进 configRevision，缓存连接才不会继续用旧集合。
    const unfiltered = createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider });
    const unfilteredSource = (await unfiltered.get("admin", "demo"))!;
    expect(unfilteredSource.bindings.find(binding => binding.bindingId === "provider-assistant:demo")?.modelKeys)
      .toEqual(["llm/enabled", "llm/disabled", "llm/absent", "llm/tombstoned"]);
    expect(source.configRevision).not.toBe(unfilteredSource.configRevision);
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("turns a declared assistant protocol into a text Agent binding only with language models", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-assistant-source-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const languageModels = [{ providerModelId: "model", modelType: "language" }];
  const make = (catalog: { providerModelId: string; modelType: string }[] = languageModels, assistantProtocol?: string) => {
    const provider = () => ({ providerId: "demo", extensionId: "demo", available: true, models: catalog, languageCapabilities: () => ({ tools: true, streaming: true }), serviceConnectionFactory: { protocols: ["chat-completions"], ...(assistantProtocol ? { assistantProtocol } : {}) } } as unknown as GenerationProvider);
    return createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider });
  };
  try {
    const declared = (await make([{ providerModelId: "model", modelType: "language" }], "chat-completions").get("admin", "demo"))!;
    expect(declared.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo", "provider-assistant:demo"]);
    expect(declared.bindings[1]).toMatchObject({ extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["text"], modelKeys: ["model"] });
    expect(declared.capabilities).toContainEqual(expect.objectContaining({ purpose: "text", protocol: "chat-completions", modelId: "model" }));

    const undeclared = (await make([{ providerModelId: "model", modelType: "language" }]).get("admin", "demo"))!;
    expect(undeclared.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo"]);
    expect(undeclared.capabilities.some(capability => capability.purpose === "text" && capability.protocol === "chat-completions")).toBe(false);

    // 目录身份带来源前缀时，助手能力必须换成上游认识的 ID，否则上游会 404 拒绝整轮。
    const prefixed = (await make([{ providerModelId: "llm/deepseek/deepseek-v4-flash", modelType: "language" }], "chat-completions").get("admin", "demo"))!;
    expect(prefixed.capabilities).toContainEqual(expect.objectContaining({ purpose: "text", protocol: "chat-completions", modelId: "llm/deepseek/deepseek-v4-flash" }));

    const mediaOnly = (await make([{ providerModelId: "image-model", modelType: "image" }], "chat-completions").get("admin", "demo"))!;
    expect(mediaOnly.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo"]);
    expect(mediaOnly.capabilities.some(capability => capability.purpose === "text")).toBe(false);
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("contributes per-protocol fixed endpoints and text capabilities for every language model", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-assistant-endpoints-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = {
    apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" },
    baseUrl: { kind: "url", protocols: ["https:"], reload: "hot", label: "URL", description: "URL", default: "https://media.example/v2" }
  } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  let catalogRevision = 1;
  const provider = () => ({
    providerId: "demo", extensionId: "demo", available: true, catalogRevision,
    models: [
      { providerModelId: "llm/tools", modelType: "language" },
      { providerModelId: "llm/chat-only", modelType: "language" },
      { providerModelId: "api/image", modelType: "image" }
    ],
    languageCapabilities: (modelId: string) => modelId === "llm/tools" ? { tools: true, imageInput: true, streaming: true } : undefined,
    serviceConnectionFactory: {
      protocols: ["chat-completions" as const], assistantProtocol: "chat-completions" as const,
      endpoints: { "chat-completions": "https://text.example/v1" }
    }
  } as unknown as GenerationProvider);
  const adapter = createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider });
  try {
    const first = (await adapter.get("admin", "demo"))!;
    // Provider 只贡献文字协议：固定端点来自 endpoints，而不是媒体 baseUrl。
    expect(first.endpoints).toEqual([{ protocol: "chat-completions", baseUrl: "https://text.example/v1" }]);
    expect(first.capabilities).toContainEqual(expect.objectContaining({ purpose: "text", protocol: "chat-completions", modelId: "llm/tools", imageInput: true }));
    expect(first.capabilities).toContainEqual(expect.objectContaining({ purpose: "text", protocol: "chat-completions", modelId: "llm/chat-only", imageInput: false }));
    expect(first.capabilities.some(capability => String(capability.purpose) === "target-execution")).toBe(false);

    catalogRevision = 2;
    const second = (await adapter.get("admin", "demo"))!;
    expect(second.configRevision).not.toBe(first.configRevision);
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("projects a declared site provider source into a usable Agent connection through the SDK bridge", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-agent-source-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = {
    apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" },
    baseUrl: { kind: "url", protocols: ["https:"], reload: "hot", label: "URL", description: "URL", default: "https://relay.example/v1" },
  } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const provider = { providerId: "demo", extensionId: "demo", available: true, models: [{ providerModelId: "model", modelType: "language" }], languageCapabilities: () => ({ tools: true, streaming: true }), serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" } } as unknown as GenerationProvider;
  try {
    expect((await settings.update({ "providers.demo.apiKey": "demo-key" })).ok).toBe(true);
    const documents = createInMemoryDocumentStore(["sdk", "sources"]);
    const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets: createInMemorySecretStore() });
    const registry = createServiceConnectionRegistry({ documents: documents.forExtension("sources")!, checkEndpoint: () => true, validateBinding: () => false });
    const sdk = registry.forExtension("sdk-agent");
    sdk.registerSource(createSdkServiceSource(raw));
    sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["text"] });
    registry.forExtension("demo").registerSource(createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider: () => provider }));
    const bridged = withServiceSources(raw, sdk);
    const list = await bridged.list("alice");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Demo", models: ["model"] });
    expect(list[0]!.serviceConnectionId).toBeTruthy();
    expect(await bridged.credentialConfigured({ owner: "alice", connectionId: list[0]!.connectionId, purpose: "model-api-key" })).toBe(true);
    // 文本能力即 Agent 能力，工具调用不再需要额外的用途证据。
    const source = (await sdk.get("alice", list[0]!.serviceConnectionId!))!;
    expect(await sdk.resolve("alice", { ...source, bindingId: "provider-assistant:demo", purpose: "text", protocol: "chat-completions", modelId: "model", endpoint: "https://relay.example/v1" })).toMatchObject({ secret: "demo-key" });
    // A second read reuses the same stable auto connection.
    expect((await bridged.list("alice")).map(record => record.connectionId)).toEqual([list[0]!.connectionId]);
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("projects one settings authority, rotates all bindings, preserves advanced fields and enforces environment locks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-source-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key", legacyEnv: "TEST_SOURCE_KEY" }, baseUrl: { kind: "url", protocols: ["https:"], reload: "hot", label: "URL", description: "URL", default: "https://relay.example/v1" }, region: { kind: "string", reload: "hot", label: "Region", description: "Region", default: "region-a" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const provider = { providerId: "demo", extensionId: "demo", available: true, models: [{ providerModelId: "model", modelType: "language" }], languageCapabilities: () => ({ tools: true, streaming: true }), serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" } } as unknown as GenerationProvider;
  let configured = false;
  const adapter = createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider: () => configured ? provider : undefined });
  const documents = createInMemoryDocumentStore(["sources"]).forExtension("sources")!;
  const makeRegistry = () => createServiceConnectionRegistry({ documents, checkEndpoint: () => true, validateBinding: () => false });
  const registry = makeRegistry();
  registry.forExtension("demo").registerSource(adapter);
  const actor = { owner: "admin", administrator: true, canUseSite: true };
  try {
    expect(await registry.list(actor)).toEqual([]);
    expect((await settings.update({ "providers.demo.apiKey": "first-key", "providers.demo.region": "region-b" })).ok).toBe(true);
    configured = true;
    const [first] = await registry.list(actor);
    const refreshed = (await registry.list(actor))[0];
    expect(refreshed.configRevision).toBe(first.configRevision);
    expect(refreshed.bindings.filter(binding => binding.bindingId === "provider-assistant:demo")).toHaveLength(1);
    const sdk = registry.forExtension("sdk-agent");
    sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["text"] });
    const bound = await registry.bind(actor, first.serviceConnectionId, { bindingId: "shared", extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["text"], modelKeys: ["model"] }, first);
    const call = { ...bound, bindingId: "shared", purpose: "text" as const, protocol: "chat-completions", modelId: "model", endpoint: "https://relay.example/v1" };
    expect(await sdk.resolve("alice", call)).toMatchObject({ secret: "first-key" });
    await settings.update({ "providers.demo.apiKey": "second-key" });
    await expect(sdk.resolve("alice", call)).rejects.toMatchObject({ code: "stale" });
    const current = (await registry.get(actor, first.serviceConnectionId))!;
    expect(current.credentialEpoch).toBe(first.credentialEpoch + 1);
    expect(settings.section("providers.demo").region).toBe("region-b");
    // A real content change advances the published revision; an unchanged refresh above did not.
    const beforeContent = (await registry.get(actor, first.serviceConnectionId))!;
    expect((await settings.update({ "providers.demo.region": "region-c" })).ok).toBe(true);
    const afterContent = (await registry.get(actor, first.serviceConnectionId))!;
    expect(afterContent.configRevision).toBeGreaterThan(beforeContent.configRevision);
    expect(settings.section("providers.demo").region).toBe("region-c");
    const restarted = makeRegistry(); restarted.forExtension("demo").registerSource(adapter);
    expect((await restarted.list(actor))[0].serviceConnectionId).toBe(first.serviceConnectionId);
    expect(JSON.stringify(current)).not.toMatch(/first-key|second-key|Fingerprint/);
    const locked = await createSettingsService({ ...files, env: { TEST_SOURCE_KEY: "env-key" } });
    try {
      locked.register("providers.demo", fields, "Demo", "demo");
      const source = createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings: locked, provider: () => provider });
      expect(await source.get("admin", "demo")).toMatchObject({ locked: true });
      expect((await locked.update({ "providers.demo.apiKey": "override" })).ok).toBe(false);
      expect((await locked.update({ "providers.demo.apiKey": null })).ok).toBe(false);
    } finally { locked.close(); }
  } finally { settings.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("maps catalog model identities to the upstream model id for assistant turns", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-upstream-model-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.prefixed", fields, "Prefixed", "prefixed");
  const provider = () => ({
    providerId: "prefixed", extensionId: "prefixed", available: true,
    models: [{ providerModelId: "llm/deepseek/deepseek-v4-flash", modelType: "language" }],
    serviceConnectionFactory: {
      protocols: ["chat-completions"],
      assistantProtocol: "chat-completions",
      // 画布身份是 `llm/<原始 id>`；上游只认去前缀的原始 id。
      upstreamModelId: (modelId: string) => modelId.startsWith("llm/") ? modelId.slice(4) : modelId
    }
  } as unknown as GenerationProvider);
  const source = createSiteProviderSource({ providerId: "prefixed", extensionId: "prefixed", label: "Prefixed", prefix: "providers.prefixed", settings, provider });
  try {
    const view = (await source.get("admin", "prefixed"))!;
    // 助手能力用上游 ID，绑定仍按画布身份登记。
    expect(view.capabilities).toContainEqual(expect.objectContaining({ purpose: "text", protocol: "chat-completions", modelId: "deepseek/deepseek-v4-flash" }));
    // 授权按上游 ID 匹配：能力与 binding 必须同一口径，否则取凭据会被判「缺少能力证据」。
    expect(view.bindings.find(binding => binding.extensionId === "sdk-agent")?.modelKeys).toEqual(["deepseek/deepseek-v4-flash"]);
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("provider 的 reasoning 能力事实与 Agent 目录使用同一投影", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-assistant-reasoning-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const models = [
    { providerModelId: "exact", modelType: "language", capabilityFacts: { reasoning: { supported: true, efforts: ["low", "high"] } } },
    { providerModelId: "boolean", modelType: "language", capabilityFacts: { reasoning: { supported: true } } },
    { providerModelId: "off", modelType: "language", capabilityFacts: { reasoning: { supported: false } } }
  ];
  const provider = () => ({ providerId: "demo", extensionId: "demo", available: true, models, languageCapabilities: () => undefined,
    serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" } } as unknown as GenerationProvider);
  try {
    const snapshot = (await createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider }).get("admin", "demo"))!;
    expect(snapshot.capabilities.find((capability) => capability.modelId === "exact")?.reasoning).toMatchObject({ state: "supported", source: "provider", efforts: [{ id: "low" }, { id: "high" }] });
    expect(snapshot.capabilities.find((capability) => capability.modelId === "boolean")?.reasoning).toEqual({ state: "supported", source: "provider", revision: expect.any(String) });
    expect(snapshot.capabilities.find((capability) => capability.modelId === "off")?.reasoning).toMatchObject({ state: "unsupported" });
  } finally {
    settings.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
