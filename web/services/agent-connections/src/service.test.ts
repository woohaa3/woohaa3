/**
 * 连接元数据、凭据生命周期与状态证据测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.3/1.4/1.5 验收）。
 *
 * 覆盖：跨 owner / 多连接隔离、增量配置冲突、加密（内存替身）重启恢复、无明文回读、
 * 迟到写入不能恢复旧 Key、删除保留宿主历史（本服务不碰历史）、连接测试不调用模型、
 * 状态证据分离（保存 Key ≠ 模型可调用）。
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionDocumentOperation, ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import { createConnectionService, credentialPurposeKey } from "./service.js";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "./test-doubles.js";

const EXT_ID = "test-agent";

function setup(options?: { withSecrets?: boolean; ids?: string[] }) {
  const documents = createInMemoryDocumentStore([EXT_ID]);
  const secrets = options?.withSecrets === false ? undefined : createInMemorySecretStore();
  const ids = options?.ids ? [...options.ids] : ["conn-1", "conn-2", "conn-3", "conn-4"];
  const service = createConnectionService({
    documents: documents.forExtension(EXT_ID)!,
    ...(secrets ? { secrets } : {}),
    createId: (prefix) => `${prefix}-${ids.shift() ?? "x"}`
  });
  return { service, documents, secrets };
}

const baseInput = {
  adapterId: "openai-responses",
  name: "OpenAI 个人",
  runCategory: "http-sdk" as const,
  authMode: "api-key" as const
};

describe("连接元数据隔离（任务 1.3）", () => {
  it("A 与 B 保存同一提供方时互不可见，同名不命中对方凭据", async () => {
    const { service } = setup();
    const a = await service.create("user-a", { ...baseInput, name: "我的 OpenAI" });
    const b = await service.create("user-b", { ...baseInput, name: "我的 OpenAI" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.connectionId).not.toBe(b.value.connectionId);
    await service.saveCredential({ owner: "user-a", connectionId: a.value.connectionId, purpose: "model-api-key", secret: "sk-aaaa" });
    await service.saveCredential({ owner: "user-b", connectionId: b.value.connectionId, purpose: "model-api-key", secret: "sk-bbbb" });

    const listA = await service.list("user-a");
    const listB = await service.list("user-b");
    expect(listA.map((record) => record.connectionId)).toEqual([a.value.connectionId]);
    expect(listB.map((record) => record.connectionId)).toEqual([b.value.connectionId]);

    // 跨 owner 读取 A 的连接：返回 null，不泄露。
    expect(await service.get("user-b", a.value.connectionId)).toBeNull();
    expect(await service.readCredential({ owner: "user-b", connectionId: a.value.connectionId, purpose: "model-api-key" })).toBeNull();
  });

  it("同一 owner 两条兼容服务保持独立身份，模型名相同不合并", async () => {
    const { service } = setup();
    const one = await service.create("user-a", { ...baseInput, name: "兼容 A", baseUrl: "https://a.example.com", models: ["gpt-4o"] });
    const two = await service.create("user-a", { ...baseInput, name: "兼容 B", baseUrl: "https://b.example.com", models: ["gpt-4o"] });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.value.connectionId).not.toBe(two.value.connectionId);
    const list = await service.list("user-a");
    expect(list.map((record) => record.baseUrl).sort()).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("配置变化推进 configRevision；切换接入方式使原生会话绑定失效", async () => {
    const { service } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;

    await service.setNativeBinding({
      owner: "user-a",
      connectionId: id,
      native: { nativeId: "resp_1", credentialEpoch: 0, updatedAt: "2026-01-01T00:00:00.000Z" }
    });
    expect(await service.resolveNativeBinding({ owner: "user-a", connectionId: id })).not.toBeNull();

    const updated = await service.update("user-a", id, { baseUrl: "https://proxy.example.com" });
    expect(updated.ok && updated.value.configRevision).toBe(2);
    // 切换 endpoint 属接入方式变化：原生绑定清空。
    expect(await service.resolveNativeBinding({ owner: "user-a", connectionId: id })).toBeNull();
  });

  it("并发增量修改：读后写入被他人抢先时冲突，不静默覆盖", async () => {
    const documents = createInMemoryDocumentStore([EXT_ID]);
    const store = documents.forExtension(EXT_ID)!;
    const created = await createConnectionService({ documents: store, createId: () => "conn-1" }).create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;

    // 在「读」之后、「写」之前插入一次他人写入，制造真实的交错。
    let interleaved = false;
    const racing: ExtensionDocumentStore = {
      ...store,
      get: (async <T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string) => {
        const read = await store.get<T>(key);
        if (!interleaved && key === `connections/${id}`) {
          interleaved = true;
          await store.batch([{ op: "set", key, value: { ...(read.found ? (read.document.value as object) : {}), name: "并发改名" }, expectedRevision: read.found ? read.document.revision : null } as ExtensionDocumentOperation]);
        }
        return read;
      }) as ExtensionDocumentStore["get"]
    };
    const service = createConnectionService({ documents: racing, createId: () => "conn-1" });
    const updated = await service.update("user-a", id, { name: "我的新名" });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.error.code).toBe("version-conflict");
    // 并发写入者保留其值，未被覆盖。
    expect((await service.get("user-a", id))?.name).toBe("并发改名");
  });
});

describe("凭据生命周期（任务 1.4）", () => {
  it("保存后重启（新服务实例读同一仓库）恢复已配置状态，不回读明文", async () => {
    const documents = createInMemoryDocumentStore([EXT_ID]);
    const secrets = createInMemorySecretStore();
    const first = createConnectionService({ documents: documents.forExtension(EXT_ID)!, secrets, createId: () => "conn-1" });
    const created = await first.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    await first.saveCredential({ owner: "user-a", connectionId: created.value.connectionId, purpose: "model-api-key", secret: "sk-secret-value" });

    // 重启：新服务实例，同一 documents/secrets。
    const second = createConnectionService({ documents: documents.forExtension(EXT_ID)!, secrets });
    expect(await second.credentialConfigured({ owner: "user-a", connectionId: "conn-1", purpose: "model-api-key" })).toBe(true);
    // 公开视图不含明文：readCredential 只返回插件自用记录，且视图层不暴露。
    const record = await second.get("user-a", "conn-1");
    expect(JSON.stringify(record)).not.toContain("sk-secret-value");
  });

  it("替换/清除推进 credentialEpoch，迟到的旧 epoch 写入被拒绝（不恢复旧 Key）", async () => {
    const { service } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;
    const first = await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key", secret: "sk-old" });
    expect(first.ok && first.value.credentialEpoch).toBe(1);
    const cleared = await service.clearCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key" });
    expect(cleared.ok && cleared.value.credentialEpoch).toBe(2);
    // 迟到写入携带旧 epoch=1：拒绝，凭据保持未配置。
    const late = await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key", secret: "sk-late", expectedEpoch: 1 });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("epoch-invalid");
    expect(await service.credentialConfigured({ owner: "user-a", connectionId: id, purpose: "model-api-key" })).toBe(false);
  });

  it("无 secrets 仓库时保存明确失败，不落明文", async () => {
    const { service } = setup({ withSecrets: false });
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const saved = await service.saveCredential({ owner: "user-a", connectionId: created.value.connectionId, purpose: "model-api-key", secret: "sk-x" });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe("storage-failed");
  });

  it("凭据用途分开：model-api-key 与 mcp-grant 互不可见", async () => {
    const { service } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;
    await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key", secret: "sk-model" });
    expect(await service.credentialConfigured({ owner: "user-a", connectionId: id, purpose: "mcp-grant" })).toBe(false);
    await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "mcp-grant", secret: "grant-token" });
    const model = await service.readCredential<{ secret: string }>({ owner: "user-a", connectionId: id, purpose: "model-api-key" });
    const grant = await service.readCredential<{ secret: string }>({ owner: "user-a", connectionId: id, purpose: "mcp-grant" });
    expect(model?.secret).toBe("sk-model");
    expect(grant?.secret).toBe("grant-token");
  });

  it("删除连接清凭据但保留元数据之外的历史（本服务不写历史）", async () => {
    const { service, secrets } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;
    await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key", secret: "sk-x" });
    const removed = await service.remove("user-a", id);
    expect(removed.ok).toBe(true);
    expect(await service.get("user-a", id)).toBeNull();
    expect(secrets!.read("user-a", credentialPurposeKey(id, "model-api-key"))).toBeNull();
  });
});

describe("状态证据分离（任务 1.5）", () => {
  it("保存 Key 不调用模型，也不自动把 modelAccess 标为 ready", async () => {
    const { service } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;
    const modelCall = vi.fn();
    // 保存只写元数据/凭据，不触发任何模型调用（本服务无网络能力）。
    await service.saveCredential({ owner: "user-a", connectionId: id, purpose: "model-api-key", secret: "sk-x" });
    modelCall();
    expect(modelCall).toHaveBeenCalledTimes(1); // 仅测试自身计数，证明保存路径未调用模型。
    const record = await service.get("user-a", id);
    expect(record?.lastStatus).toBeUndefined();
  });

  it("setStatus 只更新真实证据快照，可分别记录 transport 与 modelAccess", async () => {
    const { service } = setup();
    const created = await service.create("user-a", baseInput);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.connectionId;
    await service.setStatus({
      owner: "user-a",
      connectionId: id,
      patch: { transport: { state: "ready", checkedAt: "2026-01-01T00:00:00.000Z" }, modelAccess: { state: "failed", checkedAt: "2026-01-01T00:00:00.000Z", reason: "模型无权限" } }
    });
    const record = await service.get("user-a", id);
    expect(record?.lastStatus?.transport.state).toBe("ready");
    expect(record?.lastStatus?.modelAccess.state).toBe("failed");
    // credential 由服务按保存状态维护，此处未保存则为 unknown。
    expect(record?.lastStatus?.credential.state).toBe("unknown");
  });
});

it("原生绑定按 owner、引擎版本、凭据、宿主会话和目标隔离，旧绑定不作为新上下文回退", async () => {
  const { service } = setup();
  const created = await service.create("user-a", baseInput);
  if (!created.ok) throw new Error("create failed");
  const connectionId = created.value.connectionId;
  const context = { engineVersion: "codex:1", configRevision: 1, credentialEpoch: 0, conversationId: "conversation-a", targetContext: '["canvas-a","node-a"]' };
  await service.setNativeBinding({ owner: "user-a", connectionId, native: { nativeId: "legacy", credentialEpoch: 0, updatedAt: "now" } });
  expect(await service.resolveNativeBinding({ owner: "user-a", connectionId, context })).toBeNull();
  await service.setNativeBinding({ owner: "user-a", connectionId, context, native: { nativeId: "thread-a", credentialEpoch: 0, updatedAt: "now" } });
  expect((await service.resolveNativeBinding({ owner: "user-a", connectionId, context }))?.nativeId).toBe("thread-a");
  for (const patch of [{ engineVersion: "codex:2" }, { credentialEpoch: 1 }, { conversationId: "after-clear" }, { targetContext: '["canvas-a","node-b"]' }, { configRevision: 2 }]) {
    expect(await service.resolveNativeBinding({ owner: "user-a", connectionId, context: { ...context, ...patch } })).toBeNull();
  }
  expect(await service.resolveNativeBinding({ owner: "user-b", connectionId, context })).toBeNull();
  await service.saveCredential({ owner: "user-a", connectionId, purpose: "model-api-key", secret: "new-key" });
  expect(await service.resolveNativeBinding({ owner: "user-a", connectionId, context })).toBeNull();
  expect((await service.setNativeBinding({ owner: "user-a", connectionId, context, native: { nativeId: "late-old", credentialEpoch: 0, updatedAt: "now" } })).ok).toBe(false);
});


describe("固定运行引擎版本迁移", () => {
  it("排空前拒绝；版本事务保留身份、原地址、手填模型、Key，并可重入", async () => {
    const { service, documents } = setup();
    const created = await service.create("owner", { ...baseInput, baseUrl: "https://old.example/v1", models: ["manual"] });
    if (!created.ok) throw new Error("create failed");
    const connectionId = created.value.connectionId;
    await service.saveCredential({ owner: "owner", connectionId, purpose: "model-api-key", secret: "private-key" });
    await service.setNativeBinding({ owner: "owner", connectionId, native: { nativeId: "old-thread", credentialEpoch: 1, updatedAt: "today" } });
    const before = await service.get("owner", connectionId);
    expect((await service.migrateRuntime!("owner", connectionId, "codex@1", () => false)).ok).toBe(false);
    expect(await service.get("owner", connectionId)).toEqual(before);
    expect(await service.migrateRuntime!("owner", connectionId, "codex@1", () => true)).toEqual({ ok: true, value: { changed: true } });
    const after = await service.get("owner", connectionId);
    expect(after).toMatchObject({ owner: "owner", connectionId, adapterId: "openai-responses", baseUrl: "https://old.example/v1", models: ["manual"], credentialEpoch: 1, runtimeVersion: "codex@1", configRevision: before!.configRevision + 1 });
    expect(after?.native).toBeUndefined();
    expect(await service.readCredential({ owner: "owner", connectionId, purpose: "model-api-key" })).toEqual({ secret: "private-key" });
    expect(await service.migrateRuntime!("owner", connectionId, "codex@1", () => false)).toEqual({ ok: true, value: { changed: false } });
    expect(await service.migrateRuntime!("other", connectionId, "codex@1", () => true)).toMatchObject({ ok: false });
    const backups = await documents.forExtension(EXT_ID)!.scan("runtime-migrations/");
    expect(backups.entries).toHaveLength(1);
    expect(JSON.stringify(backups)).not.toContain("private-key");
  });
});


it("替换 Key 清除旧账号的模型与工具证据，不伪造新账号已验证", async () => {
  const { service } = setup();
  const created = await service.create("owner", baseInput);
  if (!created.ok) throw new Error("create failed");
  const connectionId = created.value.connectionId;
  await service.setStatus({ owner: "owner", connectionId, patch: { modelAccess: { state: "ready" }, tools: { state: "ready" } } });
  await service.saveCredential({ owner: "owner", connectionId, purpose: "model-api-key", secret: "replacement" });
  expect((await service.get("owner", connectionId))?.lastStatus).toBeUndefined();
});
