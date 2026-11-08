import { expect, it, vi } from "vitest";
import { createConnectionProvider, createConnectionService } from "@woohaa3/agent-connections";
import type { ServiceConnectionSourceSnapshot } from "@woohaa3/contracts";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "../../../../services/agent-connections/src/test-doubles.js";
import { createServiceConnectionRegistry } from "../../../../services/application-service/src/service-connections/registry.js";
import { createSdkServiceSource, withServiceSources } from "./service-source.js";
import { createSdkAgentDescriptors } from "./sdk-agent-connections.js";
import { sdkEngineForAdapter } from "../shared.js";

/** Shared shape for a provider source that declares a trusted assistant protocol. */
function declaredSource(legacyId: string, scope: "site" | "personal", overrides: Partial<ServiceConnectionSourceSnapshot> = {}): ServiceConnectionSourceSnapshot {
  return {
    legacyId, scope, kind: "api", name: `Relay ${legacyId}`,
    endpoints: [{ protocol: "chat-completions", baseUrl: "https://relay.example/v1" }],
    capabilities: [
      { purpose: "discussion", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" },
      { purpose: "target-execution", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" },
    ],
    bindings: [
      { bindingId: `provider:${legacyId}`, extensionId: "demo", consumer: "provider", consumerId: legacyId, purposes: ["text"], modelKeys: [`${legacyId}:model`] },
      { bindingId: `provider-assistant:${legacyId}`, extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["discussion", "target-execution"], modelKeys: ["model"] },
    ],
    enabled: true, removed: false, locked: false, credentialConfigured: true, configRevision: 1, credentialEpoch: 1,
    ...overrides,
  };
}

it("projects declared provider sources from both scopes into stable Agent connections and drops them with their source", async () => {
  const documents = createInMemoryDocumentStore(["sdk", "sources"]);
  const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets: createInMemorySecretStore() });
  const registry = createServiceConnectionRegistry({ documents: documents.forExtension("sources")!, checkEndpoint: () => true, validateBinding: () => false });
  const sdk = registry.forExtension("sdk-agent");
  sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["discussion", "target-execution"] });
  let site = declaredSource("demo", "site");
  let personal = declaredSource("me", "personal");
  const siteAdapter = { id: "demo-site", scope: "site" as const, get: async () => site, list: async () => [site] };
  const personalAdapter = { id: "demo-personal", scope: "personal" as const, get: async (_owner: string, id: string) => id === "me" ? personal : null, list: async () => [personal] };
  registry.forExtension("demo").registerSource(siteAdapter);
  registry.forExtension("demo").registerSource(personalAdapter);
  const bridged = withServiceSources(raw, sdk);

  const first = await bridged.list("alice");
  expect(first).toHaveLength(2);
  expect(new Set(first.map(record => record.serviceConnectionId)).size).toBe(2);
  expect(first.map(record => record.name).sort()).toEqual(["Relay demo", "Relay me"]);
  expect(first.every(record => record.models?.includes("model"))).toBe(true);
  // Provider-declared assistant connections carry per-model evidence; this fixture proves tools.
  expect(first.every(record => record.modelCapabilities?.model?.tools === true)).toBe(true);
  const revisions = first.map(record => record.connectionId + ":" + record.configRevision).sort();
  const again = await bridged.list("alice");
  expect(again.map(record => record.connectionId + ":" + record.configRevision).sort()).toEqual(revisions);

  // Source disable removes the projected connection from the usable list; conversation history is untouched.
  site = declaredSource("demo", "site", { enabled: false });
  expect((await bridged.list("alice")).map(record => record.name)).toEqual(["Relay me"]);

  // Revoking the source credential makes the connection unavailable without deleting its identity.
  personal = declaredSource("me", "personal", { credentialConfigured: false });
  const siteOff = await bridged.list("alice");
  expect(siteOff.map(record => record.name)).toEqual(["Relay me"]);
  expect(await bridged.credentialConfigured({ owner: "alice", connectionId: siteOff[0]!.connectionId, purpose: "model-api-key" })).toBe(false);

  // Removing the source drops the projection entirely.
  personal = declaredSource("me", "personal", { removed: true, credentialConfigured: false });
  expect(await bridged.list("alice")).toEqual([]);
});

it("makes an auto connection attemptable before the first model run and surfaces a real runtime blocker", async () => {
  const documents = createInMemoryDocumentStore(["sdk"]);
  const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets: createInMemorySecretStore() });
  const configured = await raw.configure("alice", { operationId: "auto", adapterId: "compat-chat", name: "LiteLLM", authMode: "api-key", runCategory: "agent-sdk",
    baseUrl: "https://relay.example/v1", models: ["model"], secret: "key", expectedEpoch: 0, expectedRevision: 0 });
  if (!configured.ok) throw new Error(configured.error.message);
  const provider = createConnectionProvider({ id: "sdk-agent", extensionId: "sdk-agent", service: raw,
    descriptors: createSdkAgentDescriptors({ allowedHosts: ["relay.example"], allowHttp: false }) });
  const [ready] = await provider.listConnections({ owner: "alice" });
  expect(ready).toMatchObject({ ready: true, credentialConfigured: true });
  expect(ready!.status.transport.state).toBe("ready");
  expect(ready!.status.modelAccess.state).toBe("unknown");
  expect(ready!.reason).toBeUndefined();

  const engine = sdkEngineForAdapter("compat-chat")!;
  await raw.setRuntimeProbe!("alice", configured.value.connectionId, `${engine.engine}@${engine.version}:1`, { state: "unavailable", reason: "缺少配套运行时" });
  const [blocked] = await provider.listConnections({ owner: "alice" });
  expect(blocked).toMatchObject({ ready: false, reason: "缺少配套运行时" });
});

it("does not project self-filled API sources without a provider assistant declaration", async () => {
  const documents = createInMemoryDocumentStore(["sdk", "sources"]);
  const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets: createInMemorySecretStore() });
  const registry = createServiceConnectionRegistry({ documents: documents.forExtension("sources")!, checkEndpoint: () => true, validateBinding: () => false });
  const sdk = registry.forExtension("sdk-agent");
  sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["discussion", "target-execution"] });
  const source = declaredSource("manual", "personal", {
    bindings: [{ bindingId: "protocol:manual:chat-completions", extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: [], modelKeys: [] }],
  });
  registry.forExtension("manual").registerSource({ id: "manual", scope: "personal", get: async () => source, list: async () => [source] });
  const bridged = withServiceSources(raw, sdk);
  expect(await bridged.list("alice")).toEqual([]);
});

it("bridges the original authority, isolates owners and freezes Agent/Provider versions without copying keys", async () => {
  const documents = createInMemoryDocumentStore(["sdk", "sources"]);
  const secrets = createInMemorySecretStore();
  const raw = createConnectionService({ documents: documents.forExtension("sdk")!, secrets });
  const configured = await raw.configure("alice", { operationId: "create", adapterId: "compat-chat", name: "Relay", authMode: "api-key", runCategory: "agent-sdk", baseUrl: "https://relay.example/v1", models: ["model"], secret: "original-key", expectedEpoch: 0, expectedRevision: 0 });
  if (!configured.ok) throw new Error(configured.error.message);
  const registry = createServiceConnectionRegistry({ documents: documents.forExtension("sources")!, secrets, checkEndpoint: () => true, validateBinding: () => false });
  const sdk = registry.forExtension("sdk-agent");
  const release = sdk.registerSource(createSdkServiceSource(raw));
  const stopConsumer = sdk.registerConsumer({ protocols: ["chat-completions"], purposes: ["discussion", "target-execution"] });
  const write = vi.spyOn(secrets, "write");
  const [source] = await sdk.list("alice");
  expect(await sdk.list("bob")).toEqual([]);
  expect(write).not.toHaveBeenCalled();
  const actor = { owner: "alice", administrator: false, canUseSite: true };
  const provider = registry.forExtension("text-provider");
  provider.registerConsumer({ protocols: ["chat-completions"], purposes: ["text"] });
  const bound = await registry.bind(actor, source.serviceConnectionId, { bindingId: "provider:text", extensionId: "text-provider", consumer: "provider", consumerId: "text", purposes: ["text"], modelKeys: ["text:model"] }, source,
    [...source.capabilities, { purpose: "text", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" }]);
  const call = { ...bound, bindingId: "provider:text", purpose: "text" as const, protocol: "chat-completions", modelId: "model", endpoint: source.endpoints[0].baseUrl };
  expect(await provider.resolve("alice", call)).toMatchObject({ secret: "original-key" });
  await expect(provider.resolve("bob", call)).rejects.toMatchObject({ code: "forbidden" });
  await expect(provider.resolve("alice", { ...call, modelId: "unbound" })).rejects.toMatchObject({ code: "forbidden" });
  const effective = withServiceSources(raw, sdk);
  const before = await effective.get("alice", configured.value.connectionId);
  await raw.saveCredential({ owner: "alice", connectionId: configured.value.connectionId, purpose: "model-api-key", secret: "new-key", expectedEpoch: configured.value.credentialEpoch });
  await expect(provider.resolve("alice", call)).rejects.toMatchObject({ code: "stale" });
  expect((await effective.get("alice", configured.value.connectionId))?.configRevision).not.toBe(before?.configRevision);
  expect(write).toHaveBeenCalledTimes(1); // Only the original authority rotates its immutable secret.
  const current = (await sdk.get("alice", source.serviceConnectionId))!;
  release(); stopConsumer();
  expect(await provider.resolve("alice", { ...call, ...current })).toMatchObject({ secret: "new-key" });
  await expect(sdk.resolve("alice", { ...call, ...current, purpose: "discussion", bindingId: `sdk:${configured.value.connectionId}` })).rejects.toMatchObject({ code: "forbidden" });
  expect(JSON.stringify(await provider.list("alice"))).not.toMatch(/original-key|new-key|credentialKey/);
});
