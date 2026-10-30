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
  AgentConversationAdapter
} from "@woohaa3/contracts";
import { createSqliteAgentConversationStore as openConversationStore } from "../repository/agent-conversation-repository.js";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createExtensionAssistants } from "./extension-assistants.js";
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
};

function fakeAdapter(controls: FakeAdapterControls): AgentConversationAdapter {
  return {
    id: "fake",
    capabilities: () => ({ candidateGeneration:{imageInput:true,maxImages:8}, discussion: true, targets: ["model3d", "film-set", "camera", "canvas-group"], tools: true, models: "remote" }),
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
    }
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

describe("group ledger recovery", () => {
  it("freezes the host epoch, links child runs by exact owner and reconciles without inference", async () => {
    const controls: FakeAdapterControls = { seen: [], outcomes: [], queries: [], pending: [] };
    const adapter = fakeAdapter(controls);
    adapter.capabilities = () => ({ discussion: true, targets: ["canvas-group"], tools: true, models: "remote" });
    const store = createSqliteAgentConversationStore({ path: path.join(tempDir(), "group.sqlite") });
    const settle = vi.fn(async (input) => ({ status: "failed" as const, receipt: { kind: "canvas-group", actions: input.actions, outcomes: [{ runId: "child", state: "running" }] } }));
    const cancel = vi.fn();
    const service = createAgentConversationService({ store, registry: fakeRegistry(adapter), groupScopeEpoch: () => 7, groupEffects: { settle, cancel } });
    const created = service.createConversation({ owner: "owner", canvasId: "canvas", nodeId: "root", adapterId: "fake" });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const accepted = service.acceptTurn({ owner: "owner", conversationId: created.conversation.conversationId, requestId: "request", entry: { action: "generate", canvasId: "canvas", nodeId: "root", mode: "canvas-group", prompt: "create" } });
    expect(accepted.ok).toBe(true); if (!accepted.ok) return;
    expect(accepted.turn.target.expectedContentHash).toBe("group-epoch:7");
    service.recordGroupAction({ owner: "owner", requestId: "request", action: { canvasId: "canvas", nodeId: "n", runId: "child" } });
    service.recordGroupAction({ owner: "other", requestId: "request", action: { canvasId: "canvas", nodeId: "n", runId: "forged" } });
    expect(service.locateTurnByRun({ owner: "owner", runId: "child" }).ok).toBe(true);
    expect(service.locateTurnByRun({ owner: "other", runId: "child" }).ok).toBe(false);
    expect(service.locateTurnByRun({ owner: "owner", runId: "forged" }).ok).toBe(false);
    await service.reconcileUnknown();
    expect(controls.seen).toEqual([]); expect(controls.queries).toEqual([]);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ recovery: true }));
    expect(service.queryTurn({ owner: "owner", requestId: "request" })).toMatchObject({ ok: true, turn: { status: "failed", receipt: { outcomes: [{ runId: "child", state: "running" }] } } });
    service.cancelTurn({ owner: "owner", requestId: "request" });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ owner: "owner", actions: [{ canvasId: "canvas", nodeId: "n", runId: "child" }] }));
    expect(service.queryTurn({ owner: "owner", requestId: "request" })).toMatchObject({ ok: true, turn: { status: "failed" } });
  });
});

function setup(adapterOverrides: Partial<FakeAdapterControls> = {}, maxMessageChars?: number) {
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
    registry: fakeRegistry(fakeAdapter(controls)),
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

  it("保存消息与工具的混合顺序，完成时保留回合汇总且不重复追加消息", async () => {
    const { controls, service } = setup();
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "mixed", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
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

  it("消息被预算截断时，不重复追加未截断的汇总", async () => {    const { controls, service } = setup({}, 8);
    const created = service.createConversation({ owner: "user-a", canvasId: "canvas-1" });
    if (!created.ok) throw new Error("create failed");
    const accepted = service.acceptTurn({ owner: "user-a", conversationId: created.conversation.conversationId, requestId: "long", entry: entry() });
    if (!accepted.ok) throw new Error("accept failed");
    const dispatched = service.dispatchTurn(accepted.turn.turnId);
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
        requestId: `request-${n}`, entry: entry({ nodeId: `group-${n}`, mode: "canvas-group" }) });
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
    const input={owner:"owner",conversationId:created.conversation.conversationId,requestId:"structured",entry:{action:"discuss" as const,canvasId:"canvas",prompt:"design"},candidate};
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
    const input={owner:"owner",conversationId:created.conversation.conversationId,requestId:"lost",entry:{action:"discuss" as const,canvasId:"canvas",prompt:"design"},candidate};
    const accepted=service.acceptStructuredTurn(input);if(!accepted.ok)throw Error();
    await service.reconcileUnknown();
    await service.dispatchStructuredTurn(accepted.turn.turnId,candidate);
    expect(controls.seen).toHaveLength(0);
    expect(service.acceptStructuredTurn(input)).toMatchObject({ok:true,reused:true,turn:{status:"failed"}});
    service.cancelTurn({owner:"owner",requestId:"lost"});
    await service.dispatchStructuredTurn(accepted.turn.turnId,candidate);expect(controls.seen).toHaveLength(0);
  });
  it("extension facade freezes connections, scopes identities and reads canvas image bytes before execution",async()=>{
    const {service,controls}=setup({outcomes:[{status:"succeeded",assistantText:'{"design":true}'}]});
    const binding={connectionId:"selected",adapterId:"fake",configRevision:2,credentialEpoch:3};
    vi.spyOn(service,"resolveConnectionBinding").mockResolvedValue({ok:true,binding});
    const read=vi.fn(async()=>candidate.images[0]);
    const services={canvasAccess:{authorize:vi.fn(async({subject,canvasId})=>({ok:subject==="owner" && canvasId==="canvas"}))},media:{verify:vi.fn(async()=>({exists:true,metadata:{checksum:"hash",contentType:"image/png"}})),resources:{read}}} as unknown as import("@woohaa3/contracts").ApplicationExtensionServices;
    const facade=createExtensionAssistants("extension",services,()=>service);
    const input={subject:"owner",canvasId:"canvas",nodeId:"node",requestId:"request",connection:binding,model:"chosen",reasoningEffort:"high" as const,prompt:"design",outputSchema:candidate.outputSchema,references:[{storageKey:"key",checksum:"hash"}]};
    expect(await facade.submit({...input,connection:{...binding,credentialEpoch:1}})).toMatchObject({ok:false,code:"connection-unavailable"});
    const accepted = await facade.submit(input);
    expect(accepted).toMatchObject({ok:true,conversation:{conversationId:expect.any(String),requestId:expect.stringMatching(/^extension-/)}});
    if (!accepted.ok || !accepted.conversation) throw Error("missing ledger reference");
    expect(accepted.conversation.requestId).not.toBe(input.requestId);
    await vi.waitFor(()=>expect(controls.seen).toHaveLength(1));
    await service.whenSettled(controls.seen[0].turnId);
    expect(controls.seen[0]).toMatchObject({connection:binding,candidate,intent:{model:"chosen",reasoningEffort:"high"}});
    expect(read).toHaveBeenCalledWith("key","canvas");
    expect(await facade.query(input)).toMatchObject({state:"succeeded",text:'{"design":true}',conversation:accepted.conversation});
    expect(service.queryTurn({owner:input.subject,requestId:accepted.conversation.requestId})).toMatchObject({ok:true,turn:{conversationId:accepted.conversation.conversationId}});
    expect(await facade.submit(input)).toEqual(accepted);expect(controls.seen).toHaveLength(1);
    expect(await facade.submit({...input,prompt:"changed"})).toMatchObject({ok:false,code:"request-id-reused"});
    expect(await facade.query({...input,nodeId:"other"})).toBeNull();
    expect(await createExtensionAssistants("other-extension",services,()=>service).query(input)).toBeNull();
    await expect(facade.query({...input,subject:"other"})).rejects.toThrow();
    expect(await facade.submit({...input,canvasId:"other"})).toMatchObject({ok:false,code:"authorization-unavailable"});
    await facade.cancel(input);expect(controls.seen).toHaveLength(1);
  });
});

it("discovers every group turn from the owner ledger across pages, archived conversations and restart, without dispatch", () => {
  const { store, controls } = setup();
  const service = createAgentConversationService({ store, registry: fakeRegistry(fakeAdapter(controls)), groupScopeEpoch: () => 7 });
  const accepted: string[] = [];
  for (const nodeId of ["manual", "manual", "other", "manual", "manual"]) {
    const created = service.createConversation({ owner: "owner", canvasId: "canvas", nodeId, adapterId: "fake" });
    if (!created.ok) throw Error(created.error.message);
    const requestId = `ledger-${accepted.length}`;
    const result = service.acceptTurn({ owner: "owner", conversationId: created.conversation.conversationId, requestId,
      entry: { action: "generate", mode: "canvas-group", canvasId: "canvas", nodeId, prompt: "test" } });
    if (!result.ok) throw Error(result.error.message);
    accepted.push(requestId);
    // Archiving the conversation must not hide its outstanding execution.
    store.clearTarget({ owner: "owner", canvasId: "canvas", nodeId });
  }
  const requests: string[] = []; let cursor: string | undefined;
  do {
    const page = service.listGroupExecutions({ owner: "owner", canvasId: "canvas", nodeId: "manual", limit: 2, cursor });
    requests.push(...page.turns.map(t => t.requestId)); cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(requests).size).toBe(4);
  expect(service.listGroupExecutions({ owner: "other", canvasId: "canvas" }).turns).toEqual([]);
  expect(service.listGroupExecutions({ owner: "owner", canvasId: "other" }).turns).toEqual([]);
  expect(controls.seen).toEqual([]); expect(controls.queries).toEqual([]);
  expect(service.clearContext({ owner: "owner", canvasId: "canvas", nodeId: "manual" })).toMatchObject({ ok: false });
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
