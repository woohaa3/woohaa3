import { expect, it, vi } from "vitest";
import { createConnectionService } from "@woohaa3/agent-connections";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "../../../../services/agent-connections/src/test-doubles.js";
import { createServiceConnectionRegistry } from "../../../../services/application-service/src/service-connections/registry.js";
import { createSdkServiceSource, withServiceSources } from "./service-source.js";

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
