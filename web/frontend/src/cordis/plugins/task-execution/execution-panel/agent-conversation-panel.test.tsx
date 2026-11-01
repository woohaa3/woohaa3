/**
 * Agent 对话详情面板 · 卸载清理语义测试
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.4/5.5 / design D6a）。
 *
 * 覆盖：挂载只读读取快照；**卸载只清读模型缓存，不改写导航 route**（StrictMode 重放与
 * 切换到其它 route 时不得收起刚打开的详情）；显式返回由 `collapseDetail` 负责。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { StrictMode } from "react";
import type { ReactNode } from "react";
import type { ConversationSnapshot, ConversationTurn } from "@woohaa3/contracts";
import { CanvasNavigationStore } from "../../../navigation/store.js";
import type { CanvasPanelDefinition, CanvasPanelRoute } from "../../../navigation/contracts.js";
import { createAgentConversationService } from "../../../services/agent-conversation-service.js";
import type { AgentConversationRemote } from "../../../services/agent-conversation-remote.js";
import { AgentConversationPanel } from "./agent-conversation-panel.js";

function turn(): ConversationTurn {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    requestId: "req-1",
    action: "generate",
    status: "running",
    stage: "running",
    target: { canvasId: "cv", nodeId: "n1" },
    tools: [],
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z"
  };
}

function snapshot(): ConversationSnapshot {
  return {
    conversation: {
      conversationId: "conv-1",
      canvasId: "cv",
      adapterId: "chatgpt",
      title: "对话",
      status: "active",
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
      turnCount: 1
    },
    turns: [turn()],
    messages: [],
    events: [],
    cursor: 1,
    resyncRequired: false
  };
}

function fakeRemote(): AgentConversationRemote {
  return {
    catalog: async () => ({ ok: true, value: { models: [], authState: "ready", capabilities: { discussion: true, targets: ["model3d"], tools: false, models: "remote" } } }),
    listConnections: async () => ({ ok: true, value: { connections: [] } }),
    mcpStatus: async () => ({ ok: true, value: { builtin: { ready: true, status: "ready", serverName: "s", tools: [], checkedAt: "t" }, external: { serverUrl: "http://localhost/mcp/model-canvas", transport: "streamable-http" } } }),
    list: async () => ({ ok: true, value: { conversations: [] } }),
    create: async () => ({ ok: false, code: "not-found", error: "无" }),
    findForTarget: async () => ({ ok: true, value: { conversation: null } }),
    clearContext: async () => ({ ok: true, value: { ok: true, cleared: 0 } }),
    switchConnection: async () => ({ ok: true, value: { ok: true, cleared: 0 } }),
    read: async () => ({ ok: true, value: snapshot() }),
    accept: async () => ({ ok: false, code: "not-found", error: "无" }),
    query: async () => ({ ok: false, code: "not-found", error: "无" }),
    locate: async () => ({ ok: false, code: "not-found", error: "无" }),
    cancel: async () => ({ ok: true, value: { ok: true } }),
    link: async () => ({ ok: false, code: "not-found", error: "无" }),
    skillStepByNode: async () => ({ ok: true, value: { step: null } }),
    skillSteps: async () => ({ ok: true, value: { steps: [] } }),
    skillStepDetail: async () => ({ ok: false, code: "not-found", error: "无" }),
    cancelSkillStep: async () => ({ ok: false, code: "not-found", error: "无" }),
    regenerateSkillStep: async () => ({ ok: false, code: "not-found", error: "无" })
  };
}

function navStub(initial: CanvasPanelRoute | null) {
  let panel = initial;
  const opened: CanvasPanelRoute[] = [];
  const navigation = {
    getPanel: () => panel,
    openPanel: (route: CanvasPanelRoute) => {
      opened.push(route);
      panel = route;
      return { ok: true };
    },
    closePanel: () => {
      panel = null;
      return { ok: true };
    },
    panelAvailable: () => true
  };
  return { navigation, opened, current: () => panel };
}

const DETAIL: CanvasPanelRoute = { type: "agent-conversation", conversationId: "conv-1", requestId: "req-1", nodeId: "n1" };

async function mount(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { el, root, act };
}

describe("AgentConversationPanel · 卸载清理", () => {
  it("导航已加载当前快照时挂载不再次请求完整对话", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: snapshot() }));
    const remote = fakeRemote(); remote.read = read;
    const service = createAgentConversationService({ remote, navigation: navStub(DETAIL).navigation });
    await service.openDetail("conv-1");
    const { root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
  it("folds conversion data without hiding later discussion or truncating expanded output", async () => {
    const raw = JSON.stringify({ items: [{ modelScript: "scene.box();".repeat(1000) }] });
    const remote = fakeRemote();
    const data = {
      ...snapshot(),
      turns: [
        { ...turn(), target: { canvasId: "cv", delivery: { purpose: "text-generation" as const, domainRequestId: "domain", attemptId: "1" } } },
        { ...turn(), turnId: "discussion", requestId: "discussion", action: "discuss" as const }
      ],
      messages: [
        { messageId: "candidate", conversationId: "conv-1", turnId: "turn-1", requestId: "req-1", role: "assistant" as const, content: raw, truncated: false, sequence: 1, createdAt: turn().createdAt },
        { messageId: "discussion", conversationId: "conv-1", turnId: "discussion", requestId: "discussion", role: "assistant" as const, content: '{"answer":"普通讨论"}', truncated: false, sequence: 2, createdAt: turn().createdAt }
      ]
    };
    remote.read = async () => ({ ok: true, value: data });
    const service = createAgentConversationService({ remote, navigation: navStub(DETAIL).navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
    const details = el.querySelector("details.agent-detail__receipt") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(el.textContent).toContain("结构化生成数据");
    expect(el.textContent).not.toContain("scene.box");
    expect(el.textContent).toContain("普通讨论");
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(details.querySelector("pre")?.textContent).toBe(raw);
    data.messages[0]!.content = raw + "stream continues";
    await act(async () => { await service.openDetail("conv-1"); });
    expect(details.open).toBe(true);
    expect(details.querySelector("pre")?.textContent).toBe(raw + "stream continues");
    await act(async () => { root.unmount(); });
  });

  it.each([["thread-started", "助手已连接"], ["reasoning", "思考中"], ["responding", "生成中"]])("shows readable native activity %s", async (stage, label) => {
    const remote = fakeRemote();
    remote.read = async () => ({ ok: true, value: { ...snapshot(), turns: [{ ...turn(), stage }] } });
    const service = createAgentConversationService({ remote, navigation: navStub(DETAIL).navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
    expect(el.textContent).toContain(label);
    if (stage !== "reasoning") expect(el.textContent).not.toContain(stage);
    await act(async () => { root.unmount(); });
  });

  it("StrictMode 重放后详情 route 仍打开（卸载清理不改写 route）", async () => {
    const { navigation, opened } = navStub(DETAIL);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    const { root, act } = await mount(
      <StrictMode>
        <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={() => undefined} />
      </StrictMode>
    );
    await act(async () => {
      root.unmount();
    });
    // 卸载清理 MUST NOT 关闭或恢复来源 route。
    expect(opened).toHaveLength(0);
    expect(navigation.getPanel()).toEqual(DETAIL);
  });

  it("挂载只读读取快照，卸载只清缓存不改写 route", async () => {
    const { navigation, opened } = navStub(DETAIL);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    const { root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={() => undefined} />
    );
    await act(async () => undefined);
    expect(service.getDetail()).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
    expect(service.getDetail()).toBeNull();
    expect(opened).toHaveLength(0);
    expect(navigation.getPanel()).toEqual(DETAIL);
  });

  it("真实 CanvasNavigationStore：点击动作打开详情 route，StrictMode 挂载后仍保持打开", async () => {
    const nav = new CanvasNavigationStore({});
    const source: CanvasPanelRoute = { type: "node-execution", nodeId: "n1" };
    nav.registerPanel({ type: "node-execution", owner: "test", render: () => null });
    nav.openPanel(source);
    const service = createAgentConversationService({
      remote: fakeRemote(),
      navigation: {
        getPanel: () => nav.getSnapshot().panel,
        openPanel: (route) => nav.openPanel(route),
        closePanel: (panelType) => nav.closePanel(panelType),
        panelAvailable: (route) => nav.panelAvailable(route)
      }
    });
    const detailDefinition: CanvasPanelDefinition = {
      type: "agent-conversation",
      owner: "test",
      validate: (route) => route.type === "agent-conversation" && route.conversationId !== "" && route.requestId !== "",
      render: ({ route }) =>
        route.type === "agent-conversation" ? (
          <AgentConversationPanel conversationId={route.conversationId} requestId={route.requestId} service={service} onClose={() => undefined} />
        ) : null
    };
    nav.registerPanel(detailDefinition);

    // 用户点击状态区具名动作：只读打开确切回合详情（不 accept/dispatch）。
    service.navigateToDetail({ conversationId: "conv-1", requestId: "req-1", nodeId: "n1" });
    expect(nav.getSnapshot().panel).toMatchObject({ type: "agent-conversation", conversationId: "conv-1", requestId: "req-1" });

    // 宿主 CanvasPanelHost 以真实 registry 渲染当前 route（StrictMode 重放）。
    function Host() {
      const route = nav.getSnapshot().panel;
      if (!route) return null;
      const definition = nav.resolvePanel(route.type);
      if (!definition) return null;
      const Component = definition.render;
      return <Component route={route} writable />;
    }
    const { root, act } = await mount(
      <StrictMode>
        <Host />
      </StrictMode>
    );
    await act(async () => undefined);
    expect(nav.getSnapshot().panel).toMatchObject({ type: "agent-conversation", conversationId: "conv-1", requestId: "req-1" });
    await act(async () => {
      root.unmount();
    });
    // 收起详情仍回到合法来源生成面板 route。
    service.collapseDetail();
    expect(nav.getSnapshot().panel).toMatchObject({ type: "node-execution", nodeId: "n1" });
  });
});

describe("AgentConversationPanel · 运行中刷新", () => {
  it("shows elapsed time and public summaries separately from candidate data, without inventing missing output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:08:20.000Z"));
    const data = snapshot();
    data.turns = [{ ...turn(), stage: "reasoning" }];
    const remote = fakeRemote();
    remote.read = async () => ({ ok: true, value: data });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
    try {
      expect(el.querySelector('.agent-detail__progress')?.textContent).toContain("已用 8 分 20 秒");
      expect(el.textContent).toContain("尚无公开摘要或正文");
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(el.querySelector('.agent-detail__progress')?.textContent).toContain("已用 8 分 21 秒");
      data.events = [{ sequence: 1, conversationId: "conv-1", turnId: "turn-1", requestId: "req-1", type: "stage", payload: { stage: "reasoning", summary: "正在整理主要对象与空间布局" }, createdAt: turn().createdAt }];
      await act(async () => { await service.openDetail("conv-1"); });
      expect(el.querySelector('.agent-detail__progress-text')?.textContent).toBe("正在整理主要对象与空间布局");
      expect(el.textContent).not.toContain("尚无公开摘要或正文");
      data.turns = [{ ...turn(), stage: "responding" }];
      data.messages = [{ messageId: "a", conversationId: "conv-1", turnId: "turn-1", requestId: "req-1", role: "assistant", content: "输出".repeat(5000), truncated: false, sequence: 1, createdAt: turn().createdAt }];
      await act(async () => { await service.openDetail("conv-1"); });
      expect(el.querySelector('.agent-detail__progress-note')?.textContent).toBe("已收到 10,000 字");
      data.turns = [{ ...turn(), status: "succeeded" }];
      await act(async () => { await service.openDetail("conv-1"); });
      expect(el.querySelector('.agent-detail__progress')).toBeNull();
    } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
  });

  it.each(["cancelled", "failed", "succeeded"] as const)("%s 回合中的未完成工具不会继续显示为进行中", async status => {
    const remote = fakeRemote();
    remote.read = async () => ({ ok: true, value: {
      ...snapshot(),
      turns: [{ ...turn(), status, stage: status, tools: [{ tool: "validate_canvas_script", status: "started" }] }]
    } });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
    try {
      const tool = el.querySelector('.agent-detail__tool');
      expect(tool?.textContent).toContain("未收到完成回执");
      expect(tool?.textContent).not.toContain("进行中");
      expect(tool?.textContent).not.toContain("正在调用工具");
      expect(tool?.getAttribute('data-status')).toBe("unknown");
      expect(el.querySelector('.agent-detail__working')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

  it("重启后无法确认的回合按失败结算，保留回执证据且不再提供待核对动作", async () => {
    const remote = fakeRemote();
    remote.read = async () => ({ ok: true, value: {
      ...snapshot(),
      conversation: { ...snapshot().conversation, nodeId: "n1" },
      turns: [{
        ...turn(),
        status: "failed",
        stage: "failed",
        target: { canvasId: "cv", nodeId: "n1", mode: "model3d" },
        tools: [{ tool: "validate_canvas_script", status: "started" }],
        receipt: { commandId: "cmd" },
        error: { code: "result-unconfirmed", message: "本机宿主重启后未取得完整执行回执。" },
      }],
      events: [{ sequence: 99, conversationId: "conv-1", turnId: "turn-1", requestId: "req-1", type: "receipt", payload: { status: "failed", reconciled: true }, createdAt: "2026-10-13T00:01:00Z" }]
    } });
    remote.accept = vi.fn(remote.accept);
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={() => undefined} />);
    try {
      expect(el.textContent).toContain("本机宿主重启后未取得完整执行回执");
      expect(el.textContent).not.toContain("系统没有在等待你确认");
      expect(el.textContent).not.toContain("停止此回合");
      expect(el.textContent).not.toContain("核对");
      expect(el.querySelector('.agent-detail__working')).toBeNull();
      expect(remote.accept).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });

  it("重启后无法确认的单目标回合按失败显示，不保留停止入口", async () => {
    const remote = fakeRemote();
    const cancel = vi.fn(async () => ({ ok: true as const, value: { ok: true as const } }));
    remote.cancel = cancel;
    remote.read = async () => ({ ok: true, value: {
      ...snapshot(),
      conversation: { ...snapshot().conversation, nodeId: "n1" },
      turns: [{ ...turn(), status: "failed", stage: "failed", target: { canvasId: "cv", nodeId: "n1", mode: "model3d" }, error: { code: "result-unconfirmed", message: "未收到执行完成回执，结果按失败结算。" } }]
    } });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={() => undefined} />);
    try {
      expect(el.textContent).toContain("未收到执行完成回执，结果按失败结算");
      expect(el.textContent).not.toContain("停止此回合");
      expect(cancel).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });

  it("运行中按间隔刷新快照，收敛已完成后停止轮询并显示助手消息", async () => {
    vi.useFakeTimers();
    try {
      const { navigation } = navStub(DETAIL);
      let settled = false;
      let reads = 0;
      const remote = fakeRemote();
      const runningTools = [{ tool: "get_model_api", status: "started" as const }];
      remote.read = async () => {
        reads += 1;
        const base = snapshot();
        if (!settled) {
          return { ok: true, value: { ...base, turns: [{ ...turn(), tools: runningTools }] } };
        }
        return {
          ok: true,
          value: {
            ...base,
            conversation: { ...base.conversation, status: "succeeded" },
            turns: [{ ...turn(), status: "succeeded", stage: "succeeded", tools: runningTools }],
            messages: [
              {
                messageId: "msg-1",
                conversationId: "conv-1",
                turnId: "turn-1",
                requestId: "req-1",
                role: "assistant",
                content: "助手最终回复",
                truncated: false,
                sequence: 1,
                createdAt: "2026-10-13T00:00:01.000Z"
              }
            ]
          }
        };
      };
      const service = createAgentConversationService({ remote, navigation });
      const { el, root, act } = await mount(
        <AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />
      );
      await act(async () => undefined);
      expect(el.textContent).toContain("执行中");
      // 运行中工具过程即时可见（展开、不折叠）。
      expect(el.querySelector('[role="log"]')?.textContent).toContain("get_model_api");
      expect(el.textContent).toContain("get_model_api");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const firstReads = reads;

      settled = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(reads).toBeGreaterThan(firstReads);
      expect(el.textContent).toContain("作品更新未确认");
      expect(el.textContent).toContain("助手最终回复");
      // 收敛为终态后不再轮询。
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        root.unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("详情内更新的运行中回合优先于已收敛的所点回合", async () => {
    const remote = fakeRemote();
    remote.read = async () => ({
      ok: true,
      value: {
        ...snapshot(),
        turns: [
          { ...turn(), requestId: "req-1", status: "succeeded", stage: "succeeded" },
          { ...turn(), turnId: "turn-2", requestId: "req-2", status: "running", stage: "reasoning" }
        ]
      }
    });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />
    );
    await act(async () => undefined);
    expect(el.textContent).toContain("执行中");
    expect(el.textContent).toContain("思考中");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("AgentConversationPanel · 收起动作语义", () => {
  it.each([true, undefined])("来源仍是当前目标时显示「返回生成面板」（canReturnToSource=%s）", async (canReturnToSource) => {
    const onClose = vi.fn();
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel
        conversationId="conv-1"
        requestId="req-1"
        nodeId="n1"
        service={service}
        onClose={onClose}
        {...(canReturnToSource === undefined ? {} : { canReturnToSource })}
      />
    );
    await act(async () => undefined);
    const back = el.querySelector(".agent-detail__back") as HTMLButtonElement;
    expect(back.textContent).toBe("返回生成面板");
    await act(async () => back.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("选中节点已改变时只是一个关闭按钮", async () => {
    const onClose = vi.fn();
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} canReturnToSource={false} onClose={onClose} />
    );
    await act(async () => undefined);
    const back = el.querySelector(".agent-detail__back") as HTMLButtonElement;
    expect(back.textContent).toBe("关闭");
    await act(async () => back.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("实时来源变化时按钮当场改写（不重挂面板）", async () => {
    let canReturn = true;
    const listeners = new Set<() => void>();
    const returnToSource = {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      canReturn: () => canReturn
    };
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote: fakeRemote(), navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={() => undefined} returnToSource={returnToSource} />
    );
    await act(async () => undefined);
    const back = () => el.querySelector(".agent-detail__back") as HTMLButtonElement;
    expect(back().textContent).toBe("返回生成面板");
    await act(async () => { canReturn = false; listeners.forEach(listener => listener()); });
    expect(back().textContent).toBe("关闭");
    await act(async () => { canReturn = true; listeners.forEach(listener => listener()); });
    expect(back().textContent).toBe("返回生成面板");
    await act(async () => root.unmount());
  });

  it("关闭语义下的失败回合只显示失败摘要，不宣称返回生成面板", async () => {
    const remote = fakeRemote();
    remote.read = async () => ({ ok: true, value: {
      ...snapshot(),
      conversation: { ...snapshot().conversation, nodeId: "n1" },
      turns: [{ ...turn(), status: "failed", stage: "failed", target: { canvasId: "cv", nodeId: "n1", mode: "model3d" }, error: { code: "result-unconfirmed", message: "未收到执行完成回执，结果按失败结算。" } }]
    } });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} canReturnToSource={false} onClose={() => undefined} />
    );
    await act(async () => undefined);
    expect(el.textContent).toContain("未收到执行完成回执，结果按失败结算");
    expect(el.textContent).not.toContain("返回生成面板继续搭建");
    expect(el.textContent).not.toContain("再关闭详情继续搭建");
    await act(async () => root.unmount());
  });
});

describe("AgentConversationPanel · 清空上下文（design D8）", () => {
  it("终态回合时显示入口，二次确认后清空并按 id 归档后收起", async () => {
    const remote = fakeRemote();
    remote.read = async () => ({
      ok: true,
      value: {
        ...snapshot(),
        conversation: { ...snapshot().conversation, nodeId: "n1", status: "succeeded" },
        turns: [{ ...turn(), status: "succeeded", stage: "succeeded" }]
      }
    });
    const clearContext = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, cleared: 1 } }));
    remote.clearContext = clearContext;
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const onClose = vi.fn();
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" nodeId="n1" service={service} onClose={onClose} />
    );
    await act(async () => undefined);

    const entry = el.querySelector(".agent-detail__clear") as HTMLButtonElement | null;
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toBe("清空上下文");
    await act(async () => {
      entry!.click();
    });
    // 第一次点击进入二次确认，不直接清空。
    expect(clearContext).not.toHaveBeenCalled();
    const confirm = el.querySelector(".agent-detail__clear") as HTMLButtonElement;
    expect(confirm.textContent).toBe("确认清空");
    await act(async () => {
      confirm.click();
    });
    expect(clearContext).toHaveBeenCalledWith("cv", "n1");
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("无目标节点时不显示清空入口", async () => {
    const remote = fakeRemote();
    remote.read = async () => ({
      ok: true,
      value: { ...snapshot(), turns: [{ ...turn(), status: "succeeded", stage: "succeeded" }] }
    });
    const { navigation } = navStub(DETAIL);
    const service = createAgentConversationService({ remote, navigation });
    const { el, root, act } = await mount(
      <AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />
    );
    await act(async () => undefined);
    expect(el.querySelector(".agent-detail__clear")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});

it("旧的 DSML 回复明确说明未确认执行，并折叠原始文本", async () => {
  const remote = fakeRemote();
  remote.read = async () => ({ ok: true, value: { ...snapshot(), turns: [{ ...turn(), status: "succeeded" }], messages: [{ messageId: "raw", conversationId: "conv-1", turnId: "turn-1", requestId: "req-1", role: "assistant", content: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="woohaa_get_film_set_clips">', truncated: false, sequence: 1, createdAt: turn().createdAt }] } });
  const service = createAgentConversationService({ remote, navigation: navStub(DETAIL).navigation });
  const { el, root, act } = await mount(<AgentConversationPanel conversationId="conv-1" requestId="req-1" service={service} onClose={() => undefined} />);
  try {
    expect(el.textContent).toContain("不是执行回执");
    expect(el.querySelector(".agent-detail__message details")?.hasAttribute("open")).toBe(false);
  } finally { await act(async () => root.unmount()); el.remove(); }
});
