/**
 * 会话层的 Agent 角色边界（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 用真实 SQLite 会话账本与 fake adapter 覆盖：显式角色解析、准备零推理、冻结身份、
 * 重传不重算、required 缺失拒绝、停用后历史可查。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentConversationAdapter,
  AgentRoleImplementation
} from "@woohaa3/contracts";
import { createSqliteAgentConversationStore as openConversationStore } from "../repository/agent-conversation-repository.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createAgentConversationService } from "./agent-conversation-service.js";
import { createAgentRoleRegistry } from "../agent-roles/registry.js";

const dirs: string[] = [];
const stores: ReturnType<typeof openConversationStore>[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-agent-roles-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* ignore */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function role(overrides: Partial<AgentRoleImplementation["definition"]> = {}): AgentRoleImplementation {
  return {
    definition: {
      id: "writer",
      revision: "1",
      title: "写作",
      specialty: "写模型",
      instructions: "你是模型作者。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "action"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["discuss", "generate", "modify"] },
          mode: { type: "string" }
        }
      },
      contextSchema: { type: "object" },
      tools: { required: ["get_model_node"], optional: [] },
      nativeCapabilities: { required: [], optional: [] },
      requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
      output: { kind: "tool-receipts" },
      ...overrides
    },
    prepare: ({ target }) => ({
      messages: [{ role: "user", content: `目标 ${target.canvasId ?? ""}，请写模型。` }]
    })
  };
}

function fakeAdapter(inputs: AgentAdapterRunInput[], outcome: AgentAdapterRunOutcome = { status: "succeeded", receipt: { kind: "test" } }): AgentConversationAdapter {
  return {
    id: "fake",
    capabilities: () => ({ discussion: true, targets: ["model3d"], tools: true, models: "remote" }),
    authorization: async () => "ready",
    models: async () => ({ models: [] }),
    async run(input) {
      inputs.push(input);
      return outcome;
    }
  };
}

function setup(options: { roles?: ReturnType<typeof createAgentRoleRegistry>; adapter?: AgentConversationAdapter } = {}) {
  const store = openConversationStore({ path: path.join(tempDir(), "agent.sqlite") });
  stores.push(store);
  const inputs: AgentAdapterRunInput[] = [];
  const adapter = options.adapter ?? fakeAdapter(inputs);
  const registry = createAgentAdapterRegistry({
    hasCapability: () => true,
    resolveCapability: (id: string) => id === "agent-conversation-adapter:fake" ? adapter : undefined,
    resolveCapabilityOwner: () => ({ extensionId: "fake", configVersion: 0, mode: "public" }),
    snapshot: () => []
  });
  const agentRoles = options.roles ?? createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
  const conversations = createAgentConversationService({ store, registry, agentRoles });
  const created = conversations.createConversation({ owner: "owner", canvasId: "canvas", adapterId: "fake" });
  if (!created.ok) throw new Error("create failed");
  return { conversations, inputs, agentRoles, conversationId: created.conversation.conversationId };
}

function setupWithStore(options: { roles?: ReturnType<typeof createAgentRoleRegistry>; adapter?: AgentConversationAdapter } = {}) {
  const store = openConversationStore({ path: path.join(tempDir(), "agent.sqlite") });
  stores.push(store);
  const inputs: AgentAdapterRunInput[] = [];
  const adapter = options.adapter ?? fakeAdapter(inputs);
  const registry = createAgentAdapterRegistry({
    hasCapability: () => true,
    resolveCapability: (id: string) => id === "agent-conversation-adapter:fake" ? adapter : undefined,
    resolveCapabilityOwner: () => ({ extensionId: "fake", configVersion: 0, mode: "public" }),
    snapshot: () => []
  });
  const agentRoles = options.roles ?? createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
  const conversations = createAgentConversationService({ store, registry, agentRoles });
  const created = conversations.createConversation({ owner: "owner", canvasId: "canvas", adapterId: "fake" });
  if (!created.ok) throw new Error("create failed");
  return { conversations, inputs, agentRoles, store, conversationId: created.conversation.conversationId };
}

function entry(roleId?: string) {
  return {
    action: "generate" as const,
    canvasId: "canvas",
    nodeId: "node",
    mode: "model3d" as const,
    prompt: "写一个盒子",
    ...(roleId ? { roleId } : {})
  };
}

describe("agent conversation · 角色边界", () => {
  it("未选择角色或角色不存在时拒绝受理，不调用模型", async () => {
    const { conversations, inputs, conversationId } = setup();
    const missing = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry() });
    expect(missing).toMatchObject({ ok: false, error: { code: "role-not-found" } });
    const unknown = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r2", entry: entry("nobody/writer") });
    expect(unknown).toMatchObject({ ok: false, error: { code: "role-not-found" } });
    expect(inputs).toHaveLength(0);
  });

  it("冻结角色与 prepared 摘要，重传返回原回合且不重新推理", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    const registered = roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    expect(registered.ok).toBe(true);
    const { conversations, inputs, conversationId } = setup({ roles });
    const accepted = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("test/writer") });
    if (!accepted.ok) throw new Error("accept failed");
    await conversations.dispatchTurn(accepted.turn.turnId);
    const settled = conversations.queryTurn({ owner: "owner", requestId: "r1" });
    if (!settled.ok) throw new Error("query failed");
    expect(settled.turn.status).toBe("succeeded");
    expect(settled.turn.role).toMatchObject({ namespacedId: "test/writer", revision: "1" });
    expect(inputs).toHaveLength(1);
    const canonical = inputs[0]!.prepared!;
    expect(canonical.messages.map((message) => message.content).join("\n")).toContain("你是模型作者。");
    expect(canonical.tools).toEqual(["get_model_node"]);

    const replay = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("test/writer") });
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.reused).toBe(true);
    expect(replay.turn.role).toEqual(settled.turn.role);
    expect(inputs).toHaveLength(1);
  });

  it("受信领域入口提供的角色输入/上下文在受理时准备并冻结", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    const implementation: AgentRoleImplementation = {
      ...role(),
      definition: {
        ...role().definition,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "action", "topic"],
          properties: {
            prompt: { type: "string", minLength: 1 },
            action: { type: "string", enum: ["discuss", "generate", "modify"] },
            topic: { type: "string", minLength: 1 }
          }
        }
      },
      prepare: ({ input, context }) => ({
        messages: [{ role: "user", content: `素材：${(input as { topic: string }).topic} / ${(context as { baseline: string }).baseline}` }]
      })
    };
    roles.register({ extensionId: "test", implementation, artifactId: "test@1" });
    const { conversations, inputs, conversationId } = setup({ roles });
    const accepted = conversations.acceptTurn({
      owner: "owner",
      conversationId,
      requestId: "trusted",
      entry: { ...entry("test/writer"), action: "discuss", prompt: "写正文" },
      trustedRole: { input: { prompt: "写正文", action: "discuss", topic: "话题" }, context: { baseline: "b1" } }
    });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));
    await conversations.dispatchTurn(accepted.turn.turnId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.prepared!.messages.map((message) => message.content).join("\n")).toContain("素材：话题 / b1");
  });

  it("角色升级后：同 requestId 重传返回原回合；已排队旧回合不再推理", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    const first = roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    if (!first.ok) throw new Error("register failed");
    const { conversations, inputs, conversationId, store } = setupWithStore({ roles });
    const queued = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "queued", entry: entry("test/writer") });
    if (!queued.ok) throw new Error("accept failed");
    const done = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "done", entry: entry("test/writer") });
    if (!done.ok) throw new Error("accept failed");
    await conversations.dispatchTurn(done.turn.turnId);
    expect(inputs).toHaveLength(1);

    // 角色升级（同一扩展重新登记修订 2）。
    first.dispose();
    roles.register({ extensionId: "test", implementation: role({ revision: "2" }), artifactId: "test@1" });
    const replay = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "done", entry: entry("test/writer") });
    expect(replay).toMatchObject({ ok: true, reused: true });

    await conversations.dispatchTurn(queued.turn.turnId);
    const settled = conversations.queryTurn({ owner: "owner", requestId: "queued" });
    expect(settled).toMatchObject({ ok: true, turn: { status: "failed", error: { code: "role-version-conflict" } } });
    expect(inputs).toHaveLength(1);
    // 同一账本重开仍是原角色修订，不补造当前版本。
    const reopened = createAgentConversationService({ store, registry: createAgentAdapterRegistry({ hasCapability: () => true, resolveCapability: (id: string) => id === "agent-conversation-adapter:fake" ? fakeAdapter([]) : undefined, resolveCapabilityOwner: () => ({ extensionId: "fake", configVersion: 0, mode: "public" }), snapshot: () => [] }), agentRoles: roles });
    expect(reopened.queryTurn({ owner: "owner", requestId: "done" })).toMatchObject({ ok: true, turn: { role: { revision: "1" } } });
  });

  it("同一 requestId 换角色被拒绝（角色进入幂等身份）", () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    roles.register({ extensionId: "other", implementation: role(), artifactId: "other@1" });
    const { conversations, conversationId } = setup({ roles });
    expect(conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("test/writer") }).ok).toBe(true);
    expect(conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("other/writer") })).toMatchObject({
      ok: false,
      error: { code: "request-id-reused" }
    });
  });

  it("缺少必要工具时在推理前失败并保留可证明错误", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => [] });
    roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    const { conversations, inputs, conversationId } = setup({ roles });
    const accepted = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("test/writer") });
    expect(accepted).toMatchObject({ ok: false, error: { code: "role-requirement-unsatisfied" } });
    expect(inputs).toHaveLength(0);
  });

  it("通道能力不足时拒绝受理；角色停用后新回合不可用、历史可查", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    const textOnly = fakeAdapter([]);
    textOnly.capabilities = () => ({ discussion: true, targets: ["model3d"], tools: false, models: "remote" });
    const first = setup({ roles, adapter: textOnly });
    expect(first.conversations.acceptTurn({ owner: "owner", conversationId: first.conversationId, requestId: "r1", entry: entry("test/writer") })).toMatchObject({
      ok: false,
      error: { code: "role-requirement-unsatisfied" }
    });

    const second = setup({ roles });
    const accepted = second.conversations.acceptTurn({ owner: "owner", conversationId: second.conversationId, requestId: "ok", entry: entry("test/writer") });
    if (!accepted.ok) throw new Error("accept failed");
    await second.conversations.dispatchTurn(accepted.turn.turnId);
    roles.disposeExtension("test");
    const next = second.conversations.acceptTurn({ owner: "owner", conversationId: second.conversationId, requestId: "after", entry: entry("test/writer") });
    expect(next).toMatchObject({ ok: false, error: { code: "role-not-found" } });
    const history = second.conversations.queryTurn({ owner: "owner", requestId: "ok" });
    expect(history.ok && history.turn.status).toBe("succeeded");
  });

  it("停用角色会取消正在执行且冻结该角色的回合，不影响历史", async () => {
    const roles = createAgentRoleRegistry({ availableTools: () => ["get_model_node"] });
    roles.register({ extensionId: "test", implementation: role(), artifactId: "test@1" });
    let aborted = false;
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const adapter: AgentConversationAdapter = {
      id: "fake",
      capabilities: () => ({ discussion: true, targets: ["model3d"], tools: true, models: "remote" }),
      authorization: async () => "ready",
      models: async () => ({ models: [] }),
      run: (input) => new Promise((resolve) => {
        started?.();
        input.signal.addEventListener("abort", () => { aborted = true; resolve({ status: "cancelled" }); }, { once: true });
      })
    };
    const { conversations, conversationId } = setup({ roles, adapter });
    const accepted = conversations.acceptTurn({ owner: "owner", conversationId, requestId: "r1", entry: entry("test/writer") });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatch = conversations.dispatchTurn(accepted.turn.turnId);
    await running;
    conversations.onRoleRevoked("test/writer");
    await dispatch;
    expect(aborted).toBe(true);
    expect(conversations.queryTurn({ owner: "owner", requestId: "r1" })).toMatchObject({ ok: true, turn: { status: "cancelled" } });
  });
});
