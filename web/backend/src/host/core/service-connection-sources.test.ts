import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createSettingsService } from "../../settings/settings-service.js";
import { createSiteProviderSource } from "./service-connection-sources.js";
import { createServiceConnectionRegistry } from "../../../../services/application-service/src/service-connections/registry.js";
import { createInMemoryDocumentStore } from "../../../../services/agent-connections/src/test-doubles.js";

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
