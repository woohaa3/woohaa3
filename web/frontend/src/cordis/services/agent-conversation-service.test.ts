/**
 * 宿主 Agent 会话前端 service 单测
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.4/5.8/6.1 / design D6a）。
 *
 * 只覆盖与渲染无关的关联/导航语义：打开详情保存合法来源并只读读取快照、关闭恢复来源
 * （来源失效则不恢复）、打开/关闭/查询不 accept/dispatch、按确切 requestId 隔离。
 * 真实后端语义（accept-before-dispatch、去重、重启 unknown）由 application-service 测试覆盖。
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot, ConversationSummary, ConversationTurn } from "@woohaa3/contracts";
import { createAgentConversationService } from "./agent-conversation-service.js";
import type { AgentConversationRemote } from "./agent-conversation-remote.js";
import type { CanvasPanelRoute } from "../navigation/contracts.js";

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    requestId: "req-1",
    action: "discuss",
    status: "running",
    stage: "running",
    target: { canvasId: "cv" },
    tools: [],
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides
  };
}

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: "conv-1",
    canvasId: "cv",
    adapterId: "chatgpt",
    title: "对话",
    status: "active",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    turnCount: 1,
    ...overrides
  };
}

function snapshot(): ConversationSnapshot {
  return { conversation: summary(), turns: [turn()], messages: [], events: [], cursor: 3, resyncRequired: false };
}

describe("exact assistant request reads", () => {
  it("deduplicates concurrent reads and retains independent targets in reverse response order", async () => {
    const pending = new Map<string, (value: Awaited<ReturnType<AgentConversationRemote["query"]>>) => void>();
    const query = vi.fn((id: string) => new Promise<Awaited<ReturnType<AgentConversationRemote["query"]>>>(resolve => pending.set(id, resolve)));
    const service = createAgentConversationService({ remote: fakeRemote({ query }) });
    const a = service.queryTurn("a");
    const a2 = service.queryTurn("a");
    const b = service.queryTurn("b");
    expect(query).toHaveBeenCalledTimes(2);
    for (const id of ["b", "a"]) pending.get(id)!({ ok: true, value: {
      conversation: summary({ conversationId: `conv-${id}` }),
      turn: turn({ requestId: id, conversationId: `conv-${id}`, target: { canvasId: "cv", nodeId: id } }), snapshot: snapshot(),
    } });
    await Promise.all([a, a2, b]);
    expect(Object.keys(service.getSnapshot().turnsByRequest!)).toEqual(["b", "a"]);
    expect(service.getSnapshot().turnsByRequest!.b.turn.target.nodeId).toBe("b");
  });
  it("discards late reads after an identity switch", async () => {
    let owner = "owner-a";
    let resolve!: (value: Awaited<ReturnType<AgentConversationRemote["query"]>>) => void;
    const service = createAgentConversationService({ dataScopeId: () => owner,
      remote: fakeRemote({ query: () => new Promise(done => { resolve = done; }) }),
    });
    const read = service.queryTurn("a");
    owner = "owner-b";
    resolve({ ok: true, value: { conversation: summary(), turn: turn(), snapshot: snapshot() } });
    await read;
    expect(service.getSnapshot().active).toBeNull();
    expect(service.getSnapshot().turnsByRequest).toBeUndefined();
  });
});

it("publishes a local submitting target and clears it after rejection without a fake turn", async () => {
  let reject!: (value: Awaited<ReturnType<AgentConversationRemote["accept"]>>) => void;
  const service = createAgentConversationService({ remote: fakeRemote({ accept: () => new Promise(resolve => { reject = resolve; }) }) });
  const request = service.submitTurn({ canvasId: "cv", conversationId: "conv-1", requestId: "pending",
    entry: { canvasId: "cv", nodeId: "film", mode: "film-set", action: "modify", prompt: "change" } });
  expect(service.getSnapshot().pendingSubmissions?.pending.nodeId).toBe("film");
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  reject({ ok: false, code: "rejected", error: "Rejected" });
  await request;
  expect(service.getSnapshot().pendingSubmissions).toEqual({});
  expect(Object.keys(service.getSnapshot().turnsByRequest ?? {})).toEqual([]);
  expect(service.getSnapshot().active).toBeNull();
});

function fakeRemote(overrides: Partial<AgentConversationRemote> = {}): AgentConversationRemote {
  return {
    catalog: async () => ({ ok: true, value: { models: [], authState: "ready", capabilities: { discussion: true, targets: ["model3d"], tools: false, models: "remote" } } }),
    listConnections: async () => ({ ok: true, value: { connections: [] } }),
    mcpStatus: async () => ({ ok: true, value: { builtin: { ready: true, status: "ready", serverName: "woohaa3-model-canvas", tools: [], checkedAt: "2026-10-13T00:00:00.000Z" }, external: { serverUrl: "http://localhost/mcp/model-canvas", transport: "streamable-http" } } }),
    list: async () => ({ ok: true, value: { conversations: [summary()] } }),
    create: async () => ({ ok: true, value: { conversation: summary() } }),
    findForTarget: async () => ({ ok: true, value: { conversation: null } }),
    clearContext: async () => ({ ok: true, value: { ok: true, cleared: 1 } }),
    switchConnection: async () => ({ ok: true, value: { ok: true, cleared: 1 } }),
    read: async () => ({ ok: true, value: snapshot() }),
    accept: async () => ({ ok: true, value: { conversation: summary(), turn: turn(), reused: false } }),
    query: async () => ({ ok: true, value: { conversation: summary(), turn: turn(), snapshot: snapshot() } }),
    locate: async () => ({ ok: true, value: { conversation: summary(), turn: turn(), snapshot: snapshot() } }),
    cancel: async () => ({ ok: true, value: { ok: true } }),
    link: async () => ({ ok: true, value: { turn: turn() } }),
    ...overrides
  };
}

/** 最小导航桩：记录 open/close，维护当前 panel 与可用集合。 */
function navStub(initial: CanvasPanelRoute | null, available: Set<string>) {
  let panel = initial;
  const opened: CanvasPanelRoute[] = [];
  const closed: Array<string | undefined> = [];
  const navigation = {
    getPanel: () => panel,
    openPanel: (route: CanvasPanelRoute) => {
      opened.push(route);
      panel = route;
      return { ok: true };
    },
    closePanel: (panelType?: CanvasPanelRoute["type"]) => {
      closed.push(panelType);
      if (!panelType || panel?.type === panelType) panel = null;
      return { ok: true };
    },
    panelAvailable: (route: CanvasPanelRoute) => available.has(route.type)
  };
  return { navigation, opened, closed, current: () => panel };
}

describe("agent conversation service (frontend)", () => {
  it("提交首轮建立/复用会话并接受回合（不在浏览器复制消息）", async () => {
    const accept = vi.fn(async () => ({ ok: true as const, value: { conversation: summary(), turn: turn(), reused: false } }));
    const service = createAgentConversationService({ remote: fakeRemote({ accept }) });
    const result = await service.submitTurn({
      canvasId: "cv",
      requestId: "req-1",
      entry: { action: "discuss", canvasId: "cv", prompt: "你好" }
    });
    expect(result.ok).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().active?.requestId).toBe("req-1");
  });

  it("navigateToDetail 保存来源生成面板 route 并只读读取快照（不 accept/dispatch）", async () => {
    const accept = vi.fn();
    const read = vi.fn(async () => ({ ok: true as const, value: snapshot() }));
    const { navigation, opened } = navStub({ type: "model-node-editor", nodeId: "n1" }, new Set(["model-node-editor", "agent-conversation"]));
    const service = createAgentConversationService({ remote: fakeRemote({ read, accept: accept as never }), navigation });

    service.navigateToDetail({ conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    expect(opened.at(-1)).toMatchObject({ type: "agent-conversation", conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    await vi.waitFor(() => expect(service.getSnapshot().detail).not.toBeNull());
    expect(read).toHaveBeenCalledWith("conv-1", 0);
    expect(accept).not.toHaveBeenCalled();
  });

  it("collapseDetail 恢复合法来源生成面板", () => {
    const { navigation, current } = navStub({ type: "model-node-editor", nodeId: "n1" }, new Set(["model-node-editor", "agent-conversation"]));
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    service.navigateToDetail({ conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    expect(current()!.type).toBe("agent-conversation");
    service.collapseDetail();
    expect(current()).toEqual({ type: "model-node-editor", nodeId: "n1" });
    expect(service.getSnapshot().detail).toBeNull();
  });

  it("clearDetail 只清读模型缓存，不改写导航 route（卸载清理语义）", async () => {
    const { navigation, opened, closed, current } = navStub({ type: "model-node-editor", nodeId: "n1" }, new Set(["model-node-editor", "agent-conversation"]));
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    service.navigateToDetail({ conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    await vi.waitFor(() => expect(service.getDetail()).not.toBeNull());
    const opensBefore = opened.length;
    service.clearDetail();
    expect(service.getDetail()).toBeNull();
    // 不触发任何 open/close，详情 route 保持打开（显式返回才由 collapseDetail 收起）。
    expect(opened).toHaveLength(opensBefore);
    expect(closed).toHaveLength(0);
    expect(current()).toMatchObject({ type: "agent-conversation", conversationId: "conv-1", requestId: "req-1" });
  });

  it("来源失效（节点删除）时不恢复失效 route，仅关闭详情", () => {
    const available = new Set(["model-node-editor", "agent-conversation"]);
    const { navigation, closed, current } = navStub({ type: "model-node-editor", nodeId: "n1" }, available);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    service.navigateToDetail({ conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    // 来源生成面板失效（节点被删除）。
    available.delete("model-node-editor");
    service.collapseDetail();
    expect(current()).toBeNull();
    expect(closed.at(-1)).toBe("agent-conversation");
  });

  it("queryTurn 只按确切 requestId 查询，不重新提交", async () => {
    const query = vi.fn(async () => ({ ok: true as const, value: { conversation: summary(), turn: turn(), snapshot: snapshot() } }));
    const accept = vi.fn();
    const service = createAgentConversationService({ remote: fakeRemote({ query, accept: accept as never }) });
    await service.queryTurn("req-1");
    expect(query).toHaveBeenCalledWith("req-1");
    expect(accept).not.toHaveBeenCalled();
  });

  it("locateAndOpenDetail 按 runId 定位确切回合再打开详情（不按 nodeId 跳到最近会话）", async () => {
    const locate = vi.fn(async () => ({
      ok: true as const,
      value: {
        conversation: summary(),
        turn: turn({ runId: "run-9", target: { canvasId: "cv", nodeId: "n1" } }),
        snapshot: snapshot()
      }
    }));
    const accept = vi.fn();
    const { navigation, opened } = navStub(null, new Set(["agent-conversation"]));
    const service = createAgentConversationService({ remote: fakeRemote({ locate, accept: accept as never }), navigation });

    const result = await service.locateAndOpenDetail({ runId: "run-9" });
    expect(result.ok).toBe(true);
    expect(locate).toHaveBeenCalledWith("run-9");
    // 详情 route 携带确切 run 身份（不复制消息）。
    expect(opened.at(-1)).toMatchObject({ type: "agent-conversation", conversationId: "conv-1", requestId: "req-1", runId: "run-9", nodeId: "n1" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("locateAndOpenDetail 未关联 Agent 回合时不打开详情（保留原任务详情）", async () => {
    const locate = vi.fn(async () => ({ ok: false as const, code: "not-found", error: "未找到该运行关联的 Agent 回合" }));
    const { navigation, opened } = navStub({ type: "model-node-editor", nodeId: "n1" }, new Set(["model-node-editor", "agent-conversation"]));
    const service = createAgentConversationService({ remote: fakeRemote({ locate }), navigation });

    const result = await service.locateAndOpenDetail({ runId: "run-none" });
    expect(result.ok).toBe(false);
    expect(opened).toHaveLength(0);
    expect(navigation.getPanel()).toEqual({ type: "model-node-editor", nodeId: "n1" });
  });
});

describe("agent conversation service · 节点会话复用与清空（design D8）", () => {
  const generateEntry = { action: "generate" as const, canvasId: "cv", nodeId: "n1", mode: "model3d" as const, model: "m", prompt: "p" };

  it("无 conversationId 时按目标节点复用已有会话（不新建）", async () => {
    const findForTarget = vi.fn(async () => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-node", nodeId: "n1" }) } }));
    const create = vi.fn();
    const accept = vi.fn(async () => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-node", nodeId: "n1" }), turn: turn(), reused: false } }));
    const service = createAgentConversationService({ remote: fakeRemote({ findForTarget, create: create as never, accept }) });

    const result = await service.submitTurn({ canvasId: "cv", requestId: "req-1", entry: generateEntry });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findForTarget).toHaveBeenCalledWith("cv", "n1");
    expect(create).not.toHaveBeenCalled();
    expect(result.value.conversationId).toBe("conv-node");
  });

  it("目标未命中时新建会话并绑定节点", async () => {
    const findForTarget = vi.fn(async () => ({ ok: true as const, value: { conversation: null } }));
    const create = vi.fn(async (input: { nodeId?: string }) => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-new", ...(input.nodeId ? { nodeId: input.nodeId } : {}) }) } }));
    const accept = vi.fn(async () => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-new", nodeId: "n1" }), turn: turn(), reused: false } }));
    const service = createAgentConversationService({ remote: fakeRemote({ findForTarget, create: create as never, accept }) });

    const result = await service.submitTurn({ canvasId: "cv", requestId: "req-1", entry: generateEntry });
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "n1" }));
  });

  it("显式 conversationId 直接复用（讨论回复不改绑节点、不按目标查找）", async () => {
    const findForTarget = vi.fn();
    const accept = vi.fn(async () => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-x" }), turn: turn(), reused: false } }));
    const service = createAgentConversationService({ remote: fakeRemote({ findForTarget, accept }) });

    const result = await service.submitTurn({ canvasId: "cv", conversationId: "conv-x", requestId: "req-1", entry: { action: "discuss", canvasId: "cv", nodeId: "n1", prompt: "继续" } });
    expect(result.ok).toBe(true);
    expect(findForTarget).not.toHaveBeenCalled();
  });

  it("clearContext 解除关联、清理详情读模型并自增 contextRevision", async () => {
    const clearContext = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, cleared: 1 } }));
    const read = vi.fn(async () => ({ ok: true as const, value: { ...snapshot(), conversation: summary({ conversationId: "conv-1", canvasId: "cv", nodeId: "n1" }) } }));
    const service = createAgentConversationService({ remote: fakeRemote({ clearContext, read }) });

    await service.openDetail("conv-1");
    expect(service.getDetail()).not.toBeNull();
    const before = service.getSnapshot().contextRevision;

    const result = await service.clearContext({ canvasId: "cv", nodeId: "n1" });
    expect(result.ok).toBe(true);
    expect(clearContext).toHaveBeenCalledWith("cv", "n1");
    expect(service.getDetail()).toBeNull();
    expect(service.getSnapshot().contextRevision).toBe(before + 1);
  });

  it("listConnections 只读返回可见连接、失败保留原因（change 2026-10-16，任务 2.4）", async () => {
    const connections = [
      { connectionId: "c1", adapterId: "openai-responses", extensionId: "sdk-agent", name: "OpenAI", runCategory: "http-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 0, status: { transport: { state: "ready" }, credential: { state: "ready" }, modelAccess: { state: "ready" }, tools: { state: "ready" } }, ready: true, capabilities: { discussion: true, imageInput: true, tools: true, structuredResult: true, cancel: true, resume: false }, models: [], credentialConfigured: true }
    ] as never[];
    const listConnections = vi.fn(async () => ({ ok: true as const, value: { connections } }));
    const service = createAgentConversationService({ remote: fakeRemote({ listConnections }) });
    const result = await service.listConnections("openai-responses");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.connectionId).toBe("c1");
    expect(listConnections).toHaveBeenCalledWith("openai-responses");

    const failing = createAgentConversationService({ remote: fakeRemote({ listConnections: async () => ({ ok: false as const, code: "unavailable", error: "不可用" }) }) });
    const failure = await failing.listConnections();
    expect(failure.ok).toBe(false);
  });

  it("submitTurn 把选定连接透传给按目标查找与新建", async () => {
    const findForTarget = vi.fn(async () => ({ ok: true as const, value: { conversation: null } }));
    const create = vi.fn(async (_input: { connectionId?: string }) => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-new" }) } }));
    const accept = vi.fn(async () => ({ ok: true as const, value: { conversation: summary({ conversationId: "conv-new" }), turn: turn(), reused: false } }));
    const service = createAgentConversationService({ remote: fakeRemote({ findForTarget, create: create as never, accept }) });

    await service.submitTurn({ canvasId: "cv", connectionId: "c2", requestId: "req-1", entry: { action: "discuss", canvasId: "cv", nodeId: "n1", prompt: "hi" } });
    expect(findForTarget).toHaveBeenCalledWith("cv", "n1", "c2");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c2" }));
  });

  it("参数恢复与详情共用在途读取，完成后刷新仍读取权威数据", async () => {
    let resolve!: (value: { ok: true; value: ConversationSnapshot }) => void;
    const read = vi.fn(() => new Promise<{ ok: true; value: ConversationSnapshot }>(done => { resolve = done; }));
    const service = createAgentConversationService({ remote: fakeRemote({ read }) });
    const restore = service.readConversation("conv-1");
    const open = service.openDetail("conv-1");
    expect(read).toHaveBeenCalledTimes(1);
    resolve({ ok: true, value: snapshot() });
    await Promise.all([restore, open]);
    expect(service.getDetail()?.conversation.conversationId).toBe("conv-1");
    const refresh = service.openDetail("conv-1");
    expect(read).toHaveBeenCalledTimes(2);
    resolve({ ok: true, value: snapshot() });
    await refresh;
  });

  it("switchConnection 成功后清理详情读模型并自增 contextRevision；失败保留原状态", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: { ...snapshot(), conversation: summary({ conversationId: "conv-1", canvasId: "cv", nodeId: "n1" }) } }));
    const switchConnection = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, cleared: 1 } }));
    const service = createAgentConversationService({ remote: fakeRemote({ read, switchConnection }) });
    await service.openDetail("conv-1");
    const before = service.getSnapshot().contextRevision;

    const result = await service.switchConnection({ canvasId: "cv", nodeId: "n1", connectionId: "c2" });
    expect(result.ok).toBe(true);
    expect(switchConnection).toHaveBeenCalledWith({ canvasId: "cv", nodeId: "n1", connectionId: "c2" });
    expect(service.getDetail()).toBeNull();
    expect(service.getSnapshot().contextRevision).toBe(before + 1);

    const failing = createAgentConversationService({ remote: fakeRemote({ switchConnection: async () => ({ ok: false as const, code: "conversation-busy", error: "活动回合" }) }) });
    const failure = await failing.switchConnection({ canvasId: "cv", nodeId: "n1", connectionId: "c2" });
    expect(failure.ok).toBe(false);
    expect(failing.getSnapshot().contextRevision).toBe(0);
  });
});
