import { describe, expect, it, vi } from "vitest";
import type { ServiceConnectionSave, ServiceConsumerBinding } from "@woohaa3/contracts";
import { createSqliteExtensionDocumentStore } from "../repository/extension-document-store.js";
import { createServiceConnectionRegistry } from "./registry.js";
import { createInMemorySecretStore } from "../../../agent-connections/src/test-doubles.js";

const alice = { owner: "alice", administrator: false, canUseSite: true };
const bob = { ...alice, owner: "bob" };
const admin = { ...alice, owner: "admin", administrator: true };
const input: ServiceConnectionSave = { operationId: "create", expectedRevision: 0, expectedCredentialEpoch: 0, name: "Relay", endpoints: [{ protocol: "responses", baseUrl: "https://relay.example/v1" }], secret: "private-key" };
const binding: ServiceConsumerBinding = { bindingId: "sdk:1", extensionId: "sdk", consumer: "agent", consumerId: "conn-1", purposes: ["text"], modelKeys: ["model-1"] };
function fixture() {
  const store = createSqliteExtensionDocumentStore({ path: ":memory:", owners: ["sources"] });
  const documents = store.forExtension("sources")!;
  const secrets = createInMemorySecretStore();
  const read = vi.spyOn(secrets, "read");
  const options = { documents, secrets, checkEndpoint: (url: string) => url === "https://relay.example/v1", validateBinding: (candidate: ServiceConsumerBinding) => candidate.extensionId === "sdk" && candidate.purposes.every(purpose => purpose === "text") };
  const registry = createServiceConnectionRegistry(options);
  return { registry, options, documents, secrets, read, close: () => store.close() };
}
async function usable(f: ReturnType<typeof fixture>) {
  let connection = (await f.registry.save(alice, input)).connection;
  connection = await f.registry.publishCapabilities(alice, connection.serviceConnectionId, connection, [{ purpose: "text", protocol: "responses", modelId: "model-1", imageInput: false, evidence: "adapter" }]);
  connection = await f.registry.bind(alice, connection.serviceConnectionId, binding, connection);
  return { ...connection, bindingId: binding.bindingId, purpose: "text" as const, protocol: "responses", endpoint: input.endpoints[0].baseUrl, modelId: "model-1" };
}
describe("service source authority", () => {
  it("isolates owners and scopes and never returns credentials or internal references", async () => {
    const f = fixture();
    try {
      const saved = await f.registry.save(alice, input);
      expect(await f.registry.list(bob)).toEqual([]);
      expect(await f.registry.get(bob, saved.connection.serviceConnectionId)).toBeNull();
      expect(JSON.stringify(saved)).not.toMatch(/private-key|credentialKey|pending:/);
      await expect(f.registry.save(bob, { ...input, operationId: "steal", serviceConnectionId: saved.connection.serviceConnectionId, expectedRevision: 1, expectedCredentialEpoch: 1 })).rejects.toMatchObject({ code: "forbidden" });
      await expect(f.registry.save(alice, input, "site")).rejects.toMatchObject({ code: "forbidden" });
      const site = await f.registry.save(admin, input, "site");
      expect(await f.registry.get(alice, site.connection.serviceConnectionId)).toMatchObject({ managedByAdministrator: true, endpoints: [], bindings: [] });
    } finally { f.close(); }
  });
  it("replays a lost response after recreation, rejects operation reuse and does not merge URLs", async () => {
    const f = fixture();
    try {
      const saved = await f.registry.save(alice, input);
      const restarted = createServiceConnectionRegistry(f.options);
      expect(await restarted.save(alice, input)).toEqual(saved);
      await expect(restarted.save(alice, { ...input, secret: "different" })).rejects.toMatchObject({ code: "conflict" });
      const other = await restarted.save(alice, { ...input, operationId: "another-account", secret: "other" });
      expect(other.connection.serviceConnectionId).not.toBe(saved.connection.serviceConnectionId);
      expect(await restarted.list(alice)).toHaveLength(2);
    } finally { f.close(); }
  });
  it("checks binding, owner, purpose, model and actual endpoint before reading secrets", async () => {
    const f = fixture();
    try {
      const call = await usable(f);
      f.read.mockClear();
      for (const [actor, extension, patch] of [
        [bob, "sdk", {}], [alice, "attacker", {}], [alice, "sdk", { bindingId: "forged" }],
        [alice, "sdk", { purpose: "image" }], [alice, "sdk", { endpoint: "https://attacker.example" }],
        [alice, "sdk", { modelId: "unknown" }],
      ] as const) await expect(f.registry.resolve(actor, extension, { ...call, ...patch } as typeof call)).rejects.toBeDefined();
      expect(f.read).not.toHaveBeenCalled();
      expect(await f.registry.resolve(alice, "sdk", call)).toMatchObject({ secret: "private-key" });
    } finally { f.close(); }
  });
  it("stages secrets without replacing active material if metadata publication fails", async () => {
    const f = fixture();
    try {
      const call = await usable(f);
      const update = { ...input, operationId: "rotate", serviceConnectionId: call.serviceConnectionId, expectedRevision: call.configRevision, expectedCredentialEpoch: call.credentialEpoch, secret: "new-key" };
      const batch = f.documents.batch.bind(f.documents);
      const spy = vi.spyOn(f.documents, "batch").mockImplementation(async operations => {
        if (operations.some(operation => operation.key.startsWith("sources/"))) return { ok: false, code: "invalid", message: "injected metadata failure" };
        return batch(operations);
      });
      await expect(f.registry.save(alice, update)).rejects.toMatchObject({ code: "storage-failed" });
      expect(await f.registry.resolve(alice, "sdk", call)).toMatchObject({ secret: "private-key" });
      spy.mockRestore();
      const saved = await createServiceConnectionRegistry(f.options).save(alice, update);
      expect(saved.connection.credentialEpoch).toBe(call.credentialEpoch + 1);
      await expect(f.registry.resolve(alice, "sdk", call)).rejects.toMatchObject({ code: "stale" });
      expect(await f.registry.save(alice, update)).toEqual(saved);
    } finally { f.close(); }
  });
  it("rejects concurrent writers and late evidence; removal keeps invalid bindings for history", async () => {
    const f = fixture();
    try {
      const call = await usable(f);
      const update = { ...input, secret: undefined, serviceConnectionId: call.serviceConnectionId, expectedRevision: call.configRevision, expectedCredentialEpoch: call.credentialEpoch };
      const results = await Promise.allSettled([f.registry.save(alice, { ...update, operationId: "a" }), f.registry.save(alice, { ...update, operationId: "b" })]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      await expect(f.registry.publishCapabilities(alice, call.serviceConnectionId, call, [])).rejects.toMatchObject({ code: "stale" });
      const current = (await f.registry.get(alice, call.serviceConnectionId))!;
      const removed = await f.registry.remove(alice, call.serviceConnectionId, current);
      expect(removed.bindings).toEqual([binding]);
      expect(await f.registry.list(alice)).toEqual([]);
      await expect(f.registry.resolve(alice, "sdk", call)).rejects.toMatchObject({ code: "stale" });
    } finally { f.close(); }
  });
});

describe("registered source adapters", () => {
  it("persists owner mappings, keeps accounts at identical URLs separate, rechecks rotation before secret access", async () => {
    const f = fixture();
    const secrets = new Map([["alice:a", "first"], ["alice:b", "second"]]);
    let epoch = 1;
    const get = async (owner: string, id: string) => secrets.has(`${owner}:${id}`) ? {
      legacyId: id, scope: "personal" as const, kind: "api" as const, name: id,
      endpoints: input.endpoints, capabilities: [{ purpose: "text" as const, protocol: "responses" as const, modelId: "model-1", imageInput: false, evidence: "adapter" as const }],
      bindings: [{ ...binding, consumerId: id, bindingId: id }], enabled: true, removed: false, locked: false,
      credentialConfigured: true, configRevision: 1, credentialEpoch: epoch,
    } : null;
    const readSecret = vi.fn(async (owner: string, id: string) => secrets.get(`${owner}:${id}`) ?? null);
    const adapter = { id: "legacy", scope: "personal" as const, get,
      list: async (owner: string) => (await Promise.all([get(owner, "a"), get(owner, "b")])).filter((value): value is NonNullable<typeof value> => !!value), readSecret };
    try {
      const port = f.registry.forExtension("sdk");
      const release = port.registerSource(adapter);
      const sources = await port.list("alice");
      expect(sources).toHaveLength(2);
      expect(await port.list("bob")).toEqual([]);
      expect(readSecret).not.toHaveBeenCalled();
      const call = { ...sources[0], bindingId: "a", purpose: "text" as const, protocol: "responses", modelId: "model-1", endpoint: input.endpoints[0].baseUrl };
      expect(await port.resolve("alice", call)).toMatchObject({ secret: "first" });
      epoch++;
      readSecret.mockClear();
      await expect(port.resolve("alice", call)).rejects.toMatchObject({ code: "stale" });
      expect(readSecret).not.toHaveBeenCalled();
      const restarted = createServiceConnectionRegistry(f.options).forExtension("sdk");
      restarted.registerSource(adapter);
      expect((await restarted.list("alice")).map(source => source.serviceConnectionId)).toEqual(sources.map(source => source.serviceConnectionId));
      release();
      expect(await port.get("alice", call.serviceConnectionId)).toMatchObject({ enabled: false });
      expect(JSON.stringify(await restarted.list("alice"))).not.toMatch(/first|second|origin|credentialKey/);
    } finally { f.close(); }
  });
  it("removes a disabled adapter source and republishes it only after the adapter content changes", async () => {
    const f = fixture();
    let enabled = true;
    let name = "source-a";
    const snapshot = () => ({
      legacyId: "a", scope: "personal" as const, kind: "api" as const, name, endpoints: input.endpoints,
      capabilities: [{ purpose: "text" as const, protocol: "responses" as const, modelId: "model-1", imageInput: false, evidence: "adapter" as const }],
      bindings: [{ ...binding, bindingId: "a", consumerId: "a" }],
      enabled, removed: false, locked: false, credentialConfigured: true, configRevision: 1, credentialEpoch: 1,
    });
    const adapter = { id: "removable", scope: "personal" as const, get: async () => snapshot(), list: async () => [snapshot()] };
    try {
      const port = f.registry.forExtension("sdk");
      port.registerSource(adapter);
      const [active] = await port.list("alice");
      await expect(f.registry.remove(alice, active.serviceConnectionId, active)).rejects.toMatchObject({ code: "invalid" });

      enabled = false;
      const [disabled] = await port.list("alice");
      const removed = await f.registry.remove(alice, disabled.serviceConnectionId, disabled);
      expect(removed.removed).toBe(true);
      expect(await port.list("alice")).toEqual([]);
      expect(await port.list("alice")).toEqual([]);

      name = "source-b";
      const [revived] = await port.list("alice");
      expect(revived).toMatchObject({ serviceConnectionId: active.serviceConnectionId, name: "source-b", removed: false });
    } finally { f.close(); }
  });
});

it("adds a protocol without copying credentials, invalidates every use on disable and denies unsupported media", async () => {
  const f = fixture();
  try {
    let source = (await f.registry.save(alice, input)).connection;
    const port = f.registry.forExtension("sdk-agent");
    port.registerConsumer({ protocols: ["responses"], purposes: ["text"] });
    source = await f.registry.addProtocol(alice, source.serviceConnectionId, source, input.endpoints[0], ["model-1"]);
    const call = { ...source, bindingId: `protocol:${source.serviceConnectionId}:responses`, purpose: "text" as const, protocol: "responses", modelId: "model-1", endpoint: input.endpoints[0].baseUrl };
    f.read.mockClear();
    expect(await port.resolve("alice", call)).toMatchObject({ secret: "private-key" });
    await expect(port.resolve("alice", { ...call, purpose: "image" })).rejects.toMatchObject({ code: "forbidden" });
    const disabled = await f.registry.setEnabled(alice, source.serviceConnectionId, source, false);
    await expect(port.resolve("alice", call)).rejects.toMatchObject({ code: "stale" });
    const enabled = await f.registry.setEnabled(alice, source.serviceConnectionId, disabled, true);
    expect(enabled.credentialEpoch).toBe(source.credentialEpoch);
    expect(enabled.configRevision).toBeGreaterThan(source.configRevision);
    // Exactly the original published secret remains the active material for both protocols.
    expect(await port.resolve("alice", { ...call, ...enabled })).toMatchObject({ secret: "private-key" });
  } finally { f.close(); }
});

it("only explicitly merges drained compatible sources, atomically rebinds and replays confirmation", async () => {
  const f = fixture();
  let busy = true;
  const registry = createServiceConnectionRegistry({ ...f.options, hasUnresolvedWork: () => busy });
  try {
    const a = await usable({ ...f, registry });
    const b = (await registry.save(alice, { ...input, operationId: "second", secret: "other-account" })).connection;
    expect((await registry.suspectedDuplicates(alice)).map(pair => [...pair].sort())).toEqual([[a.serviceConnectionId, b.serviceConnectionId].sort()]);
    const merge = { operationId: "confirm-merge", retainedId: a.serviceConnectionId, removedId: b.serviceConnectionId, retained: a, removed: b };
    await expect(registry.merge(alice, merge)).rejects.toMatchObject({ code: "conflict" });
    expect(await registry.get(alice, b.serviceConnectionId)).toMatchObject({ removed: false });
    busy = false;
    const merged = await registry.merge(alice, merge);
    expect(await registry.list(alice)).toHaveLength(1);
    expect(await registry.get(alice, b.serviceConnectionId)).toMatchObject({ removed: true });
    const restarted = createServiceConnectionRegistry({ ...f.options, hasUnresolvedWork: () => false });
    expect(await restarted.merge(alice, merge)).toEqual(merged);
    await expect(restarted.merge(bob, { ...merge, operationId: "steal" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(restarted.merge(alice, { ...merge, retained: { ...merge.retained, configRevision: merge.retained.configRevision + 1 } })).rejects.toMatchObject({ code: "conflict" });
  } finally { f.close(); }
});
