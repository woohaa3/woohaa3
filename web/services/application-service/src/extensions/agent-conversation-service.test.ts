/**
 * 宿主 Agent 会话服务验收
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.4–1.8 / design D1/D2/D7）。
 *
 * 用 fake adapter 覆盖与渲染无关的权威行为：
 * - owner+canvas 隔离（跨用户/跨画布读写被拒，不泄漏内容）；
 * - accept-before-dispatch、requestId+输入 hash 去重与输入变化拒绝；
 * - 单会话 active turn 与 owner/global 并发预算；
 * - 事件 sequence/cursor 重放与 snapshot 恢复一致；
 * - 取消、重启 unknown reconcile、显式 run/task 关联、打开/查询不重推理。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentConversationAdapterEvent,
  AgentConversationAdapter
} from "@woohaa3/contracts";
import { createSqliteAgentConversationStore as openConversationStore } from "../repository/agent-conversation-repository.js";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createExtensionAssistants } from "./extension-assistants.js";
import { createAgentRoleRegistry } from "../agent-roles/registry.js";

/**
 * 本套件关注会话账本/事件/取消，不关注角色语义：给每个服务注入一个无工具、
 * 无内建能力要求的测试角色，避免每条用例重复角色样板。
 */
import { testRoleRegistry } from "./test-role-registry.js";
import type { CanvasAgentWorkspaceService } from "../workspaces/service.js";
import { createAgentConversationService, hashIntent } from "./agent-conversation-service.js";

const dirs: string[] = [];
const openStores: ReturnType<typeof openConversationStore>[] = [];
function createSqliteAgentConversationStore(options: Parameters<typeof openConversationStore>[0]) {
  const store = openConversationStore(options); openStores.push(store); return store;
}
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-agent-conv-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const store of openStores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FakeAdapterControls = {
  seen: AgentAdapterRunInput[];
  outcomes: AgentAdapterRunOutcome[];
  queries: Array<{ owner: string; requestId: string }>;
  /** 手动 resolve 当前 run（用于在途查询/取消）。 */
  pending: Array<(outcome: AgentAdapterRunOutcome) => void>;
  /** 宿主重启接管（任务 3.2/3.3）：可选，记录每次接管的输入。 */
  resume?: (input: AgentAdapterRunInput) => Promise<AgentAdapterRunOutcome | null>;
};

function fakeAdapter(controls: FakeAdapterControls): AgentConversationAdapter {
  return {
    id: "fake",
    capabilities: () => ({ candidateGeneration:{imageInput:true,maxImages:8}, discussion: true, targets: ["model3d", "camera"], tools: true, models: "remote" }),
    authorization: async () => "ready",
    models: async () => ({ models: [{ id: "gpt-6.1-sol", label: "GPT 6.1 Sol" }] }),
    async run(input) {
      controls.seen.push(input);
      const fixed = controls.outcomes.shift();
      if (fixed) return fixed;
      return await new Promise<AgentAdapterRunOutcome>((resolve) => controls.pending.push(resolve));
    },
    async query(input) {
      controls.queries.push(input);
      return null;
    },
    async cancel() {
      /* fake：由调用方通过 pending 收尾 */
    },
    ...(controls.resume ? { resume: controls.resume } : {})
  };
}

function fakeRegistry(adapter: AgentConversationAdapter) {
  return createAgentAdapterRegistry({
    hasCapability: (id) => id === "agent-conversation-adapter:fake",
    resolveCapabilityOwner: (id) => (id === "agent-conversation-adapter:fake" ? { extensionId: "fake-ext", configVersion: 1, mode: "public" } : null),
    resolveCapability: (id) => (id === "agent-conversation-adapter:fake" ? adapter : undefined),
    snapshot: () => [{ extensionId: "fake-ext", capabilities: ["agent-conversation-adapter:fake"] }]
  });
}

function setup(adapterOverrides: Partial<FakeAdapterControls> = {}, maxMessageChars?: number, agentRoles = testRoleRegistry(), canvasAgentWorkspaces?: CanvasAgentWorkspaceService) {
  const controls: FakeAdapterControls = {
    seen: [],
    outcomes: [],
    queries: [],
    pending: [],
    ...adapterOverrides
  };
  const store = createSqliteAgentConversationStore({ path: path.join(tempDir(), "agents.sqlite") });
  const service = createAgentConversationService({
    store,
    maxMessageChars,
    canvasAgentWorkspaces,
    registry: fakeRegistry(fakeAdapter(controls)),
    agentRoles,
    now: () => "2026-10-13T00:00:00.000Z",
    createId: (() => {
      let n = 0;
      return (prefix: string) => `${prefix}-${++n}`;
    })()
  });
  return { controls, store, service };
}

function setupWithAdapter(adapter: AgentConversationAdapter) {
  const store = createSqliteAgentConversationStore({ path: path.join(tempDir(), "agents.sqlite") });
  return {
    store,
    service: createAgentConversationService({
      store,
      registry: fakeRegistry(adapter),
      now: () => "2026-10-13T00:00:00.000Z"
    })
  };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  action: "discuss" as const,
  canvasId: "canvas-1",
  prompt: "你好",
  roleId: "test/discussion",
  ...overrides
});

describe("agent conversation service", () => {
  it("accept-before-dispatch 持久化用户消息与 accepted 事件，且完成回执写入终态", async () => {
    const { controls, service } = setup({ outcomes: [{ status: "succeeded", assistantText: "回复", receipt: { commandId: "simulated-command" } }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-1", entry: entry({ model: "gpt-5", reasoningEffort: "high" }) });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.turn.target).toMatchObject({ model: "gpt-5", reasoningEffort: "high" });
    expect(accepted.turn.status).toBe("queued");
    expect(accepted.reused).toBe(false);

    // accept 已持久化用户消息与 accepted 事件（dispatch 之前）。
    const before = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.snapshot.messages.some((m) => m.role === "user" && m.content === "你好")).toBe(true);
    expect(before.snapshot.events.some((e) => e.type === "accepted")).toBe(true);

    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);

    const done = service.queryTurn({ owner: "user-a", requestId: "req-1" });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.turn.status).toBe("succeeded");
    expect(done.turn.assistantText).toBe("回复");
    expect(controls.seen).toHaveLength(1);
    expect(controls.seen[0]!.intent).toMatchObject({ model: "gpt-5", reasoningEffort: "high" });
  });

  it("persists the world scope in the turn target so a sidebar continuation keeps it", async () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({
      owner: "user-a",
      conversationId: created.conversation.conversationId,
      requestId: "req-world",
      entry: entry({
        mode: "world",
        nodeId: "area-node",
        worldScope: { kind: "scene-area", areaId: "area-1" },
        allowSceneAreaExpansion: true,
        prompt: "搭场景"
      })
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.turn.target).toMatchObject({ mode: "world", worldScope: { kind: "scene-area", areaId: "area-1" } });
    const reread = service.queryTurn({ owner: "user-a", requestId: "req-world" });
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.turn.target.worldScope).toEqual({ kind: "scene-area", areaId: "area-1" });
    expect(reread.turn.target.allowSceneAreaExpansion).toBe(true);
    const changed = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-world", entry: entry({ mode: "world", nodeId: "area-node", worldScope: { kind: "scene-area", areaId: "area-1" }, prompt: "搭场景" }) });
    expect(changed).toMatchObject({ ok: false, error: { code: "request-id-reused" } });
  });

  it("keeps the frozen expansion choice and retry identity after reopening SQLite", () => {
    const dbPath = path.join(tempDir(), 'expansion.sqlite');
    const controls: FakeAdapterControls = { seen: [], outcomes: [], queries: [], pending: [] };
    const registry = fakeRegistry(fakeAdapter(controls));
    const firstStore = createSqliteAgentConversationStore({ path: dbPath });
    const first = createAgentConversationService({ store: firstStore, registry, agentRoles: testRoleRegistry() });
    const created = first.createConversation({ owner: 'user-a', canvasId: 'canvas-1' });
    if (!created.ok) throw Error('create failed');
    const request = { owner: 'user-a', conversationId: created.conversation.conversationId, requestId: 'expansion-restart',
      entry: entry({ mode: 'world', nodeId: 'area-node', worldScope: { kind: 'scene-area', areaId: 'area-1' }, allowSceneAreaExpansion: true }) };
    expect(first.acceptTurn(request)).toMatchObject({ ok: true, reused: false, turn: { target: { allowSceneAreaExpansion: true } } });
    firstStore.close();
    const secondStore = createSqliteAgentConversationStore({ path: dbPath });
    const second = createAgentConversationService({ store: secondStore, registry, agentRoles: testRoleRegistry() });
    expect(second.queryTurn({ owner: 'user-a', requestId: request.requestId })).toMatchObject({ ok: true, turn: { target: { allowSceneAreaExpansion: true } } });
    expect(second.acceptTurn(request)).toMatchObject({ ok: true, reused: true, turn: { target: { allowSceneAreaExpansion: true } } });
    expect(second.acceptTurn({ ...request, entry: { ...request.entry, allowSceneAreaExpansion: false } })).toMatchObject({ ok: false, error: { code: 'request-id-reused' } });
  });

  it("保存消息与工具的混合顺序，完成时保留回合汇总且不重复追加消息", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "mixed", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    // 角色准备是异步前置：等 adapter 真正收到本回合后再注入事件。
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    const input = controls.seen[0]!;
    input.emit({ type: "stage", stage: "reasoning", summary: "公开摘要" });
    input.emit({ type: "message", role: "assistant", content: "先读取" });
    input.emit({ type: "tool-started", tool: "get_model", callId: "a" });
    input.emit({ type: "tool-completed", tool: "get_model", callId: "a", ok: true });
    input.emit({ type: "message", role: "assistant", content: "已完成" });
    controls.pending[0]!({ status: "succeeded", assistantText: "先读取\n\n已完成", receipt: { status: "succeeded" } });
    await dispatched;
    await service.whenSettled(accepted.turn.turnId);
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    expect(read.snapshot.messages.map((message) => message.content)).toEqual(["你好", "先读取", "已完成"]);
    expect(read.snapshot.turns[0]?.assistantText).toBe("先读取\n\n已完成");
    expect(read.snapshot.events.find(event => event.type === "stage" && (event.payload as { summary?: string }).summary)?.payload)
      .toEqual({ stage: "reasoning", summary: "公开摘要" });
    expect(read.snapshot.messages.some(message => message.content.includes("公开摘要"))).toBe(false);
    expect(read.snapshot.events.filter((event) => event.type === "message-completed" || event.type.startsWith("tool-")).map((event) => event.type))
      .toEqual(["message-completed", "message-completed", "tool-started", "tool-completed", "message-completed"]);
    expect(read.snapshot.events.find((event) => event.type === "tool-completed")?.payload).toMatchObject({ callId: "a", ok: true });
  });

  it("流式分片聚合为一条消息，不把每个分片各存一条", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "stream", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    // 角色准备是异步前置：等 adapter 真正收到本回合后再注入事件。
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    const input = controls.seen[0]!;
    // 真增量：多个 append 分片属于同一条助手消息。
    for (const chunk of ["一", "段", "流式", "文本"]) input.emit({ type: "message", role: "assistant", content: chunk, delivery: "append" });
    controls.pending[0]!({ status: "succeeded", assistantText: "一段流式文本" });
    await dispatched;
    await service.whenSettled(accepted.turn.turnId);
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    const replies = read.snapshot.messages.filter((message) => message.role === "assistant");
    expect(replies.map((message) => message.content)).toEqual(["一段流式文本"]);
    expect(replies[0]?.truncated).toBe(false);
    // 事件窗口里只有一条消息的开始与完成，不按分片膨胀（用户消息不计入）。
    const assistantEvents = read.snapshot.events.filter((event) => event.type === "message-delta" || event.type === "message-completed");
    expect(assistantEvents.filter((event) => event.type === "message-delta")).toHaveLength(1);
    expect(read.snapshot.messages.map((message) => message.content)).toEqual(["你好", "一段流式文本"]);
  });

  it("累计快照按 replace 收敛到同一条消息，不重复拼接", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "snapshot", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    // 角色准备是异步前置：等 adapter 真正收到本回合后再注入事件。
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    const input = controls.seen[0]!;
    input.emit({ type: "message", role: "assistant", content: "你", delivery: "replace", streamId: "part-1" });
    input.emit({ type: "message", role: "assistant", content: "你好", delivery: "replace", streamId: "part-1" });
    input.emit({ type: "message", role: "assistant", content: "你好，世界", delivery: "replace", streamId: "part-1" });
    controls.pending[0]!({ status: "succeeded", assistantText: "你好，世界" });
    await dispatched;
    await service.whenSettled(accepted.turn.turnId);
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    expect(read.snapshot.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["你好，世界"]);
  });

  it("工具/阶段之后的后续助手消息仍作为独立一条保存", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "split", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    // 角色准备是异步前置：等 adapter 真正收到本回合后再注入事件。
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    const input = controls.seen[0]!;
    input.emit({ type: "message", role: "assistant", content: "先看一下", delivery: "append" });
    input.emit({ type: "tool-started", tool: "get_model", callId: "a" });
    input.emit({ type: "tool-completed", tool: "get_model", callId: "a", ok: true });
    input.emit({ type: "message", role: "assistant", content: "改完了", delivery: "append" });
    controls.pending[0]!({ status: "succeeded", assistantText: "先看一下\n\n改完了" });
    await dispatched;
    await service.whenSettled(accepted.turn.turnId);
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    expect(read.snapshot.messages.filter((message) => message.role === "assistant").map((message) => message.content))
      .toEqual(["先看一下", "改完了"]);
  });

  it.each([
    {
      name: "OpenCode 单换行连接保留消息内部 Markdown 换行，不重复存整轮汇总",
      events: [
        { type: "message", role: "assistant", content: "先读取\n范围", delivery: "replace", streamId: "intro" },
        { type: "tool-started", tool: "get_world_context", callId: "read" },
        { type: "tool-completed", tool: "get_world_context", callId: "read", ok: true },
        { type: "message", role: "assistant", content: "已完成\n\n- 右柱已移动\n- 左柱未变", delivery: "replace", streamId: "result" }
      ],
      summary: "先读取\n范围\n已完成\n\n- 右柱已移动\n- 左柱未变",
      expected: ["先读取\n范围", "已完成\n\n- 右柱已移动\n- 左柱未变"]
    },
    {
      name: "工具事件后同一原生消息从空快照更新完整正文，去重使用最新正文",
      events: [
        { type: "message", role: "assistant", content: "", delivery: "replace", streamId: "intro" },
        { type: "tool-started", tool: "move_world_model", callId: "move" },
        { type: "message", role: "assistant", content: "只移动右柱", delivery: "replace", streamId: "intro" },
        { type: "tool-completed", tool: "move_world_model", callId: "move", ok: true },
        { type: "message", role: "assistant", content: "完成\n位置核对通过", delivery: "replace", streamId: "result" }
      ],
      summary: "只移动右柱\n\n完成\n位置核对通过",
      expected: ["只移动右柱", "完成\n位置核对通过"]
    },
    {
      name: "无工具分隔的不同原生消息都参与汇总去重，仍各自独立保存",
      events: [
        { type: "message", role: "assistant", content: "先读取\n范围", delivery: "replace", streamId: "intro" },
        { type: "message", role: "assistant", content: "完成\n右柱已移动", delivery: "replace", streamId: "result" }
      ],
      summary: "先读取\n范围\n\n完成\n右柱已移动",
      expected: ["先读取\n范围", "完成\n右柱已移动"]
    },
    {
      name: "无流式增量时仍保存最终正文",
      events: [],
      summary: "最终正文\n- 右柱已移动",
      expected: ["最终正文\n- 右柱已移动"]
    },
    {
      name: "汇总仅部分重复时保留包含新信息的最终正文",
      events: [{ type: "message", role: "assistant", content: "右柱已移动", delivery: "replace", streamId: "progress" }],
      summary: "右柱已移动\n新增结论：左柱版本未变",
      expected: ["右柱已移动", "右柱已移动\n新增结论：左柱版本未变"]
    },
    {
      name: "最终正文不同于已有消息时不丢弃",
      events: [{ type: "message", role: "assistant", content: "开始移动", delivery: "replace", streamId: "progress" }],
      summary: "修改完成，已保存",
      expected: ["开始移动", "修改完成，已保存"]
    },
    {
      name: "不删除消息内部换行来误判不同最终正文",
      events: [
        { type: "message", role: "assistant", content: "模型", delivery: "replace", streamId: "first" },
        { type: "tool-started", tool: "get_world_context", callId: "read" },
        { type: "message", role: "assistant", content: "AB", delivery: "replace", streamId: "second" }
      ],
      summary: "模型\nA\nB",
      expected: ["模型", "AB", "模型\nA\nB"]
    },
    {
      name: "原生协议直接拼接多条消息时仍能去重",
      events: [
        { type: "message", role: "assistant", content: "先读取\n范围", delivery: "replace", streamId: "first" },
        { type: "tool-started", tool: "get_world_context", callId: "read" },
        { type: "message", role: "assistant", content: "已完成", delivery: "replace", streamId: "second" }
      ],
      summary: "先读取\n范围已完成",
      expected: ["先读取\n范围", "已完成"]
    }
  ] satisfies Array<{ name: string; events: AgentConversationAdapterEvent[]; summary: string; expected: string[] }>)('$name', async ({ events, summary, expected }) => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "aggregate", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    for (const event of events) controls.seen[0]!.emit(event);
    controls.pending[0]!({ status: "succeeded", assistantText: summary });
    await dispatched;
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    expect(read.snapshot.messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(expected);
    expect(read.snapshot.turns[0]?.assistantText).toBe(summary);
    expect(read.snapshot.turns[0]?.status).toBe("succeeded");
  });

  it("消息被预算截断时，不重复追加未截断的汇总", async () => {    const { controls, service } = setup({}, 8);
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "long", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
    await vi.waitFor(() => expect(controls.seen).toHaveLength(1));
    const text = "一段超过消息预算的回复";
    controls.seen[0]!.emit({ type: "message", role: "assistant", content: text });
    controls.pending[0]!({ status: "succeeded", assistantText: text });
    await dispatched;
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) throw new Error("read failed");
    const replies = read.snapshot.messages.filter((message) => message.role === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.truncated).toBe(true);
    expect(read.snapshot.turns[0]?.assistantText).toBe(text);
  });

  it("跨 owner 读取同一会话被拒且不泄漏内容", () => {
    const { service } = setup({ outcomes: [{ status: "succeeded" }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const foreign = service.readConversation({ owner: "user-b", conversationId: convId });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("not-found");
    expect(service.listConversations({ owner: "user-b", canvasId: "canvas-1" })).toHaveLength(0);
  });

  it("跨画布目标被拒（目标画布必须与会话一致）", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({
      owner: "user-a",
      conversationId: created.conversation.conversationId,
      requestId: "req-x",
      entry: entry({ canvasId: "canvas-2" })
    });
    expect(accepted.ok).toBe(false);
    if (accepted.ok) return;
    expect(accepted.error.code).toBe("unauthorized");
  });

  it("相同 requestId + 相同输入返回原运行，不重复推理", async () => {
    const { controls, service } = setup({ outcomes: [{ status: "succeeded", assistantText: "一次" }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const first = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    if (!first.ok) return;
    await service.dispatchTurn(first.turn.turnId);
    const again = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reused).toBe(true);
    expect(controls.seen).toHaveLength(1);
  });

  it("相同 requestId + 不同输入返回 request-id-reused", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const first = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    if (!first.ok) return;
    const conflict = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry({ prompt: "不同输入" }) });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("request-id-reused");
  });

  it("相同 requestId 改变思考强度也返回 request-id-reused", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    expect(service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-effort", entry: entry({ reasoningEffort: "low" }) })).toMatchObject({ ok: true });
    expect(service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-effort", entry: entry({ reasoningEffort: "high" }) })).toMatchObject({ ok: false, error: { code: "request-id-reused" } });
    expect(service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-effort", entry: entry({ reasoningEffort: "low" }) })).toMatchObject({ ok: true, reused: true });
  });

  it("回合冻结 capabilityRevision 并记录 reasoning 请求/应用结果", async () => {
    const { service, controls } = setup();
    const binding = { connectionId: "c", adapterId: "fake", configRevision: 2, credentialEpoch: 1, capabilityRevision: "rev-9" };
    vi.spyOn(service, "resolveConnectionBinding").mockResolvedValue({ ok: true, binding });
    controls.outcomes.push({ status: "succeeded", assistantText: "ok", receipt: { commandId: "cmd" }, reasoning: { requested: "high", applied: true } });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-reasoning", entry: entry({ model: "m", reasoningEffort: "high" }), connection: binding });
    if (!accepted.ok) throw new Error(accepted.error.message);
    expect(accepted.turn.target.capabilityRevision).toBe("rev-9");
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);
    const queried = service.queryTurn({ owner: "user-a", requestId: "req-reasoning" });
    expect(queried).toMatchObject({ ok: true, turn: { reasoning: { requested: "high", applied: true }, connection: { capabilityRevision: "rev-9" } } });
    expect(JSON.stringify(queried)).not.toContain("chain-of-thought");
  });

  it("同会话可以受理多个独立回合（不再有单活动回合门禁）", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const first = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    expect(first.ok).toBe(true);
    const second = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-2", entry: entry({ prompt: "第二个" }) });
    // change: 2026-10-22-remove-agent-execution-limits，任务 3.1：新 requestId 独立受理，
    // 每个回合有自己的取消身份与冻结历史基准。
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.turn.status).toBe("queued");
      expect(second.turn.turnId).not.toBe(first.ok && first.turn.turnId);
    }
    // 相同 requestId + 相同输入仍幂等复用，不同输入仍拒绝。
    expect(service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() })).toMatchObject({ ok: true, reused: true });
    expect(service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry({ prompt: "changed" }) })).toMatchObject({ ok: false, error: { code: "request-id-reused" } });
  });

  it("同一 owner 可以受理超过原 8 个活动回合", () => {
    const { service } = setup();
    for (let n = 0; n < 12; n++) {
      const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: `group-${n}` });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("conversation not created");
      const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId,
        requestId: `request-${n}`, entry: entry({ nodeId: `group-${n}`, mode: "model3d" }) });
      // 原 owner/global 各 8 的门禁已删除：全部独立受理为 queued。
      expect(accepted).toMatchObject({ ok: true, turn: { status: "queued" } });
    }
    service.cancelTurn({ owner: "user-a", requestId: "request-0" });
    expect(service.queryTurn({ owner: "user-a", requestId: "request-1" })).toMatchObject({ ok: true, turn: { status: "queued" } });
  });

  it("事件 cursor 重放与 snapshot 一致", async () => {
    const { service } = setup({ outcomes: [{ status: "succeeded", assistantText: "回复", receipt: { commandId: "simulated-command" } }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    if (!accepted.ok) return;
    await service.dispatchTurn(accepted.turn.turnId);

    const full = service.readConversation({ owner: "user-a", conversationId: convId });
    if (!full.ok) return;
    expect(full.snapshot.resyncRequired).toBe(false);
    const cursor = full.snapshot.cursor;
    expect(cursor).toBeGreaterThan(0);

    const incremental = service.readConversation({ owner: "user-a", conversationId: convId, cursor });
    if (!incremental.ok) return;
    expect(incremental.snapshot.events).toHaveLength(0);
    expect(incremental.snapshot.cursor).toBe(cursor);
  });

  it("显式 run/task 关联可从回合查询（不从节点 active run 反推）", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    if (!accepted.ok) return;
    const linked = service.linkRun({ owner: "user-a", requestId: "req-1", runId: "run-9", taskId: "task-9" });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.turn.runId).toBe("run-9");
    expect(linked.turn.taskId).toBe("task-9");
    const event = service.readConversation({ owner: "user-a", conversationId: convId });
    if (!event.ok) return;
    expect(event.snapshot.events.some((e) => e.type === "task-linked")).toBe(true);
  });

  it("adapter 回执声明的 run/task 关联被持久化，且可按确切 run 定位（任务 1.8）", async () => {
    const { service } = setup({ outcomes: [{ status: "succeeded", assistantText: "已生成", runId: "run-9", taskId: "task-9" }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const convId = created.conversation.conversationId;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: convId, requestId: "req-1", entry: entry() });
    if (!accepted.ok) return;
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);

    const queried = service.queryTurn({ owner: "user-a", requestId: "req-1" });
    if (!queried.ok) return;
    expect(queried.turn.runId).toBe("run-9");
    expect(queried.turn.taskId).toBe("task-9");

    // 领域链按 runId 反查确切回合（只读，不 dispatch）。
    const located = service.locateTurnByRun({ owner: "user-a", runId: "run-9" });
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.turn.requestId).toBe("req-1");
    expect(located.conversation.conversationId).toBe(convId);
  });

  it("同节点多次生成：旧 request/run 定位到旧回合，不被较新会话替代（任务 5.7）", async () => {
    const { service } = setup({
      outcomes: [
        { status: "succeeded", assistantText: "第一次", runId: "run-old", taskId: "task-old" },
        { status: "succeeded", assistantText: "第二次", runId: "run-new", taskId: "task-new" }
      ]
    });
    const firstConv = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!firstConv.ok) return;
    const first = service.acceptTurn({ owner: "user-a", conversationId: firstConv.conversation.conversationId, requestId: "req-old", entry: entry({ nodeId: "n1" }) });
    if (!first.ok) return;
    await service.dispatchTurn(first.turn.turnId);
    await service.whenSettled(first.turn.turnId);

    // 同一节点再次生成：新会话 + 新 requestId（旧关联保留）。
    const secondConv = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!secondConv.ok) return;
    const second = service.acceptTurn({ owner: "user-a", conversationId: secondConv.conversation.conversationId, requestId: "req-new", entry: entry({ nodeId: "n1" }) });
    if (!second.ok) return;
    await service.dispatchTurn(second.turn.turnId);
    await service.whenSettled(second.turn.turnId);

    const oldTurn = service.locateTurnByRun({ owner: "user-a", runId: "run-old" });
    expect(oldTurn.ok).toBe(true);
    if (!oldTurn.ok) return;
    expect(oldTurn.turn.requestId).toBe("req-old");
    expect(oldTurn.turn.runId).toBe("run-old");
    expect(oldTurn.conversation.conversationId).toBe(firstConv.conversation.conversationId);

    const newTurn = service.locateTurnByRun({ owner: "user-a", runId: "run-new" });
    expect(newTurn.ok).toBe(true);
    if (!newTurn.ok) return;
    expect(newTurn.turn.requestId).toBe("req-new");

    // 未关联的 runId 返回 not-found（调用方保留原任务详情），绝不跳到最近会话。
    const missing = service.locateTurnByRun({ owner: "user-a", runId: "run-plain-task" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("not-found");
  });

  it("跨 owner 不能按 runId 定位他人回合（不泄漏内容）", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-1", entry: entry() });
    expect(service.linkRun({ owner: "user-a", requestId: "req-1", runId: "run-secret" }).ok).toBe(true);
    const foreign = service.locateTurnByRun({ owner: "user-b", runId: "run-secret" });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("not-found");
  });

  it("重启读取未结算回合并核对 adapter，无回执时结算为 failed，不自动重推理", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-1", entry: entry() });
    if (!accepted.ok) return;
    expect(accepted.turn.status).toBe("queued");

    const marked = await service.reconcileUnknown();
    expect(marked).toHaveLength(1);
    expect(marked[0]!.status).toBe("queued");
    expect(controls.queries).toHaveLength(1);
    expect(controls.seen).toHaveLength(0); // 未触发新的推理
    const after = service.queryTurn({ owner: "user-a", requestId: "req-1" });
    if (!after.ok) return;
    // 重启后 adapter 无法给出回执：不能永久留在活动态，按失败结算。
    expect(after.turn.status).toBe("failed");
    expect(after.turn.error).toMatchObject({ code: "result-unconfirmed" });
  });

  it("catalog 投影真实授权/能力，不静默替换模型", async () => {
    const { service } = setup();
    const catalog = await service.catalog({ owner: "user-a" });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.authState).toBe("ready");
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(catalog.capabilities.targets).toContain("model3d");
  });

  it("目录读取与登录状态分离：未登录仍返回可展示的模型目录", async () => {
    const models = vi.fn(async () => ({ models: [{ id: "gpt-6.1-sol", label: "GPT 6.1 Sol" }] }));
    const { service } = setupWithAdapter({
      id: "fake",
      capabilities: () => ({ discussion: true, targets: ["model3d"], tools: true, models: "remote" }),
      authorization: async () => "disconnected",
      models,
      run: async () => ({ status: "failed", error: { code: "unavailable", message: "未登录" } })
    });
    const catalog = await service.catalog({ owner: "user-a", adapterId: "fake" });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(models).toHaveBeenCalledWith({ owner: "user-a" });
    expect(catalog.authState).toBe("disconnected");
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("hashIntent 对目标/输入敏感", () => {
    const a = hashIntent(entry() as never);
    const b = hashIntent(entry({ prompt: "别的" }) as never);
    expect(a).not.toBe(b);
  });
});

describe("agent conversation · 节点会话复用与清空（design D8）", () => {
  it("创建时绑定 nodeId，按目标只返回该节点的当前会话", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.conversation.nodeId).toBe("node-1");

    const found = service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(found.conversation?.conversationId).toBe(created.conversation.conversationId);

    // 未绑定 / 其它 owner 不可见。
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-2" }).conversation).toBeNull();
    expect(service.findConversationForTarget({ owner: "user-b", canvasId: "canvas-1", nodeId: "node-1" }).conversation).toBeNull();
  });

  it("首轮 accept 把无目标新会话补绑到节点，且不重复绑定后续节点", () => {
    const { service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "req-bind", entry: entry({ action: "generate", nodeId: "node-9", mode: "model3d", model: "m" }) });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    // 首轮补绑：turnCount 之前为 0。
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-9" }).conversation?.conversationId).toBe(created.conversation.conversationId);
  });

  it("同一节点多次提交复用同一条会话（不每次新建）", () => {
    const { service } = setup();
    const first = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    if (!first.ok) throw new Error("create failed");
    const found = service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(found.conversation?.conversationId).toBe(first.conversation.conversationId);
    // 第二次提交前再查仍是同一条。
    service.acceptTurn({ owner: "user-a", conversationId: first.conversation.conversationId, requestId: "r1", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d", model: "m" }) });
    const again = service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(again.conversation?.conversationId).toBe(first.conversation.conversationId);
  });

  it("清空上下文解除目标关联但保留会话/消息（可按 id 继续读）", async () => {
    const { service } = setup({ outcomes: [{ status: "succeeded", assistantText: "回复", receipt: { commandId: "simulated-command" } }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    if (!created.ok) throw new Error("create failed");
    const conversationId = created.conversation.conversationId;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId, requestId: "req-clear", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d", model: "m" }) });
    if (!accepted.ok) throw new Error("accept failed");
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);

    const cleared = service.clearContext({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    expect(cleared).toEqual({ ok: true, cleared: 1 });
    // 归档后不再被按节点查找到……
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" }).conversation).toBeNull();
    // ……但历史仍在：快照可按 id 读取，消息未删除。
    const read = service.readConversation({ owner: "user-a", conversationId });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.messages.some((m) => m.role === "user")).toBe(true);

    // 清空后再次创建即为新会话，旧会话保持归档。
    const fresh = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    if (!fresh.ok) throw new Error("create failed");
    expect(fresh.conversation.conversationId).not.toBe(conversationId);
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" }).conversation?.conversationId).toBe(fresh.conversation.conversationId);
  });

  it("清空上下文不因讨论回复把归档会话重新绑回节点", async () => {
    const { service } = setup({ outcomes: [{ status: "succeeded", receipt: { commandId: "simulated-command" } }, { status: "succeeded" }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    if (!created.ok) throw new Error("create failed");
    const conversationId = created.conversation.conversationId;
    const first = service.acceptTurn({ owner: "user-a", conversationId, requestId: "req-1", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d", model: "m" }) });
    if (!first.ok) throw new Error("accept failed");
    await service.dispatchTurn(first.turn.turnId);
    await service.whenSettled(first.turn.turnId);
    service.clearContext({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
    // 对归档会话继续讨论：turnCount > 0，不再补绑。
    const second = service.acceptTurn({ owner: "user-a", conversationId, requestId: "req-2", entry: entry({ action: "discuss", nodeId: "node-1", prompt: "继续" }) });
    if (!second.ok) throw new Error("accept failed");
    await service.dispatchTurn(second.turn.turnId);
    await service.whenSettled(second.turn.turnId);
    expect(service.findConversationForTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" }).conversation).toBeNull();
  });

  it("旧库（无 node_id 列）打开即自动补列并可绑定/查找/清空", () => {
    const dbPath = path.join(tempDir(), "legacy.sqlite");
    // 模拟本次改动前的库：agent_conversations 无 node_id、无目标索引。
    const raw = new (loadNodeSqlite().DatabaseSync)(dbPath);
    raw.exec(`CREATE TABLE agent_conversations (
      conversation_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      latest_request_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    raw.prepare(
      "INSERT INTO agent_conversations (conversation_id, owner, canvas_id, adapter_id, title, status, latest_request_id, turn_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("legacy-1", "user-a", "canvas-1", "chatgpt", "旧会话", "idle", null, 0, "2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z");
    raw.close();

    // 打开即迁移：补 node_id 并建目标索引；旧记录保留（nodeId 为空）。
    const store = createSqliteAgentConversationStore({ path: dbPath });
    expect(store.getConversation("legacy-1")?.nodeId).toBeNull();
    const created = store.createConversation({ conversationId: "new-1", owner: "user-a", canvasId: "canvas-1", adapterId: "chatgpt", title: "新", nodeId: "node-1", now: "2026-10-13T00:00:01.000Z" });
    expect(created.nodeId).toBe("node-1");
    expect(store.findConversationByTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" })?.conversationId).toBe("new-1");
    expect(store.clearTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" })).toBe(1);
    expect(store.findConversationByTarget({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" })).toBeUndefined();
  });
});


it("无权威回执的目标回复结算 failed，仍可清空关联且不删除历史；查询不重发推理", async () => {
  const { service, controls } = setup({ outcomes: [{ status: "succeeded", assistantText: "我已修改" }] });
  const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" });
  if (!created.ok) throw new Error("create failed");
  const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "no-proof", entry: entry({ action: "generate", nodeId: "node-1", mode: "model3d" }) });
  if (!accepted.ok) throw new Error("accept failed");
  await service.dispatchTurn(accepted.turn.turnId); await service.whenSettled(accepted.turn.turnId);
  expect(service.queryTurn({ owner: "user-a", requestId: "no-proof" })).toMatchObject({ ok: true, turn: { status: "failed", error: { code: "write-unconfirmed" } } });
  // change: 2026-10-22-remove-agent-execution-limits，任务 3.2：清空只解除目标关联，
  // 不再被活动回合阻止，也不删除历史（回执仍可查）。
  expect(service.clearContext({ owner: "user-a", canvasId: "canvas-1", nodeId: "node-1" })).toMatchObject({ ok: true, cleared: 1 });
  expect(service.queryTurn({ owner: "user-a", requestId: "no-proof" })).toMatchObject({ ok: true, turn: { status: "failed" } });
  expect(controls.seen).toHaveLength(1);
  // failed 是终态：用户停止不能再把它改写成 cancelled。
  service.cancelTurn({ owner: "user-a", requestId: "no-proof" });
  expect(service.queryTurn({ owner: "user-a", requestId: "no-proof" })).toMatchObject({ ok: true, turn: { status: "failed" } });
});


describe("trusted structured assistant execution", () => {
  const candidate = {images:[{bytes:new Uint8Array([1,2,3]),contentType:"image/png"}],outputSchema:{type:"object"}};
  it("durably distinguishes structured dispatch and rejects schema/image changes under the same request",async()=>{
    const {service,controls}=setup({outcomes:[{status:"succeeded",assistantText:'{"ok":true}'}]});
    const created=service.createConversation({owner:"owner",canvasId:"canvas",adapterId:"fake"});
    if (!created.ok) throw new Error("create failed");
    const input={owner:"owner",conversationId:created.conversation.conversationId,requestId:"structured",entry:{action:"discuss" as const,canvasId:"canvas",prompt:"design",roleId:"test/discussion"},candidate};
    const accepted=service.acceptStructuredTurn(input);if(!accepted.ok)throw new Error("accept failed");
    expect(accepted.turn.target.structuredInputHash).toBeTruthy();
    await service.dispatchTurn(accepted.turn.turnId);expect(controls.seen).toHaveLength(0);
    await service.dispatchStructuredTurn(accepted.turn.turnId,{...candidate,outputSchema:{type:"array"}});expect(controls.seen).toHaveLength(0);
    expect(service.acceptStructuredTurn({...input,candidate:{...candidate,images:[]}})).toMatchObject({ok:false,error:{code:"request-id-reused"}});
    expect(service.acceptStructuredTurn({...input,candidate:{...candidate,outputSchema:{type:"array"}}})).toMatchObject({ok:false,error:{code:"request-id-reused"}});
    expect(service.acceptTurn(input)).toMatchObject({ok:false,error:{code:"request-id-reused"}});
    await Promise.all([service.dispatchStructuredTurn(accepted.turn.turnId,candidate),service.dispatchStructuredTurn(accepted.turn.turnId,candidate)]);
    expect(controls.seen).toHaveLength(1);expect(controls.seen[0].candidate).toEqual(candidate);expect(controls.seen[0].intent.action).toBe("discuss");
    expect(service.acceptStructuredTurn(input)).toMatchObject({ok:true,reused:true});
    expect(service.queryTurn({owner:"other",requestId:"structured"}).ok).toBe(false);
    expect(service.acceptStructuredTurn({...input,entry:{...input.entry,canvasId:"other"}}).ok).toBe(false);
  });
  it("restart and cancellation never restart structured inference",async()=>{
    const {service,controls}=setup();
    const created=service.createConversation({owner:"owner",canvasId:"canvas",adapterId:"fake"});if(!created.ok)throw Error();
    const input={owner:"owner",conversationId:created.conversation.conversationId,requestId:"lost",entry:{action:"discuss" as const,canvasId:"canvas",prompt:"design",roleId:"test/discussion"},candidate};
    const accepted=service.acceptStructuredTurn(input);if(!accepted.ok)throw Error();
    await service.reconcileUnknown();
    await service.dispatchStructuredTurn(accepted.turn.turnId,candidate);
    expect(controls.seen).toHaveLength(0);
    expect(service.acceptStructuredTurn(input)).toMatchObject({ok:true,reused:true,turn:{status:"failed"}});
    service.cancelTurn({owner:"owner",requestId:"lost"});
    await service.dispatchStructuredTurn(accepted.turn.turnId,candidate);expect(controls.seen).toHaveLength(0);
  });
  it("extension role facade freezes connections, scopes identities and reads canvas image bytes before execution",async()=>{
    const registry=createAgentRoleRegistry({availableTools:()=>["get_model_node","submit_model_script"]});
    const registered=registry.register({extensionId:"extension",artifactId:"extension@1",implementation:{
      definition:{id:"writer",revision:"1",title:"写作",specialty:"写模型",instructions:"你是模型作者。",
        inputSchema:{type:"object",additionalProperties:false,required:["prompt"],properties:{prompt:{type:"string",minLength:1}}},
        contextSchema:{type:"object"},tools:{required:["get_model_node"],optional:["submit_model_script"]},
        nativeCapabilities:{required:[],optional:[]},requirements:{imageInput:false,toolCalling:true,structuredOutput:"none"},
        output:{kind:"tool-receipts"}},
      prepare:({input})=>({messages:[{role:"user",content:String((input as {prompt:string}).prompt)}]})
    }});
    if(!registered.ok)throw Error(registered.message);
    const {service,controls}=setup({outcomes:[{status:"succeeded",assistantText:'{"design":true}'}]},undefined,registry);
    const binding={connectionId:"selected",adapterId:"fake",configRevision:2,credentialEpoch:3};
    vi.spyOn(service,"resolveConnectionBinding").mockResolvedValue({ok:true,binding});
    const read=vi.fn(async()=>candidate.images[0]);
    const services={canvasAccess:{authorize:vi.fn(async({subject,canvasId})=>({ok:subject==="owner" && canvasId==="canvas"}))},media:{verify:vi.fn(async()=>({exists:true,metadata:{checksum:"hash",contentType:"image/png"}})),resources:{read}}} as unknown as import("@woohaa3/contracts").ApplicationExtensionServices;
    const facade=createExtensionAssistants("extension",services,()=>service,()=>registry);
    const input={subject:"owner",canvasId:"canvas",nodeId:"node",requestId:"request",connection:binding,roleId:"extension/writer",roleInput:{prompt:"design"},roleContext:{},model:"chosen",reasoningEffort:"high" as const,references:[{storageKey:"key",checksum:"hash"}]};
    expect(await facade.submitRole({...input,connection:{...binding,credentialEpoch:1}})).toMatchObject({ok:false,code:"connection-unavailable"});
    const accepted = await facade.submitRole(input);
    expect(accepted).toMatchObject({ok:true,conversation:{conversationId:expect.any(String),requestId:expect.stringMatching(/^extension-/)}});
    if (!accepted.ok || !accepted.conversation) throw Error("missing ledger reference");
    expect(accepted.conversation.requestId).not.toBe(input.requestId);
    await vi.waitFor(()=>expect(controls.seen).toHaveLength(1));
    await service.whenSettled(controls.seen[0].turnId);
    expect(controls.seen[0]).toMatchObject({connection:binding,intent:{roleId:"extension/writer",model:"chosen",reasoningEffort:"high"}});
    expect(controls.seen[0].candidate).toMatchObject({outputSchema:{},referenceIdentity:input.references});
    expect(read).toHaveBeenCalledWith("key","canvas");
    expect(await facade.query(input)).toMatchObject({state:"succeeded",text:'{"design":true}',conversation:accepted.conversation});
    expect(service.queryTurn({owner:input.subject,requestId:accepted.conversation.requestId})).toMatchObject({ok:true,turn:{conversationId:accepted.conversation.conversationId}});
    expect(await facade.submitRole(input)).toEqual(accepted);expect(controls.seen).toHaveLength(1);
    expect(await facade.submitRole({...input,roleInput:{prompt:"changed"}})).toMatchObject({ok:false,code:"request-id-reused"});
    expect(await facade.query({...input,nodeId:"other"})).toBeNull();
    expect(await createExtensionAssistants("other-extension",services,()=>service,()=>registry).query(input)).toBeNull();
    await expect(facade.query({...input,subject:"other"})).rejects.toThrow();
    expect(await facade.submitRole({...input,canvasId:"other"})).toMatchObject({ok:false,code:"authorization-unavailable"});
    await facade.cancel(input);expect(controls.seen).toHaveLength(1);
  });
});


it("DSML 工具文本不能把无工具的讨论结算为成功", async () => {
  const { service } = setup({ outcomes: [{ status: "succeeded", assistantText: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="woohaa_get_film_set_clips">' }] });
  const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
  if (!created.ok) throw new Error("create failed");
  const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "dsml", entry: entry() });
  if (!accepted.ok) throw new Error("accept failed");
  await service.dispatchTurn(accepted.turn.turnId);
  expect(service.queryTurn({ owner: "user-a", requestId: "dsml" })).toMatchObject({ ok: true, turn: { status: "failed", error: { code: "tool-call-not-executed" } } });
});

it("whole-set context persists separately from legacy local conversations without rewriting old turns", () => {
  const { service, store } = setup();
  const scope = { owner: "user-a", canvasId: "canvas-1", nodeId: "film" };
  const legacy = service.createConversation(scope);
  const whole = service.createConversation({ ...scope, contextKey: "film-set:whole" });
  if (!legacy.ok || !whole.ok) throw Error("create failed");
  expect(service.findConversationForTarget(scope).conversation?.conversationId).toBe(legacy.conversation.conversationId);
  expect(service.findConversationForTarget({ ...scope, contextKey: "film-set:whole" }).conversation?.conversationId).toBe(whole.conversation.conversationId);
  expect(store.getConversation(whole.conversation.conversationId)?.contextKey).toBe("film-set:whole");
  expect(store.getConversation(legacy.conversation.conversationId)?.contextKey).toBeNull();
  expect(service.findConversationForTarget({ ...scope, owner: "other", contextKey: "film-set:whole" }).conversation).toBeNull();
  expect(service.findConversationForTarget({ ...scope, nodeId: "other", contextKey: "film-set:whole" }).conversation).toBeNull();
  expect(service.findConversationForTarget({ ...scope, connectionId: "other", contextKey: "film-set:whole" }).conversation).toBeNull();
  const read = service.readConversation({ owner: scope.owner, conversationId: legacy.conversation.conversationId });
  expect(read.ok).toBe(true);
});

describe("in-flight turn adoption across host restarts", () => {
  const adoptionEntry = () => entry({ action: "modify", nodeId: "node-1" });

  it("adopts a running turn from the executor cursor, emits each event once, and settles once", async () => {
    const resumed: AgentAdapterRunInput[] = [];
    const { controls, service, store } = setup({
      resume: async (input) => {
        resumed.push(input);
        // 执行器 journal 里已有两条未读事件；宿主按 cursor 幂等落库。
        input.emitExecutor?.(1, { type: "stage", stage: "writing" });
        input.emitExecutor?.(2, { type: "message", role: "assistant", content: "adopted reply", delivery: "replace", streamId: "s1" });
        return { status: "succeeded", assistantText: "adopted reply", receipt: { commandId: "adopted" } };
      }
    });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "adopt-1", entry: adoptionEntry() });
    if (!accepted.ok) return;
    store.updateTurn(accepted.turn.turnId, { status: "running", stage: "running", executorCursor: 0 }, "2026-10-13T00:00:30.000Z");

    const discovered = await service.reconcileUnknown();
    expect(discovered.some((turn) => turn.turnId === accepted.turn.turnId)).toBe(true);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.resumeCursor).toBe(0);
    expect(controls.seen).toHaveLength(0); // 没有重新调用 run / 推理

    // 再核对一次：终态不再接管，不重复写消息。
    await service.reconcileUnknown();
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) return;
    expect(read.snapshot.messages.filter((message) => message.role === "assistant" && message.content === "adopted reply")).toHaveLength(1);
    expect(service.queryTurn({ owner: "user-a", requestId: "adopt-1" })).toMatchObject({ ok: true, turn: { status: "succeeded" } });
  });

  it("starts legacy turns without a cursor from the journal head and records a recovered event", async () => {
    let cursor: number | "head" | undefined;
    const { service, store } = setup({
      resume: async (input) => {
        cursor = input.resumeCursor;
        return { status: "succeeded", receipt: { commandId: "legacy" } };
      }
    });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "legacy", entry: adoptionEntry() });
    if (!accepted.ok) return;
    store.updateTurn(accepted.turn.turnId, { status: "running", stage: "running", executorCursor: null }, "2026-10-13T00:00:30.000Z");
    await service.reconcileUnknown();
    expect(cursor).toBe("head");
    const read = service.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) return;
    expect(read.snapshot.events.some((event) => event.type === "recovered")).toBe(true);
  });

  it("allows only one host to adopt the same turn", async () => {
    const file = path.join(tempDir(), "shared.sqlite");
    const firstStore = createSqliteAgentConversationStore({ path: file });
    const secondStore = createSqliteAgentConversationStore({ path: file });
    let resumeCalls = 0;
    const resume = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome | null> => {
      resumeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      input.emitExecutor?.(1, { type: "message", role: "assistant", content: "only once", delivery: "replace", streamId: "s1" });
      return { status: "succeeded", assistantText: "only once", receipt: { commandId: "c" } };
    };
    const make = (store: typeof firstStore) => createAgentConversationService({
      store,
      registry: fakeRegistry(fakeAdapter({ seen: [], outcomes: [], queries: [], pending: [], resume })),
      agentRoles: testRoleRegistry(),
      now: () => "2026-10-13T00:00:00.000Z"
    });
    const first = make(firstStore);
    const created = first.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = first.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "dual", entry: adoptionEntry() });
    if (!accepted.ok) return;
    firstStore.updateTurn(accepted.turn.turnId, { status: "running", stage: "running", executorCursor: 0 }, "2026-10-13T00:00:30.000Z");
    const second = make(secondStore);
    await Promise.all([first.reconcileUnknown(), second.reconcileUnknown()]);
    expect(resumeCalls).toBe(1);
    const read = second.readConversation({ owner: "user-a", conversationId: created.conversation.conversationId });
    if (!read.ok) return;
    expect(read.snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("settles failed when the executor journal no longer holds the turn", async () => {
    const { service, store, controls } = setup({ resume: async () => null });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "lost", entry: adoptionEntry() });
    if (!accepted.ok) return;
    store.updateTurn(accepted.turn.turnId, { status: "running", stage: "running", executorCursor: 4 }, "2026-10-13T00:00:30.000Z");
    await service.reconcileUnknown();
    expect(service.queryTurn({ owner: "user-a", requestId: "lost" })).toMatchObject({ ok: true, turn: { status: "failed" } });
    expect(controls.seen).toHaveLength(0); // 不自动重跑
  });

  it("persists the turn authority before dispatch", async () => {
    const { service } = setup({ outcomes: [{ status: "succeeded", receipt: { commandId: "x" } }] });
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "auth", entry: adoptionEntry() });
    if (!accepted.ok) return;
    await service.dispatchTurn(accepted.turn.turnId);
    await service.whenSettled(accepted.turn.turnId);
    expect(service.turnAuthority(accepted.turn.turnId)).toMatchObject({ owner: "user-a", canvasId: "canvas-1", adapterId: "fake", revokedAt: null });
  });
});

describe("turn authority revocation", () => {
  it("revokes the persisted authority when the user cancels a turn", async () => {
    const { service, controls } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "cancel-authority", entry: entry({ action: "modify", nodeId: "node-1" }) });
    if (!accepted.ok) return;
    void service.dispatchTurn(accepted.turn.turnId);
    while (controls.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(service.turnAuthority(accepted.turn.turnId)?.revokedAt).toBeNull();
    service.cancelTurn({ owner: "user-a", requestId: "cancel-authority" });
    expect(service.turnAuthority(accepted.turn.turnId)?.revokedAt).not.toBeNull();
    controls.pending[0]?.({ status: "cancelled" });
    await service.whenSettled(accepted.turn.turnId);
  });
});


it("does not authorize or dispatch a turn cancelled while its workspace is being prepared", async () => {
  let started!: () => void, release!: () => void;
  const preparing = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  const workspace = {
    prepare: vi.fn(async (_identity: unknown, prepared: import("@woohaa3/contracts").PreparedAgentRoleTurn) => { started(); await gate; return prepared; }),
    cancel: vi.fn(async () => {}), settled: vi.fn(async () => {})
  } as unknown as CanvasAgentWorkspaceService;
  const { controls, service, store } = setup({}, undefined, testRoleRegistry(), workspace);
  const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
  if (!created.ok) throw new Error("create failed");
  const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "cancel-prepare", entry: entry() });
  if (!accepted.ok) throw new Error("accept failed");
  void service.dispatchTurn(accepted.turn.turnId); await preparing;
  expect(service.cancelTurn({ owner: "user-a", requestId: "cancel-prepare" })).toEqual({ ok: true });
  release(); await service.whenSettled(accepted.turn.turnId);
  expect(store.getTurn(accepted.turn.turnId)?.status).toBe("cancelled");
  expect(store.getTurnAuthority(accepted.turn.turnId)).toBeUndefined();
  expect(controls.seen).toHaveLength(0);
  expect(workspace.cancel).toHaveBeenLastCalledWith({ owner: "user-a", canvasId: "canvas-1", requestId: "cancel-prepare" });
});
