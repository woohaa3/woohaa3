/**
 * Agent 会话来源连接绑定/复用/切换与旧数据兼容测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.2/2.3 / design D7/D8）。
 *
 * 覆盖与渲染无关的权威行为：
 * - 显式连接经注册表校验归属；跨 owner/未知连接拒绝，不静默降级；
 * - 回合冻结连接身份（含 configRevision/credentialEpoch）并纳入 requestId 幂等指纹；
 * - 同 requestId 换连接/配置/凭据版本拒绝；原 request 查询不重跑；
 * - 同节点同连接复用、显式切换归档旧会话保留历史、活动回合阻止切换/清空；
 * - 旧库（无连接列）打开即迁移、原历史可读且不绑定新 SDK。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentConnectionStatus,
  AgentConnectionView,
  AgentConversationAdapter
} from "@woohaa3/contracts";
import { createSqliteAgentConversationStore as openConversationStore } from "../repository/agent-conversation-repository.js";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createAgentConversationService } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";

const dirs: string[] = [];
const stores: ReturnType<typeof openConversationStore>[] = [];
function createSqliteAgentConversationStore(options: Parameters<typeof openConversationStore>[0]) {
  const store = openConversationStore(options); stores.push(store); return store;
}
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-agent-conn-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ready: AgentConnectionStatus = {
  transport: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  credential: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  modelAccess: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  tools: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" }
};

function conn(overrides: { connectionId: string; adapterId: string; extensionId: string; configRevision?: number; credentialEpoch?: number }): AgentConnectionView {
  return {
    name: overrides.connectionId,
    runCategory: "http-sdk",
    authMode: "api-key",
    status: ready,
    ready: true,
    capabilities: { discussion: true, imageInput: false, tools: true, structuredResult: true, cancel: true, resume: false },
    models: [],
    credentialConfigured: true,
    configRevision: overrides.configRevision ?? 1,
    credentialEpoch: overrides.credentialEpoch ?? 0,
    ...overrides
  };
}

/** 最小连接注册表桩：只实现服务用到的 `getConnection`（按 owner 校验）。 */
function connectionRegistry(byOwner: Record<string, AgentConnectionView[]>): AgentConnectionRegistry {
  return {
    list: () => [],
    resolve: () => ({ ok: false as const, code: "adapter-unavailable" as const, message: "stub" }),
    listConnections: async ({ owner }) => byOwner[owner] ?? [],
    getConnection: async ({ owner, connectionId }) => (byOwner[owner] ?? []).find((entry) => entry.connectionId === connectionId) ?? null
  } as AgentConnectionRegistry;
}

type Controls = { seen: AgentAdapterRunInput[]; outcomes: AgentAdapterRunOutcome[]; pending: Array<(outcome: AgentAdapterRunOutcome) => void> };

function fakeAdapter(controls: Controls): AgentConversationAdapter {
  return {
    id: "fake",
    capabilities: () => ({ discussion: true, targets: ["model3d", "camera"], tools: true, models: "remote" }),
    authorization: async () => "ready",
    models: async () => ({ models: [] }),
    async run(input) {
      controls.seen.push(input);
      const fixed = controls.outcomes.shift();
      if (fixed) return fixed;
      return await new Promise<AgentAdapterRunOutcome>((resolve) => controls.pending.push(resolve));
    },
    async query() {
      return null;
    },
    async cancel() {
      /* fake */
    }
  };
}

function setup(options: { byOwner?: Record<string, AgentConnectionView[]>; defaultConnectionFor?: (input: { owner: string; adapterId: string }) => AgentConnectionView | null } = {}) {
  const controls: Controls = { seen: [], outcomes: [], pending: [] };
  const registry = createAgentAdapterRegistry({
    hasCapability: (id) => id === "agent-conversation-adapter:fake",
    resolveCapabilityOwner: (id) => (id === "agent-conversation-adapter:fake" ? { extensionId: "fake-ext", configVersion: 1, mode: "public" } : null),
    resolveCapability: (id) => (id === "agent-conversation-adapter:fake" ? fakeAdapter(controls) : undefined),
    snapshot: () => [{ extensionId: "fake-ext", capabilities: ["agent-conversation-adapter:fake"] }]
  });
  const storePath = path.join(tempDir(), "agents.sqlite");
  const store = createSqliteAgentConversationStore({ path: storePath });
  const service = createAgentConversationService({
    store,
    registry,
    ...(options.byOwner ? { connections: connectionRegistry(options.byOwner) } : {}),
    ...(options.defaultConnectionFor ? { defaultConnectionFor: options.defaultConnectionFor } : {}),
    now: () => "2026-10-16T00:00:00.000Z",
    createId: (() => {
      let n = 0;
      return (prefix: string) => `${prefix}-${++n}`;
    })()
  });
  return { controls, store, storePath, registry, service };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  action: "discuss" as const,
  canvasId: "canvas-1",
  prompt: "你好",
  ...overrides
});

describe("来源连接解析与冻结（任务 2.2）", () => {
  it("显式连接经注册表校验归属并冻结 configRevision/credentialEpoch", async () => {
    const { controls, service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "fake", extensionId: "sdk-agent", configRevision: 3, credentialEpoch: 5 })] } });
    const resolved = await service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake", connectionId: "c1" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.binding).toEqual({ connectionId: "c1", adapterId: "fake", configRevision: 3, credentialEpoch: 5 });

    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    controls.outcomes.push({ status: "succeeded", assistantText: "ok", receipt: { commandId: "simulated-command" } });
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-1", entry: entry(), connection: resolved.binding });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.turn.connection).toEqual({ connectionId: "c1", adapterId: "fake", configRevision: 3, credentialEpoch: 5 });
    // adapter 收到的本回合输入携带冻结连接。
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);
    expect(controls.seen[0]?.connection).toEqual({ connectionId: "c1", adapterId: "fake", configRevision: 3, credentialEpoch: 5 });
  });

  it("未知连接或跨 owner 连接返回 connection-unavailable（不静默降级）", async () => {
    const { service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "fake", extensionId: "sdk-agent" })] } });
    const unknown = await service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake", connectionId: "nope" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("connection-unavailable");
    const foreign = await service.resolveConnectionBinding({ owner: "user-b", adapterId: "fake", connectionId: "c1" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("connection-unavailable");
  });

  it("连接 adapter 与会话来源不一致时拒绝", async () => {
    const { service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "other", extensionId: "sdk-agent" })] } });
    const resolved = await service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake", connectionId: "c1" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe("connection-unavailable");
  });

  it("未显式选择时映射兼容默认连接；缺省不伪造连接身份", async () => {
    const withDefault = setup({ defaultConnectionFor: () => conn({ connectionId: "legacy", adapterId: "fake", extensionId: "chatgpt" }) });
    const resolved = await withDefault.service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.binding?.connectionId).toBe("legacy");

    const without = setup();
    const none = await without.service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake" });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.binding).toBeNull();
  });

  it("同 requestId 换连接/配置/凭据版本拒绝为原请求执行，原请求不重跑", async () => {
    const { controls, service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "fake", extensionId: "sdk-agent", configRevision: 1, credentialEpoch: 0 }), conn({ connectionId: "c2", adapterId: "fake", extensionId: "sdk-agent", configRevision: 1, credentialEpoch: 0 })] } });
    controls.outcomes.push({ status: "succeeded", assistantText: "一次" });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const convId = created.conversation.conversationId;
    const first = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry(), connection: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } });
    if (!first.ok) throw new Error("accept failed");
    await service.dispatchTurn(first.turn.turnId);
    await service.whenSettled(first.turn.turnId);
    expect(controls.seen).toHaveLength(1);

    // 相同身份相同连接：复用原运行，不再推理。
    const reuse = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry(), connection: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } });
    expect(reuse.ok).toBe(true);
    if (reuse.ok) expect(reuse.reused).toBe(true);
    expect(controls.seen).toHaveLength(1);

    // 换连接 / 换配置版本 / 换凭据 epoch：都视为不同身份，拒绝为原请求执行。
    for (const connection of [
      { connectionId: "c2", adapterId: "fake", configRevision: 1, credentialEpoch: 0 },
      { connectionId: "c1", adapterId: "fake", configRevision: 2, credentialEpoch: 0 },
      { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 1 }
    ]) {
      const conflict = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry(), connection });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("request-id-reused");
    }
    expect(controls.seen).toHaveLength(1);
  });

  it("已冻结连接来源的会话拒绝改用其它连接（不静默换来源）", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", connectionId: "c1" });
    if (!created.ok) throw new Error("create failed");
    const conflict = service.acceptTurn({
      owner: "user-a",
      conversationId: created.conversation.conversationId,
      requestId: "req-1",
      entry: entry(),
      connection: { connectionId: "c2", adapterId: "fake", configRevision: 1, credentialEpoch: 0 }
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("connection-unavailable");
  });
});

describe("来源复用、切换与清空（任务 2.3 / design D8）", () => {
  it("同节点同连接复用同一条会话，不同连接互不命中", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c1" });
    if (!created.ok) throw new Error("create failed");
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c1" }).conversation?.conversationId).toBe(created.conversation.conversationId);
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c2" }).conversation).toBeNull();
    // 不带连接筛选仍返回该节点当前会话（保持既有行为）。
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" }).conversation?.conversationId).toBe(created.conversation.conversationId);
  });

  it("显式切换连接归档旧会话并保留历史；下一次提交建立新来源会话", async () => {
    const { controls, service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "fake", extensionId: "sdk-agent" }), conn({ connectionId: "c2", adapterId: "fake", extensionId: "sdk-agent" })] } });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c1" });
    if (!created.ok) throw new Error("create failed");
    const oldConv = created.conversation.conversationId;
    controls.outcomes.push({ status: "succeeded", assistantText: "ok", receipt: { commandId: "simulated-command" } });
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: oldConv, requestId: "req-1", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d", model: "m" }), connection: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } });
    if (!accepted.ok) throw new Error("accept failed");
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);

    const switched = await service.switchConnection({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c2" });
    expect(switched).toEqual({ ok: true, cleared: 1 });
    // 旧会话解除目标关联，但历史仍可按 id 读取。
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" }).conversation).toBeNull();
    const read = service.readConversation({ owner: "user-a", conversationId: oldConv });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.snapshot.messages.some((message) => message.role === "user")).toBe(true);

    // 新来源会话独立建立，不复用旧原生会话。
    const fresh = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c2" });
    if (!fresh.ok) throw new Error("create failed");
    expect(fresh.conversation.conversationId).not.toBe(oldConv);
  });

  it("切换连接校验归属：跨 owner/未知连接拒绝", async () => {
    const { service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c1", adapterId: "fake", extensionId: "sdk-agent" })] } });
    const foreign = await service.switchConnection({ owner: "user-b", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c1" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("connection-unavailable");
    const unknown = await service.switchConnection({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "nope" });
    expect(unknown.ok).toBe(false);
  });

  it("活动回合不阻止清空与切换，且不删除未核对回合", async () => {
    const { service } = setup({ byOwner: { "user-a": [conn({ connectionId: "c2", adapterId: "fake", extensionId: "sdk-agent" })] } });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-1", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d", model: "m" }) });
    if (!accepted.ok) throw new Error("accept failed");

    // change: 2026-10-22-remove-agent-execution-limits，任务 3.2 / design D3：清空/切换只解除
    // 目标关联（归档会话），不因活动回合被拒绝，也不删除回合、消息与回执。
    const cleared = service.clearContext({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(cleared).toMatchObject({ ok: true });
    expect(service.queryTurn({ owner: "user-a", requestId: "req-1" })).toMatchObject({ ok: true, turn: { status: "queued" } });
    const switched = await service.switchConnection({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1", connectionId: "c2" });
    expect(switched.ok).toBe(true);
    expect(service.queryTurn({ owner: "user-a", requestId: "req-1" })).toMatchObject({ ok: true, turn: { status: "queued" } });
  });
});

describe("旧数据兼容（任务 2.2）", () => {
  it("旧库（无连接列）打开即迁移，旧会话可读且不绑定新 SDK", async () => {
    const dbPath = path.join(tempDir(), "legacy-conn.sqlite");
    const raw = new (loadNodeSqlite().DatabaseSync)(dbPath);
    raw.exec(`CREATE TABLE agent_conversations (
      conversation_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      latest_request_id TEXT,
      node_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    raw.prepare(
      "INSERT INTO agent_conversations (conversation_id, owner, canvas_id, adapter_id, title, status, latest_request_id, node_id, turn_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("legacy-1", "user-a", "canvas-1", "fake", "旧会话", "idle", null, "node-1", 0, "2026-10-16T00:00:00.000Z", "2026-10-16T00:00:00.000Z");
    raw.close();

    const store = createSqliteAgentConversationStore({ path: dbPath });
    // 旧记录连接为空；读取映射兼容默认连接由服务层处理。
    expect(store.getConversation("legacy-1")?.connectionId).toBeNull();

    // 服务以兼容默认连接解析旧会话，历史保持可读、请求身份不变。
    const registry = createAgentAdapterRegistry({
      hasCapability: (id) => id === "agent-conversation-adapter:fake",
      resolveCapabilityOwner: (id) => (id === "agent-conversation-adapter:fake" ? { extensionId: "fake-ext", configVersion: 1, mode: "public" } : null),
      resolveCapability: (id) => (id === "agent-conversation-adapter:fake" ? fakeAdapter({ seen: [], outcomes: [{ status: "succeeded", assistantText: "ok" }], pending: [] }) : undefined),
      snapshot: () => [{ extensionId: "fake-ext", capabilities: ["agent-conversation-adapter:fake"] }]
    });
    const service = createAgentConversationService({
      store,
      registry,
      connections: connectionRegistry({ "user-a": [conn({ connectionId: "legacy", adapterId: "fake", extensionId: "chatgpt" })] }),
      defaultConnectionFor: () => conn({ connectionId: "legacy", adapterId: "fake", extensionId: "chatgpt" }),
      now: () => "2026-10-16T00:00:00.000Z"
    });
    // 直接以默认连接解析旧会话来源。
    const binding = await service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake" });
    expect(binding.ok).toBe(true);
    if (binding.ok) expect(binding.binding?.connectionId).toBe("legacy");
    const read = service.readConversation({ owner: "user-a", conversationId: "legacy-1" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.snapshot.conversation.connectionId).toBeUndefined();
  });
});


describe("运行引擎升级会话屏障", () => {
  for (const status of ["succeeded", "failed"] as const) it(`拒绝排队回合，结算为 ${status} 后归档`, async () => {
    const { service, store, controls } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node", connectionId: "c1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "migration-request", entry: entry(), connection: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } });
    if (!accepted.ok) throw new Error("accept failed");
    expect(store.prepareConnectionMigration?.("user-a", "c1")).toBe(false);
    expect(store.prepareConnectionMigration?.("other-owner", "c1")).toBe(true);
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node" }).conversation).not.toBeNull();
    controls.outcomes.push({ status, assistantText: "reply" });
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);
    expect(store.prepareConnectionMigration?.("user-a", "c1")).toBe(true);
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node" }).conversation === null).toBe(true);
    expect(service.queryTurn({ owner: "user-a", requestId: "migration-request" }).ok).toBe(true);
    expect(controls.seen).toHaveLength(1);
    expect(store.prepareConnectionMigration?.("user-a", "c1")).toBe(true);
  });
});


it("升级归档后重启仍保留原请求、回复和作品命令回执，不重新推理", async () => {
  const { service, store, storePath, registry, controls } = setup();
  const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node", connectionId: "c1" });
  if (!created.ok) throw new Error("create failed");
  const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "retained-request", entry: entry({ action: "modify", nodeId: "node" }), connection: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } });
  if (!accepted.ok) throw new Error("accept failed");
  controls.outcomes.push({ status: "succeeded", assistantText: "作品完成", receipt: { kind: "canvas-commands", commands: [{ canvasId: "canvas-1", nodeId: "node", commandId: "preserved-command" }] } });
  await service.dispatchTurn(accepted.turn.turnId); await service.whenSettled(accepted.turn.turnId);
  const before = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
  if (!before.ok) throw new Error("read failed");
  expect(store.prepareConnectionMigration("user-a", "c1")).toBe(true);
  store.close();
  const reopened = createSqliteAgentConversationStore({ path: storePath });
  try {
    const restarted = createAgentConversationService({ store: reopened, registry });
    const after = restarted.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!after.ok) throw new Error("restart read failed");
    expect(after.snapshot.turns).toEqual(before.snapshot.turns);
    expect(after.snapshot.messages).toEqual(before.snapshot.messages);
    expect(after.snapshot.conversation.nodeId).toBeUndefined();
    expect(restarted.queryTurn({ owner: "user-a", requestId: "retained-request" }).ok).toBe(true);
    expect(controls.seen).toHaveLength(1);
    expect(restarted.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "new-write", entry: entry({ action: "modify", nodeId: "node" }) }).ok).toBe(false);
  } finally { reopened.close(); }
});

it("旧 OAuth 历史只按可信 owner 解析唯一默认连接，原请求身份不改写", async () => {
  const oauth = { ...conn({ connectionId: "owner-account", adapterId: "fake", extensionId: "oauth-agent" }), authMode: "oauth" as const };
  const { service, controls } = setup({ byOwner: { "user-a": [oauth] } });
  const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
  if (!created.ok) throw new Error("create failed");
  const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "legacy-oauth-request", entry: entry() });
  if (!accepted.ok) throw new Error("accept failed");
  controls.outcomes.push({ status: "succeeded", assistantText: "historical reply" });
  await service.dispatchTurn(accepted.turn.turnId); await service.whenSettled(accepted.turn.turnId);
  expect(await service.resolveConnectionBinding({ owner: "user-a", adapterId: "fake" })).toMatchObject({ ok: true, binding: { connectionId: "owner-account" } });
  expect(await service.resolveConnectionBinding({ owner: "user-b", adapterId: "fake" })).toEqual({ ok: true, binding: null });
  expect(service.readConversation({ owner: "user-b", conversationId: created.conversation.conversationId }).ok).toBe(false);
  const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
  if (!read.ok) throw new Error("read failed");
  expect(read.snapshot.conversation.connectionId).toBeUndefined();
  expect(read.snapshot.turns[0]?.requestId).toBe("legacy-oauth-request");
  expect(service.queryTurn({ owner: "user-a", requestId: "legacy-oauth-request" }).ok).toBe(true);
  expect(controls.seen).toHaveLength(1);
});
