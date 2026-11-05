import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createSettingsService } from "../../settings/settings-service.js";
import { createSiteProviderSource } from "./service-connection-sources.js";
import { createServiceConnectionRegistry } from "../../../../services/application-service/src/service-connections/registry.js";
import { createConnectionService } from "../../../../services/agent-connections/src/index.js";
import { createSdkServiceSource, withServiceSources } from "../../../../extensions/sdk-agent/src/backend/service-source.js";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "../../../../services/agent-connections/src/test-doubles.js";

it("turns a declared assistant protocol into a discussion Agent binding only with language models", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-assistant-source-"));
  const files = { configFile: path.join(directory, "config.yml"), secretsFile: path.join(directory, "secrets.yml"), watch: false };
  const fields = { apiKey: { kind: "string", secret: true, reload: "hot", label: "Key", description: "Key" } } as const;
  const settings = await createSettingsService({ ...files, env: {} });
  settings.register("providers.demo", fields, "Demo", "demo");
  const languageModels = [{ providerModelId: "model", modelType: "language" }];
  const make = (catalog: { providerModelId: string; modelType: string }[] = languageModels, assistantProtocol?: string) => {
    const provider = () => ({ providerId: "demo", extensionId: "demo", available: true, models: catalog, serviceConnectionFactory: { protocols: ["chat-completions"], ...(assistantProtocol ? { assistantProtocol } : {}) } } as unknown as GenerationProvider);
    return createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider });
  };
  try {
    const declared = (await make([{ providerModelId: "model", modelType: "language" }], "chat-completions").get("admin", "demo"))!;
    expect(declared.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo", "provider-assistant:demo"]);
    expect(declared.bindings[1]).toMatchObject({ extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["discussion", "target-execution"], modelKeys: ["model"] });
    expect(declared.capabilities).toContainEqual(expect.objectContaining({ purpose: "discussion", protocol: "chat-completions", modelId: "model" }));
    expect(declared.capabilities).toContainEqual(expect.objectContaining({ purpose: "target-execution", protocol: "chat-completions", modelId: "model" }));

    const undeclared = (await make([{ providerModelId: "model", modelType: "language" }]).get("admin", "demo"))!;
    expect(undeclared.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo"]);
    expect(undeclared.capabilities.some(capability => capability.purpose === "discussion")).toBe(false);

    const mediaOnly = (await make([{ providerModelId: "image-model", modelType: "image" }], "chat-completions").get("admin", "demo"))!;
    expect(mediaOnly.bindings.map(binding => binding.bindingId)).toEqual(["provider:demo"]);
    expect(mediaOnly.capabilities.some(capability => capability.purpose === "discussion")).toBe(false);
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
  const provider = { providerId: "demo", extensionId: "demo", available: true, models: [{ providerModelId: "model", modelType: "language" }], serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" } } as unknown as GenerationProvider;
  try {
    expect((await settings.update({ "providers.demo.apiKey": "demo-key" })).ok).toBe(true);
    const documents = createInMemoryDocumentStore(["sdk", "sources"]);
    const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets: createInMemorySecretStore() });
    const registry = createServiceConnectionRegistry({ documents: documents.forExtension("sources")!, checkEndpoint: () => true, validateBinding: () => false });
    const sdk = registry.forExtension("sdk-agent");
    sdk.registerSource(createSdkServiceSource(raw));
    sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["discussion", "target-execution"] });
    registry.forExtension("demo").registerSource(createSiteProviderSource({ providerId: "demo", extensionId: "demo", label: "Demo", prefix: "providers.demo", settings, provider: () => provider }));
    const bridged = withServiceSources(raw, sdk);
    const list = await bridged.list("alice");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Demo", models: ["model"] });
    expect(list[0]!.serviceConnectionId).toBeTruthy();
    expect(await bridged.credentialConfigured({ owner: "alice", connectionId: list[0]!.connectionId, purpose: "model-api-key" })).toBe(true);
    // Target execution is a granted purpose, not just discussion.
    const source = (await sdk.get("alice", list[0]!.serviceConnectionId!))!;
    expect(await sdk.resolve("alice", { ...source, bindingId: "provider-assistant:demo", purpose: "target-execution", protocol: "chat-completions", modelId: "model", endpoint: "https://relay.example/v1" })).toMatchObject({ secret: "demo-key" });
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
  const provider = { providerId: "demo", extensionId: "demo", available: true, models: [{ providerModelId: "model", modelType: "language" }], serviceConnectionFactory: { protocols: ["chat-completions"], assistantProtocol: "chat-completions" } } as unknown as GenerationProvider;
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
    sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["discussion"] });
    const bound = await registry.bind(actor, first.serviceConnectionId, { bindingId: "shared", extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["discussion"], modelKeys: ["model"] }, first);
    const call = { ...bound, bindingId: "shared", purpose: "discussion" as const, protocol: "chat-completions", modelId: "model", endpoint: "https://relay.example/v1" };
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
