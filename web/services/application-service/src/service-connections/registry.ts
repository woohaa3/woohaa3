import { isServiceConnectionSave } from "@woohaa3/contracts";
import { createHash, randomUUID } from "node:crypto";
import type {
  ApplicationExtensionSecretStore, ExtensionDocumentStore, ExtensionDocumentValue,
  ServiceConnectionView, ServiceConnectionVersion, ServiceConnectionSave,
  ServiceConnectionOperationResult, ServiceConsumerBinding, ServiceConnectionPurpose, ServiceConnectionCapability,
  ServiceConnectionSourceAdapter, ServiceConnectionSourceSnapshot, ApplicationServiceConnectionFacade,
} from "@woohaa3/contracts";

/** Trusted principal only; never construct from JSON request fields. */
export type ServiceConnectionActor = { owner: string; administrator: boolean; canUseSite: boolean };
type Source = ServiceConnectionView & { owner: string | null; credentialKey: string | null; origin?: { extensionId: string; adapterId: string; legacyId: string; version: ServiceConnectionVersion }; originFingerprint?: string; originCredentialFingerprint?: string; removedFingerprint?: string; mergedInto?: string; extraBindings?: readonly ServiceConsumerBinding[]; extraCapabilities?: readonly ServiceConnectionCapability[]; extraEndpoints?: ServiceConnectionView["endpoints"]; enabledOverride?: boolean };
type Operation = { fingerprint: string; sourceId: string; credentialKey: string; state: "pending" | "published"; result?: ServiceConnectionView };
export class ServiceConnectionError extends Error {
  constructor(readonly code: "not-found" | "forbidden" | "locked" | "conflict" | "invalid" | "storage-failed" | "stale" | "unavailable", message: string) { super(message); }
}
export type ServiceConnectionRegistryOptions = {
  documents: ExtensionDocumentStore;
  /** Fail closed if the host cannot prove both Agent and Task executions have drained. */
  hasUnresolvedWork?: (owner: string, bindings: readonly ServiceConsumerBinding[]) => boolean | Promise<boolean>;
  secrets?: ApplicationExtensionSecretStore;
  /** Must validate every destination under deployment policy, before secret reads. */
  checkEndpoint: (url: string) => boolean;
  /** Adapter/model evidence must be supplied by a trusted registration, never inferred from URL. */
  validateBinding: (binding: ServiceConsumerBinding, source: ServiceConnectionView) => boolean;
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as ExtensionDocumentValue;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceKey = (id: string) => `sources/${id}`;
/** 旧版 Agent 用途（discussion / target-execution）在读取旧来源时并入 text，避免旧数据卡住。 */
const LEGACY_AGENT_PURPOSES = new Set(["discussion", "target-execution"]);
const normalizePurpose = (purpose: string): ServiceConnectionPurpose =>
  LEGACY_AGENT_PURPOSES.has(purpose) ? "text" : purpose as ServiceConnectionPurpose;
const normalizeExtraCapability = (capability: ServiceConnectionCapability): ServiceConnectionCapability =>
  LEGACY_AGENT_PURPOSES.has(String(capability.purpose)) ? { ...capability, purpose: "text" } : capability;
const normalizeExtraBinding = (binding: ServiceConsumerBinding): ServiceConsumerBinding => ({
  ...binding, purposes: [...new Set(binding.purposes.map(purpose => normalizePurpose(String(purpose))))]
});
const dedupeCapabilities = (capabilities: readonly ServiceConnectionCapability[]) => {
  const seen = new Set<string>();
  return capabilities.filter(capability => {
    const key = `${capability.purpose}\u0000${capability.protocol}\u0000${capability.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Persistent source authority. Secrets are immutable and invisible until metadata CAS publishes them.
 * A pending operation is recoverable after a process crash without touching the old active secret.
 */
export function createServiceConnectionRegistry(options: ServiceConnectionRegistryOptions) {
  const { documents, secrets } = options;
  const consumers = new Map<string, { protocols: readonly string[]; purposes: readonly ServiceConnectionPurpose[] }>();
  const adapters = new Map<string, { extensionId: string; adapter: ServiceConnectionSourceAdapter; active: boolean }>();
  const adapterKey = (extensionId: string, adapterId: string) => JSON.stringify([extensionId, adapterId]);
  const personal = (owner: string): ServiceConnectionActor => ({ owner, administrator: false, canUseSite: true });
  const secretOwner = (source: Source) => source.scope === "personal" ? source.owner! : "@site";
  const requireActor = (actor: ServiceConnectionActor) => { if (!actor.owner) throw new ServiceConnectionError("forbidden", "缺少可信身份"); };
  const mayRead = (actor: ServiceConnectionActor, source: Source) => source.scope === "personal" ? source.owner === actor.owner : actor.administrator || actor.canUseSite;
  const mayWrite = (actor: ServiceConnectionActor, source: Source) => source.scope === "personal" ? source.owner === actor.owner : actor.administrator;
  const view = (source: Source, actor: ServiceConnectionActor): ServiceConnectionView => ({
    serviceConnectionId: source.serviceConnectionId, scope: source.scope, kind: source.kind, name: source.name,
    endpoints: mayWrite(actor, source) || source.bindings.some(binding => binding.consumer === "agent") ? source.endpoints : [], capabilities: source.scope === "site" && !actor.administrator ? source.capabilities.filter(capability => source.bindings.some(binding => binding.purposes.includes(capability.purpose))) : source.capabilities,
    bindings: source.bindings, enabled: source.enabled, removed: source.removed,
    credentialConfigured: source.credentialConfigured, locked: source.locked,
    managedByAdministrator: source.scope === "site" && !actor.administrator,
    configRevision: source.configRevision, credentialEpoch: source.credentialEpoch,
  });
  const read = async (id: string) => {
    const result = await documents.get(sourceKey(id));
    return result.found ? { source: result.document.value as unknown as Source, revision: result.document.revision } : null;
  };
  const syncSnapshot = async (actor: ServiceConnectionActor, extensionId: string, adapter: ServiceConnectionSourceAdapter, snapshot: ServiceConnectionSourceSnapshot) => {
    requireActor(actor);
    // Source-owned bindings must belong to the registering extension. A shared Agent consumer binding may
    // name the consuming extension instead; resolve() still requires that consumer to be registered with a
    // matching protocol/purpose and the source to carry the matching capability evidence.
    if (adapter.scope !== snapshot.scope || snapshot.bindings.some(binding => binding.extensionId !== extensionId && binding.consumer !== "agent")) throw new ServiceConnectionError("forbidden", "来源声明不属于注册扩展");
    const id = `service-${digest([extensionId, adapter.id, adapter.scope, adapter.scope === "personal" ? actor.owner : "@site", snapshot.legacyId])}`;
    const found = await read(id);
    const fingerprint = digest(snapshot);
    if (found?.source.mergedInto) return found.source;
    if (found?.source.removed) {
      // A removed adapter source stays tombstoned for its old content. Reconfiguring the provider
      // (a new snapshot fingerprint) is an explicit new intent and may republish the same identity.
      const oauthRefresh = snapshot.kind === "oauth" && found.source.origin?.version.credentialEpoch !== snapshot.credentialEpoch;
      const reconfigured = !!found.source.origin && !!found.source.removedFingerprint && found.source.removedFingerprint !== fingerprint;
      if (!oauthRefresh && !reconfigured) return found.source;
    }
    // The fingerprint covers the adapter snapshot, including model identities. Stored
    // metadata also contains host-added bindings/endpoints: comparing it directly to
    // the snapshot would republish every read and invalidate active turns.
    if (found?.source.originFingerprint === fingerprint) return found.source;
    const { legacyId, credentialFingerprint, ...data } = snapshot;
    const extraCapabilities = (found?.source.extraCapabilities ?? []).map(normalizeExtraCapability);
    const extraBindings = (found?.source.extraBindings ?? []).map(normalizeExtraBinding);
    const next: Source = { ...data, serviceConnectionId: id, owner: adapter.scope === "personal" ? actor.owner : null,
      endpoints: [...data.endpoints, ...(found?.source.extraEndpoints ?? []).filter(endpoint => !data.endpoints.some(candidate => candidate.protocol === endpoint.protocol))], extraEndpoints: found?.source.extraEndpoints ?? [],
      enabled: data.enabled && found?.source.enabledOverride !== false, ...(found?.source.enabledOverride !== undefined ? { enabledOverride: found.source.enabledOverride } : {}),
      credentialKey: null, managedByAdministrator: false,
      capabilities: dedupeCapabilities([...data.capabilities, ...extraCapabilities.filter(capability => data.capabilities.some(candidate => candidate.modelId === capability.modelId && candidate.protocol === capability.protocol) || capability.purpose === "text" && (found?.source.extraEndpoints ?? []).some(endpoint => endpoint.protocol === capability.protocol))]),
      extraCapabilities,
      bindings: [...data.bindings, ...extraBindings], extraBindings,
      configRevision: (found?.source.configRevision ?? 0) + 1,
      credentialEpoch: (found?.source.credentialEpoch ?? 0) + (!found || (found.source.origin?.version.credentialEpoch !== snapshot.credentialEpoch || found.source.originCredentialFingerprint !== credentialFingerprint) ? 1 : 0),
      origin: { extensionId, adapterId: adapter.id, legacyId, version: { configRevision: snapshot.configRevision, credentialEpoch: snapshot.credentialEpoch } }, originFingerprint: fingerprint, ...(credentialFingerprint ? { originCredentialFingerprint: credentialFingerprint } : {}) };
    await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: found?.revision ?? null }]);
    return next;
  };
  const syncQueues = new Map<string, Promise<unknown>>();
  const sync = async (actor: ServiceConnectionActor, extensionId: string, adapter: ServiceConnectionSourceAdapter, snapshot: ServiceConnectionSourceSnapshot): Promise<Source> => {
    const key = JSON.stringify([extensionId, adapter.id, adapter.scope === "site" ? "@site" : actor.owner, snapshot.legacyId]);
    const previous = syncQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      for (let attempt = 0; ; attempt++) {
        const latest = await adapter.get(actor.owner, snapshot.legacyId);
        if (!latest) throw new ServiceConnectionError("stale", "来源已变化，请重试");
        try { return await syncSnapshot(actor, extensionId, adapter, latest); }
        catch (error) { if (!(error instanceof ServiceConnectionError) || error.code !== "conflict" || attempt >= 2) throw error; }
      }
    });
    syncQueues.set(key, operation);
    try { return await operation; } finally { if (syncQueues.get(key) === operation) syncQueues.delete(key); }
  };
  const refresh = async (actor: ServiceConnectionActor, source: Source) => {
    if (!source.origin || source.mergedInto || source.removed) return source;
    const registered = adapters.get(adapterKey(source.origin.extensionId, source.origin.adapterId));
    if (!registered || !registered.active && !registered.adapter.retainAuthorityOnDispose) return { ...source, enabled: false };
    const snapshot = await registered.adapter.get(actor.owner, source.origin.legacyId);
    if (snapshot) return sync(actor, registered.extensionId, registered.adapter, snapshot);
    const current = await read(source.serviceConnectionId);
    if (!current || current.source.removed) return current?.source ?? source;
    const tombstone = { ...current.source, enabled: false, removed: true, credentialConfigured: false, configRevision: current.source.configRevision + 1, credentialEpoch: current.source.credentialEpoch + 1 };
    await write([{ op: "set", key: sourceKey(source.serviceConnectionId), value: json(tombstone), expectedRevision: current.revision }]);
    return tombstone;
  };
  const get = async (actor: ServiceConnectionActor, id: string) => {
    requireActor(actor);
    const found = await read(id);
    return found && mayRead(actor, found.source) ? view(await refresh(actor, found.source), actor) : null;
  };
  const write = async (operations: Parameters<ExtensionDocumentStore["batch"]>[0]) => {
    const result = await documents.batch(operations);
    if (!result.ok) throw new ServiceConnectionError(result.code === "revision-conflict" ? "conflict" : "storage-failed", "服务连接未发布，请保留草稿并重试原操作。");
  };
  const assertEndpoints = (endpoints: ServiceConnectionView["endpoints"]) => {
    const protocols = new Set<string>();
    if (endpoints.length === 0) throw new ServiceConnectionError("invalid", "缺少协议入口");
    for (const endpoint of endpoints) {
      let url: URL;
      try { url = new URL(endpoint.baseUrl); } catch { throw new ServiceConnectionError("invalid", "接口地址无效"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || protocols.has(endpoint.protocol) || !options.checkEndpoint(endpoint.baseUrl)) throw new ServiceConnectionError("invalid", "协议重复或接口地址不符合部署策略");
      protocols.add(endpoint.protocol);
    }
  };
  const list = async (actor: ServiceConnectionActor) => {
    requireActor(actor);
    for (const { extensionId, adapter, active } of adapters.values()) {
      if (!active && !adapter.retainAuthorityOnDispose) continue;
      if (adapter.scope === "site" && !actor.administrator && !actor.canUseSite) continue;
      for (const snapshot of await adapter.list(actor.owner)) await sync(actor, extensionId, adapter, snapshot);
    }
    const all: ServiceConnectionView[] = [];
    let cursor: string | undefined;
    do {
      const page = await documents.scan("sources/", { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) {
        const source = entry.value as unknown as Source;
        if (mayRead(actor, source) && !source.removed) {
          const current = await refresh(actor, source);
          if (!current.removed) all.push(view(current, actor));
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  };
  const bindingAllowed = (binding: ServiceConsumerBinding, source: Source, actor: ServiceConnectionActor) => {
    const consumer = consumers.get(binding.extensionId);
    if (consumer && binding.purposes.every(purpose => consumer.purposes.includes(purpose)) && source.capabilities.some(capability => binding.purposes.includes(capability.purpose) && consumer.protocols.includes(capability.protocol))) return true;
    if (source.origin && source.origin.extensionId === binding.extensionId && adapters.get(adapterKey(binding.extensionId, source.origin.adapterId))?.active) return true;
    return options.validateBinding(binding, view(source, actor));
  };
  const registry = {
    get, list,
    forExtension(extensionId: string): ApplicationServiceConnectionFacade {
      return {
        registerConsumer(input) {
          if (consumers.has(extensionId)) throw new ServiceConnectionError("conflict", "消费适配器已注册");
          consumers.set(extensionId, input);
          return () => { if (consumers.get(extensionId) === input) consumers.delete(extensionId); };
        },
        registerSource(adapter) {
          const key = adapterKey(extensionId, adapter.id);
          if (adapters.get(key)?.active) throw new ServiceConnectionError("conflict", "来源适配器已注册");
          const registration = { extensionId, adapter, active: true };
          adapters.set(key, registration);
          return () => { if (adapters.get(key) === registration) registration.active = false; };
        },
        list: owner => list(personal(owner)),
        get: (owner, id) => get(personal(owner), id),
        resolve: (owner, input) => registry.resolve(personal(owner), extensionId, input),
      };
    },
    async save(actor: ServiceConnectionActor, input: ServiceConnectionSave, scope: "personal" | "site" = "personal"): Promise<ServiceConnectionOperationResult> {
      requireActor(actor);
      if (!isServiceConnectionSave(input)) throw new ServiceConnectionError("invalid", "操作或连接内容无效");
      if (scope === "site" && !actor.administrator) throw new ServiceConnectionError("forbidden", "仅管理员可管理站点来源");
      assertEndpoints(input.endpoints);
      // Fingerprint never persists plaintext secrets. Actor and scope are part of operation identity.
      const opKey = `operations/${digest([actor.owner, scope, input.operationId])}`;
      const fingerprint = digest([scope, input]);
      let operationRead = await documents.get(opKey);
      let operation = operationRead.found ? operationRead.document.value as unknown as Operation : null;
      if (operation && operation.fingerprint !== fingerprint) throw new ServiceConnectionError("conflict", "相同操作身份不能保存不同内容");
      if (operation?.state === "published") return { operationId: input.operationId, connection: operation.result! };
      const id = operation?.sourceId ?? input.serviceConnectionId ?? `service-${randomUUID()}`;
      const found = await read(id);
      if (input.serviceConnectionId && !found) throw new ServiceConnectionError("not-found", "来源不存在或无权访问");
      if (found && (!mayWrite(actor, found.source) || found.source.scope !== scope)) throw new ServiceConnectionError("forbidden", "无权修改来源");
      if (found?.source.origin) throw new ServiceConnectionError("invalid", "请使用来源适配器保存，不能创建第二份凭据");
      if (found?.source.locked) throw new ServiceConnectionError("locked", "此来源由环境配置锁定");
      if (found?.source.removed || (found?.source.configRevision ?? 0) !== input.expectedRevision || (found?.source.credentialEpoch ?? 0) !== input.expectedCredentialEpoch) throw new ServiceConnectionError("conflict", "来源已变化，请重新读取；草稿尚未保存");
      if (!operation) {
        operation = { fingerprint, sourceId: id, credentialKey: `pending:${randomUUID()}`, state: "pending" };
        await write([{ op: "set", key: opKey, value: json(operation), expectedRevision: null }]);
        operationRead = await documents.get(opKey);
      }
      const secret = input.secret?.trim();
      const credentialKey = secret ? operation.credentialKey : input.clearCredential ? null : found?.source.credentialKey ?? null;
      const source: Source = {
        serviceConnectionId: id, scope, owner: scope === "personal" ? actor.owner : null, kind: "api", name: input.name.trim(),
        endpoints: [...input.endpoints], capabilities: secret || input.clearCredential || JSON.stringify(input.endpoints) !== JSON.stringify(found?.source.endpoints) ? [] : found?.source.capabilities ?? [], bindings: found?.source.bindings ?? [],
        enabled: input.enabled ?? found?.source.enabled ?? true, removed: false, locked: false, managedByAdministrator: false,
        credentialKey, credentialConfigured: credentialKey !== null,
        configRevision: (found?.source.configRevision ?? 0) + 1,
        credentialEpoch: (found?.source.credentialEpoch ?? 0) + (secret || input.clearCredential ? 1 : 0),
      };
      if (secret) {
        if (!secrets) throw new ServiceConnectionError("unavailable", "加密秘密仓库不可用");
        const staged = secrets.read<{ secret: string }>(secretOwner(source), credentialKey!);
        if (!staged) {
          const result = secrets.write(secretOwner(source), credentialKey!, { secret }, { version: 0, epoch: secrets.epoch(secretOwner(source)) });
          if (!result.ok) throw new ServiceConnectionError("storage-failed", "秘密暂存失败；原来源保持有效");
        }
      }
      const result = view(source, actor);
      await write([
        { op: "set", key: sourceKey(id), value: json(source), expectedRevision: found?.revision ?? null },
        { op: "set", key: opKey, value: json({ ...operation, state: "published", result }), expectedRevision: operationRead.found ? operationRead.document.revision : null },
      ]);
      // Old immutable secrets remain unreachable. Reclamation is separate from publication.
      return { operationId: input.operationId, connection: result };
    },
    async suspectedDuplicates(actor: ServiceConnectionActor) {
      const sources = await list(actor);
      return sources.flatMap((source, index) => sources.slice(index + 1).filter(other => other.scope === source.scope && source.endpoints.some(endpoint => other.endpoints.some(candidate => candidate.protocol === endpoint.protocol && candidate.baseUrl === endpoint.baseUrl))).map(other => [source.serviceConnectionId, other.serviceConnectionId] as const));
    },
    /** Explicit, atomic metadata rebinding. Old identities remain tombstones for history and rollback. */
    async merge(actor: ServiceConnectionActor, input: { operationId: string; retainedId: string; removedId: string; retained: ServiceConnectionVersion; removed: ServiceConnectionVersion }) {
      requireActor(actor);
      if (!input.operationId || input.retainedId === input.removedId) throw new ServiceConnectionError("invalid", "请选择两个不同来源");
      const key = `merges/${digest([actor.owner, input.operationId])}`;
      const fingerprint = digest(input);
      const previous = await documents.get(key);
      if (previous.found) {
        const operation = previous.document.value as unknown as { fingerprint: string; result: ServiceConnectionView };
        if (operation.fingerprint !== fingerprint) throw new ServiceConnectionError("conflict", "合并操作内容已变化");
        return operation.result;
      }
      const retained = await read(input.retainedId), removed = await read(input.removedId);
      if (!retained || !removed || !mayWrite(actor, retained.source) || !mayWrite(actor, removed.source)) throw new ServiceConnectionError("forbidden", "无权合并来源");
      if (retained.source.scope !== removed.source.scope || retained.source.owner !== removed.source.owner) throw new ServiceConnectionError("forbidden", "不能转让来源范围或所有者");
      if (retained.source.locked || removed.source.locked || retained.source.kind !== "api" || removed.source.kind !== "api") throw new ServiceConnectionError("locked", "环境锁定和账号授权来源不能合并");
      const a = await refresh(actor, retained.source), b = await refresh(actor, removed.source);
      if (a.removed || b.removed || a.configRevision !== input.retained.configRevision || a.credentialEpoch !== input.retained.credentialEpoch || b.configRevision !== input.removed.configRevision || b.credentialEpoch !== input.removed.credentialEpoch) throw new ServiceConnectionError("stale", "来源已变化，请重新确认");
      // Rebinding cannot silently change a consumer's destination or invent capabilities.
      if (b.endpoints.some(endpoint => !a.endpoints.some(candidate => candidate.protocol === endpoint.protocol && candidate.baseUrl === endpoint.baseUrl))) throw new ServiceConnectionError("invalid", "保留来源缺少原协议入口，请先配置并验证");
      if (!options.hasUnresolvedWork || await options.hasUnresolvedWork(actor.owner, [...a.bindings, ...b.bindings])) throw new ServiceConnectionError("conflict", "存在活动执行，合并暂缓");
      const extraBindings = [...(a.extraBindings ?? []), ...b.bindings.filter(binding => !a.bindings.some(candidate => candidate.bindingId === binding.bindingId))];
      const next: Source = { ...a, bindings: [...a.bindings, ...extraBindings.filter(binding => !a.bindings.some(candidate => candidate.bindingId === binding.bindingId))], extraBindings, configRevision: a.configRevision + 1 };
      const tombstone: Source = { ...b, mergedInto: a.serviceConnectionId, removed: true, enabled: false, credentialKey: null, credentialConfigured: false, configRevision: b.configRevision + 1, credentialEpoch: b.credentialEpoch + 1 };
      const result = view(next, actor);
      const finalA = await read(a.serviceConnectionId), finalB = await read(b.serviceConnectionId);
      if (!finalA || !finalB || digest(finalA.source) !== digest(a) || digest(finalB.source) !== digest(b)) throw new ServiceConnectionError("stale", "合并检查期间来源已变化");
      await write([
        { op: "set", key: sourceKey(a.serviceConnectionId), value: json(next), expectedRevision: finalA.revision },
        { op: "set", key: sourceKey(b.serviceConnectionId), value: json(tombstone), expectedRevision: finalB.revision },
        { op: "set", key, value: json({ fingerprint, result }), expectedRevision: null },
      ]);
      return result;
    },
    /** Only host adapter evidence may reach this method. A model name alone is not evidence. */
    async publishCapabilities(actor: ServiceConnectionActor, id: string, expected: ServiceConnectionVersion, capabilities: readonly ServiceConnectionCapability[]) {
      requireActor(actor);
      const found = await read(id);
      if (!found || !mayWrite(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权更新来源能力");
      if (found.source.configRevision !== expected.configRevision || found.source.credentialEpoch !== expected.credentialEpoch || found.source.removed) throw new ServiceConnectionError("stale", "丢弃旧代次能力结果");
      const next = { ...found.source, ...(found.source.origin ? { extraCapabilities: [...capabilities] } : {}), capabilities: [...capabilities], configRevision: found.source.configRevision + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: found.revision }]);
      return view(next, actor);
    },
    async remove(actor: ServiceConnectionActor, id: string, expected: ServiceConnectionVersion) {
      requireActor(actor);
      const found = await read(id);
      if (!found || !mayWrite(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权移除来源");
      // An active adapter source is owned by its Provider settings; only a disabled one can be discarded here.
      if (found.source.origin && found.source.enabled) throw new ServiceConnectionError("invalid", "请先停用来源，或使用来源适配器撤销授权");
      if (found.source.locked) throw new ServiceConnectionError("locked", "来源由环境锁定");
      if (found.source.configRevision !== expected.configRevision || found.source.credentialEpoch !== expected.credentialEpoch) throw new ServiceConnectionError("stale", "来源已变化");
      const next = { ...found.source, removed: true, enabled: false, credentialKey: null, credentialConfigured: false, ...(found.source.originFingerprint ? { removedFingerprint: found.source.originFingerprint } : {}), configRevision: found.source.configRevision + 1, credentialEpoch: found.source.credentialEpoch + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: found.revision }]);
      return view(next, actor);
    },
    /** Trusted adapter registration; browser callers cannot choose a credential reference. */
    async bind(actor: ServiceConnectionActor, id: string, binding: ServiceConsumerBinding, expected: ServiceConnectionVersion, capabilities?: readonly ServiceConnectionCapability[]) {
      requireActor(actor);
      const original = await read(id);
      if (!original || !mayWrite(actor, original.source)) throw new ServiceConnectionError("forbidden", "无权绑定来源");
      await refresh(actor, original.source);
      const found = (await read(id))!;
      if (found.source.configRevision !== expected.configRevision || found.source.credentialEpoch !== expected.credentialEpoch) throw new ServiceConnectionError("stale", "来源代次已变化");
      // Replaying the same auto binding is not a new configuration: keep the published revision.
      const existing = found.source.bindings.find(item => item.bindingId === binding.bindingId);
      if (existing && digest(existing) === digest(binding) && (!capabilities || digest(capabilities) === digest(found.source.capabilities))) return view(found.source, actor);
      const candidate = { ...found.source, capabilities: capabilities ? [...capabilities] : found.source.capabilities };
      if (!bindingAllowed(binding, candidate, actor)) throw new ServiceConnectionError("forbidden", "适配器未提供此用途");
      const next = { ...candidate, ...(capabilities ? { extraCapabilities: [...capabilities] } : {}), extraBindings: [...(found.source.extraBindings ?? []).filter(item => item.bindingId !== binding.bindingId), binding], bindings: [...found.source.bindings.filter(item => item.bindingId !== binding.bindingId), binding], configRevision: found.source.configRevision + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: found.revision }]);
      return view(next, actor);
    },
    async setEnabled(actor: ServiceConnectionActor, id: string, expected: ServiceConnectionVersion, enabled: boolean) {
      requireActor(actor);
      const found = await read(id);
      if (!found || !mayWrite(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权管理来源");
      const current = await refresh(actor, found.source);
      if (current.removed || current.configRevision !== expected.configRevision || current.credentialEpoch !== expected.credentialEpoch) throw new ServiceConnectionError("stale", "来源已变化");
      if (current.locked) throw new ServiceConnectionError("locked", "环境锁定来源不能覆盖");
      const latest = (await read(id))!;
      if (digest(latest.source) !== digest(current)) throw new ServiceConnectionError("stale", "来源已变化");
      const next = { ...latest.source, enabled, enabledOverride: enabled, configRevision: latest.source.configRevision + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: latest.revision }]);
      return view(next, actor);
    },
    async addProtocol(actor: ServiceConnectionActor, id: string, expected: ServiceConnectionVersion, endpoint: ServiceConnectionView["endpoints"][number], models: readonly string[]) {
      requireActor(actor);
      const found = await read(id);
      if (!found || !mayWrite(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权管理来源");
      const source = await refresh(actor, found.source);
      if (source.removed || source.kind !== "api" || source.locked || source.configRevision !== expected.configRevision || source.credentialEpoch !== expected.credentialEpoch) throw new ServiceConnectionError("stale", "来源已变化或不可编辑");
      if (endpoint.protocol.startsWith("provider:") || models.length === 0 || models.some(model => !model.trim())) throw new ServiceConnectionError("invalid", "协议或模型无效");
      if (source.origin && source.endpoints.some(item => item.protocol === endpoint.protocol) && !source.extraEndpoints?.some(item => item.protocol === endpoint.protocol)) throw new ServiceConnectionError("invalid", "原有协议请在来源主表单修改，不能创建第二份配置");
      const endpoints = [...source.endpoints.filter(item => item.protocol !== endpoint.protocol), endpoint];
      assertEndpoints(endpoints);
      const binding: ServiceConsumerBinding = { bindingId: `protocol:${id}:${endpoint.protocol}`, extensionId: "sdk-agent", consumer: "agent", consumerId: `shared:${endpoint.protocol}`, purposes: ["text"], modelKeys: models };
      const capabilities = models.map(modelId => ({ purpose: "text" as const, protocol: endpoint.protocol, modelId, imageInput: false, evidence: "adapter" as const }));
      const candidate: Source = { ...source, capabilities: [...source.capabilities, ...capabilities] };
      if (!bindingAllowed(binding, candidate, actor)) throw new ServiceConnectionError("forbidden", "协议适配器未启用");
      const latest = (await read(id))!;
      if (digest(latest.source) !== digest(source)) throw new ServiceConnectionError("stale", "来源已变化");
      const next: Source = { ...source, endpoints, extraEndpoints: [...(source.extraEndpoints ?? []).filter(item => item.protocol !== endpoint.protocol), endpoint],
        capabilities: [...source.capabilities.filter(item => item.protocol !== endpoint.protocol), ...capabilities], extraCapabilities: [...(source.extraCapabilities ?? []).filter(item => item.protocol !== endpoint.protocol), ...capabilities],
        bindings: [...source.bindings.filter(item => item.bindingId !== binding.bindingId), binding], extraBindings: [...(source.extraBindings ?? []).filter(item => item.bindingId !== binding.bindingId), binding], configRevision: source.configRevision + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: latest.revision }]);
      return view(next, actor);
    },
    async unbind(actor: ServiceConnectionActor, id: string, bindingId: string, expected: ServiceConnectionVersion) {
      requireActor(actor);
      const found = await read(id);
      if (!found || !mayWrite(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权管理绑定");
      const current = await refresh(actor, found.source);
      if (current.configRevision !== expected.configRevision || current.credentialEpoch !== expected.credentialEpoch || current.removed) throw new ServiceConnectionError("stale", "来源已变化");
      if (!(found.source.extraBindings ?? []).some(binding => binding.bindingId === bindingId)) throw new ServiceConnectionError("invalid", "原始消费绑定由来源适配器管理");
      const next = { ...found.source, bindings: found.source.bindings.filter(binding => binding.bindingId !== bindingId), extraBindings: (found.source.extraBindings ?? []).filter(binding => binding.bindingId !== bindingId), configRevision: found.source.configRevision + 1 };
      await write([{ op: "set", key: sourceKey(id), value: json(next), expectedRevision: found.revision }]);
      return view(next, actor);
    },
    /** Called only with an extension identity fixed by the host, and a frozen consumer binding. */
    async resolve(actor: ServiceConnectionActor, extensionId: string, input: ServiceConnectionVersion & { serviceConnectionId: string; bindingId: string; purpose: ServiceConnectionPurpose; protocol: string; modelId: string; endpoint: string }) {
      requireActor(actor);
      const found = await read(input.serviceConnectionId);
      if (!found || !mayRead(actor, found.source)) throw new ServiceConnectionError("forbidden", "无权使用来源");
      const source = await refresh(actor, found.source);
      const binding = source.bindings.find(item => item.bindingId === input.bindingId && item.extensionId === extensionId && item.purposes.includes(input.purpose)
        && item.modelKeys.some(key => key === input.modelId || key === `${item.consumerId}:${input.modelId}`));
      if (!binding || !bindingAllowed(binding, source, actor)) throw new ServiceConnectionError("forbidden", "未获准的消费绑定");
      const consumer = consumers.get(extensionId);
      if (consumer && (!consumer.protocols.includes(input.protocol) || !consumer.purposes.includes(input.purpose))) throw new ServiceConnectionError("forbidden", "消费适配器未提供此协议或用途");
      if (source.scope === "site" && !actor.canUseSite) throw new ServiceConnectionError("forbidden", "未获站点使用权限");
      if (!source.enabled || source.removed || source.configRevision !== input.configRevision || source.credentialEpoch !== input.credentialEpoch) throw new ServiceConnectionError("stale", "来源已停用或代次失效");
      if (!source.endpoints.some(item => item.protocol === input.protocol && item.baseUrl === input.endpoint) || !options.checkEndpoint(input.endpoint)) throw new ServiceConnectionError("forbidden", "目标地址未获准");
      if (!source.capabilities.some(item => item.purpose === input.purpose && item.protocol === input.protocol && item.modelId === input.modelId)) throw new ServiceConnectionError("forbidden", "缺少对应模型能力证据");
      if (source.origin) {
        const registered = adapters.get(adapterKey(source.origin.extensionId, source.origin.adapterId));
        if (!registered?.adapter.readSecret) throw new ServiceConnectionError("unavailable", "此来源不提供 API Key");
        const secret = await registered.adapter.readSecret(actor.owner, source.origin.legacyId, source.origin.version);
        const current = await refresh(actor, source);
        if (current.configRevision !== source.configRevision || current.credentialEpoch !== source.credentialEpoch || !current.enabled || current.removed) throw new ServiceConnectionError("stale", "读取凭据期间来源已变化");
        if (!secret) throw new ServiceConnectionError("unavailable", "来源凭据不可用");
        return { secret, endpoint: input.endpoint, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch };
      }
      // All authorization and destination checks precede the only secret read.
      const credential = source.credentialKey && secrets?.read<{ secret: string }>(secretOwner(source), source.credentialKey);
      if (!credential) throw new ServiceConnectionError("unavailable", "来源凭据不可用");
      return { secret: credential.value.secret, endpoint: input.endpoint, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch };
    },
  };
  return registry;
}
export type ServiceConnectionRegistry = ReturnType<typeof createServiceConnectionRegistry>;
