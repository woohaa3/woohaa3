/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import type {
  AgentConversationService,
  AgentConversationSnapshotView,
} from "../../contract/agent-conversation.js";
import { AuthoringMcpButton } from "./model-parameter-panel.js";
import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";
import { rememberAssistantPreference } from "../../services/assistant-execution/selection.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  localStorage.clear();
});
const ok = <T,>(value: T) => ({ ok: true as const, value });
function fixture(overrides: Partial<AgentConversationService> = {}) {
  const snapshot: AgentConversationSnapshotView = {
    active: null,
    conversations: [],
    detail: null,
    loading: false,
    error: null,
    mcp: null,
    contextRevision: 0,
  };
  const service = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    catalog: vi.fn(async () => ok({ models: [] })),
    readConversation: vi.fn(async () => ({ ok: false as const, code: "not-found", error: "no history" })),
    submitTurn: vi.fn(async (input) =>
      ok({ conversationId: "conversation", requestId: input.requestId }),
    ),
    ...overrides,
  } as unknown as AgentConversationService;
  const props: AuthoringGenerationProps = {
    canvasId: "canvas",
    nodeId: "model",
    mode: "model3d",
    writable: true,
    sourceSelection: {
      sources: [
        { sourceId: "sdk", label: "API" },
        { sourceId: "local", label: "本机" },
      ],
      selectedSourceId: "sdk",
      selectedConnectionId: "c1",
      connections: [
        {
          connectionId: "c1",
          label: "我的连接",
          ready: true,
          models: [{ id: "model-a", label: "模型 A" }],
        },
      ],
      onSelectSource: vi.fn(),
      onSelectConnection: vi.fn(),
    },
    agentConversation: { service, onOpenDetail: vi.fn() },
  };
  return { props, service, snapshot };
}
async function render(props: AuthoringGenerationProps) {
  await act(async () => root.render(<AuthoringGeneratePanel {...props} />));
}
async function input(selector: string, value: string) {
  const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  )!;
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, text: string) {
  await act(async () => {
    const trigger = el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
  });
  // 模型与 Variant 在同一个参数面板里横向排开（不再逐项单行下拉）。
  const option = [...document.querySelectorAll<HTMLButtonElement>(".assistant-model-panel__option")]
    .find(option => option.getAttribute("aria-label") === text);
  expect(option, document.body.textContent ?? "").toBeDefined();
  await act(async () => { option!.click(); });
  // Radix restores trigger focus on the next task after closing a popup.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const generate = () =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "生成",
  )!;

describe("统一 Agent 创作入口", () => {
  it("新面板继承全局模型与 Variant，已有会话优先恢复自己的选择", async () => {
    rememberAssistantPreference("owner", { sourceId: "sdk", connectionId: "c1", model: "model-a", reasoningEffort: "high" });
    const { props, service } = fixture({ getDataScopeId: () => "owner" });
    props.sourceSelection!.connections[0]!.models = [{ id: "model-a", label: "模型 A", reasoningEfforts: ["high"] }, { id: "model-b", label: "模型 B", reasoningEfforts: ["low"] }];
    await render(props);
    expect(el.querySelector('button[aria-label="模型"]')?.textContent).toContain("模型 A");
    expect(el.querySelector('button[aria-label="模型"]')?.textContent).toContain("high");
    service.readConversation = vi.fn(async () => ok({ conversation: { connectionId: "c1" }, turns: [{ target: { model: "model-b", reasoningEffort: "low" } }] } as never));
    await render({ ...props, nodeId: "existing", agentConversation: { ...props.agentConversation!, conversationId: "previous" } });
    expect(el.querySelector('button[aria-label="模型"]')?.textContent).toContain("模型 B");
    expect(el.querySelector('button[aria-label="模型"]')?.textContent).toContain("low");
    expect(service.submitTurn).not.toHaveBeenCalled();
  });
  it("转换使用同一面板展示本次冻结输入，停止只调用领域操作，完成后原位恢复编辑", async () => {
    const execution = { canvasId: "canvas", targetNodeId: "model", conversationId: "conversion", turnRequestId: "conversion-request" };
    const queryTurn = vi.fn(async () => ok({
      conversation: { conversationId: "conversion", connectionId: "c2", adapterId: "local" },
      turn: { turnId: "conversion-turn", requestId: execution.turnRequestId, target: { canvasId: "canvas", nodeId: "model", connectionId: "c2", model: "model-b", reasoningEffort: "high" } },
      snapshot: { messages: [
        { turnId: "older-turn", role: "user", content: "不能显示别的请求" },
        { turnId: "conversion-turn", role: "user", content: "将照片变成花园片场" }
      ] }
    }));
    const { props, service } = fixture({ queryTurn: queryTurn as unknown as AgentConversationService["queryTurn"] });
    const cancel = vi.fn(async () => ({ ok: true }));
    const query = vi.fn(async () => ({ ok: true }));
    const delivery = { execution, status: "running" as const, stage: "分析内容", query, cancel };
    const panelProps = { ...props, mode: "film-set" as const, renderers: { references: () => <span>参考素材</span> }, sourceSelection: { ...props.sourceSelection!, connections: [...props.sourceSelection!.connections,
      { connectionId: "c2", label: "本机助手", ready: true, models: [{ id: "model-b", label: "视觉模型", reasoningEfforts: ["high" as const] }] }] } };
    await render({ ...panelProps, deliveryHistory: delivery });
    const panel = el.querySelector('[data-testid="authoring-generate"]');
    const field = el.querySelector("textarea")!;
    expect(field.value).toBe("将照片变成花园片场");
    expect(field.disabled).toBe(true);
    expect(el.querySelector('button[aria-label="选择助手"]')?.textContent).toContain("本机助手");
    expect(el.querySelector('button[aria-label="模型"]')?.textContent).toContain("视觉模型 · high");
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')?.disabled).toBe(true);
    expect(el.textContent).toContain("参考素材");
    expect(el.querySelector(".authoring-generate__header")?.textContent).toContain("MCP");
    expect(el.textContent).not.toContain("核对原请求");
    expect(el.querySelector(".assistant-execution-status")).toBeNull();
    expect(el.querySelector(".authoring-generate__delivery")).toBeNull();
    expect(el.textContent).not.toContain("分析内容");
    expect(el.querySelectorAll(".mc-panel")).toHaveLength(1);
    expect(queryTurn).toHaveBeenCalledWith("conversion-request");
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    await act(async () => { [...el.querySelectorAll("button")].find(button => button.textContent === "停止")!.click(); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(service.submitTurn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    await render({ ...panelProps, deliveryHistory: { ...delivery, status: "succeeded", stage: "片场已创建", cancel: undefined } });
    expect(el.querySelector('[data-testid="authoring-generate"]')).toBe(panel);
    expect(el.querySelector("textarea")).toBe(field);
    expect(field.disabled).toBe(false);
    await input("textarea", "继续修改花园");
    expect(field.value).toBe("继续修改花园");
  });

  it("失败重试走原转换请求，未知结果才提供查询，不提交普通创作", async () => {
    const { props, service } = fixture();
    const retry = vi.fn(async () => ({ ok: true }));
    const query = vi.fn(async () => ({ ok: true }));
    await render({ ...props, mode: "film-set", deliveryHistory: { status: "failed", stage: "创建失败", reason: "候选未通过校验", retry, query } });
    expect(el.querySelector("textarea")?.disabled).toBe(true);
    expect(el.textContent).toContain("候选未通过校验");
    await act(async () => { [...el.querySelectorAll("button")].find(button => button.textContent === "重试")!.click(); });
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...props, mode: "film-set", deliveryHistory: { status: "unknown", stage: "正在确认结果", query } });
    await act(async () => { [...el.querySelectorAll("button")].find(button => button.textContent === "查询结果")!.click(); });
    expect(query).toHaveBeenCalledOnce();
    expect(service.submitTurn).not.toHaveBeenCalled();
  });

  it("切换转换请求不显示前一次输入，迟到查询也不覆盖当前回合", async () => {
    let resolveLate: (value: unknown) => void = () => undefined;
    const response = (requestId: string, prompt: string) => ok({
      conversation: { conversationId: "conversion", connectionId: "c1", adapterId: "sdk" },
      turn: { turnId: requestId, requestId, target: { canvasId: "canvas", nodeId: "model", connectionId: "c1" } },
      snapshot: { messages: [{ turnId: requestId, role: "user", content: prompt }] }
    });
    const queryTurn = vi.fn((requestId: string) => requestId === "old" ? new Promise(resolve => { resolveLate = resolve; }) : Promise.resolve(response(requestId, "当前转换")));
    const { props, service } = fixture({ queryTurn: queryTurn as unknown as AgentConversationService["queryTurn"] });
    const delivery = (turnRequestId: string) => ({ status: "running" as const, stage: "分析内容", query: async () => ({ ok: true }),
      execution: { canvasId: "canvas", targetNodeId: "model", conversationId: "conversion", turnRequestId } });
    await render({ ...props, deliveryHistory: delivery("old") });
    await render({ ...props, deliveryHistory: delivery("current") });
    expect(el.querySelector("textarea")!.value).toBe("当前转换");
    await act(async () => { resolveLate(response("old", "迟到的旧输入")); });
    expect(el.querySelector("textarea")!.value).toBe("当前转换");
    expect(service.submitTurn).not.toHaveBeenCalled();
  });

  it("完成后保持编辑与工具栏对话入口，不另加底部状态区", async () => {
    const { props, service } = fixture();
    await render({ ...props, mode: "film-set", clipId: "default-clip", deliveryHistory: { status: "succeeded", stage: "Completed", query: async () => ({ ok: true }),
      execution: { canvasId: "canvas", targetNodeId: "model", conversationId: "conversion", turnRequestId: "old-request" } } });
    await input("textarea", "Continue editing");
    expect(el.querySelector("textarea")!.disabled).toBe(false);
    expect(el.querySelector(".assistant-execution-status")).toBeNull();
    expect(el.textContent).not.toContain("Completed");
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-testid="authoring-generate-detail"]')!.click(); });
    expect(props.agentConversation!.onOpenDetail).toHaveBeenCalledWith({ conversationId: "conversion", requestId: "old-request", nodeId: "model" });
    expect(el.querySelector("textarea")!.value).toBe("Continue editing");
    expect(service.submitTurn).not.toHaveBeenCalled();
  });
  it("does not submit ordinary edits through a candidate-only connection", async () => {
    const submitTurn = vi.fn();
    const { props } = fixture({ submitTurn });
    const connection = props.sourceSelection!.connections[0]!;
    await render({ ...props, sourceSelection: { ...props.sourceSelection!, connections: [{ ...connection, ready: false, reason: "此连接不支持作品修改，请选择其他助手" }] } });
    await input("textarea", "Modify the scene");
    await act(async () => { el.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    expect(el.textContent).toContain("此连接不支持作品修改");
    expect(submitTurn).not.toHaveBeenCalled();
  });
  it("切换来源和连接保留草稿，目录只包含当前连接的模型", async () => {
    const { props, service } = fixture();
    await render(props);
    await input("textarea", "生成台灯");
    await select("模型", "模型 A");
    await render({
      ...props,
      sourceSelection: {
        ...props.sourceSelection!,
        selectedSourceId: "local",
        selectedConnectionId: "c2",
        connections: [
          {
            connectionId: "c2",
            label: "本机连接",
            ready: true,
            models: [{ id: "model-b", label: "模型 B" }],
          },
        ],
      },
    });
    expect(el.querySelector("textarea")!.value).toBe("生成台灯");
      await act(async () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const options = document.querySelector(
      '[role="dialog"][aria-label="模型"]',
    )!.textContent;
    expect(options).toContain("模型 B");
    expect(options).not.toContain("模型 A");
    expect(service.catalog).not.toHaveBeenCalled();
  });

  it("连接没有内联模型时读取来源目录，不把空列表当成默认模型", async () => {
    const { props } = fixture();
    const catalog = vi.fn(async () =>
      ok({
        models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }],
        authState: "disconnected" as const,
        capabilities: {
          discussion: true,
          targets: ["model3d"] as const,
          tools: true,
          models: "remote" as const,
        },
      }),
    );
    await render({
      ...props,
      sourceSelection: {
        ...props.sourceSelection!,
        selectedSourceId: "local",
        selectedConnectionId: "c1",
        connections: [
          {
            connectionId: "c1",
            label: "Codex App Server",
            ready: false,
            modelSelection: "tool-default",
            models: [],
            reason: "尚未确认本机 Codex 配置或账号；执行时会启动专用进程并核对",
          },
        ],
      },
      agentConversation: {
        ...props.agentConversation!,
        service: {
          ...props.agentConversation!.service,
          catalog,
        } as unknown as AgentConversationService,
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(catalog).toHaveBeenCalledWith("local");
    expect(el.textContent).not.toContain("尚未确认本机 Codex");
      await act(async () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(
      document.querySelector('[role="dialog"][aria-label="模型"]')!.textContent,
    ).toContain("GPT-6.1-Sol");
  });

  it("返回面板恢复当前目标草稿，其他目标不串草稿", async () => {
    const { props } = fixture();
    await render(props);
    await input("textarea", "草稿内容");
    await act(async () => root.render(<div />));
    await render(props);
    expect(el.querySelector("textarea")!.value).toBe("草稿内容");
    await act(async () => root.render(<div />));
    await render({ ...props, nodeId: "another" });
    expect(el.querySelector("textarea")!.value).toBe("");
  });

  it("失败重试保持请求身份，修改内容和成功后的新提交使用新的身份", async () => {
    const submitTurn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "network", error: "连接中断" })
      .mockImplementation(async (input) =>
        ok({ conversationId: "conversation", requestId: input.requestId }),
      );
    const { props } = fixture({ submitTurn });
    await render(props);
    await input("textarea", "生成台灯");
    await act(async () => generate().click());
    await act(async () => generate().click());
    expect(submitTurn.mock.calls[0][0].requestId).toBe(
      submitTurn.mock.calls[1][0].requestId,
    );
    await input("textarea", "生成台灯");
    await act(async () => generate().click());
    expect(submitTurn.mock.calls[2][0].requestId).not.toBe(
      submitTurn.mock.calls[1][0].requestId,
    );
    await input("textarea", "生成木桌");
    await act(async () => generate().click());
    expect(submitTurn.mock.calls[3][0].entry.prompt).toBe("生成木桌");
    expect(submitTurn.mock.calls[3][0].requestId).not.toBe(
      submitTurn.mock.calls[2][0].requestId,
    );
  });

  it("重复点击只提交一次，镜头请求保留目标与所选模型", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const submitTurn = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ) as unknown as AgentConversationService["submitTurn"];
    const { props } = fixture({ submitTurn });
    await render({
      ...props,
      mode: "camera",
      selectedCameraId: "cam1",
      clipId: "clip1",
      expectedContentHash: "hash",
    });
    await input("textarea", "缓慢环绕");
    await select("模型", "模型 A");
    const button = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent === "调整镜头",
    )!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTurn).mock.calls[0][0].entry).toMatchObject({
      action: "modify",
      cameraId: "cam1",
      clipId: "clip1",
      model: "model-a",
      expectedContentHash: "hash",
    });
    await act(async () =>
      resolve(ok({ conversationId: "conversation", requestId: "request" })),
    );
  });

  it("未选连接时不能生成，配置入口可用并保留输入", async () => {
    const { props, service } = fixture();
    const configure = vi.fn();
    for (const connections of [[], props.sourceSelection!.connections]) {
      await render({ ...props, sourceSelection: { ...props.sourceSelection!, loading: true, connections } });
      const selector = el.querySelector<HTMLButtonElement>('button[aria-label="选择助手"]')!;
      expect(selector.textContent).toContain("正在读取助手…");
      expect(selector.disabled).toBe(true);
      expect(el.querySelector("p.authoring-generate__hint")).toBeNull();
    }
    await render({
      ...props,
      onAuthorize: configure,
      sourceSelection: {
        ...props.sourceSelection!,
        selectedConnectionId: null,
        connections: [],
      },
    });
    await input("textarea", "先记录构思");
    expect(generate().disabled).toBe(true);
    expect(el.textContent).not.toContain("Ctrl / ⌘ + Enter");
    expect(el.querySelector('[data-testid="authoring-generate-empty"]')).not.toBeNull();
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>("button")]
        .find((entry) => entry.textContent === "配置助手")!
        .click(),
    );
    expect(configure).toHaveBeenCalledOnce();
    expect(service.submitTurn).not.toHaveBeenCalled();
    expect(el.querySelector("textarea")!.value).toBe("先记录构思");
  });

  it("对象缺少片段、只读或缺少工具时均阻止提交", async () => {
    const { props, service } = fixture();
    for (const patch of [
      { mode: "film-set" as const, itemId: "item" },
      { writable: false, disabledReason: "只读" },
      {
        mcpHint: {
          label: "MCP",
          text: "MCP",
          serverUrl: "/mcp",
          blockedReason: "工具不可用",
        },
      },
    ]) {
      await render({ ...props, ...patch });
      await input("textarea", "修改对象");
      expect(generate().disabled).toBe(true);
    }
    expect(service.submitTurn).not.toHaveBeenCalled();
  });

  it("提交成功只进入执行中状态，不自动展开对话详情", async () => {
    const { props, snapshot } = fixture();
    const listeners = new Set<() => void>();
    let current = { ...snapshot };
    const service = {
      ...(props.agentConversation!.service as unknown as Record<string, unknown>),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getSnapshot: () => current,
      submitTurn: vi.fn(async (input: any) => {
        current = {
          ...current,
          active: {
            conversationId: "conversation",
            requestId: input.requestId,
            turn: {
              turnId: "turn",
              conversationId: "conversation",
              requestId: input.requestId,
              action: "generate" as const,
              status: "running" as const,
              stage: "running",
              target: { canvasId: "canvas", nodeId: "model", connectionId: "c1" },
              tools: [],
              createdAt: "2026-10-18T00:00:00.000Z",
              updatedAt: "2026-10-18T00:00:00.000Z",
            },
          },
        };
        for (const listener of listeners) listener();
        return ok({ conversationId: "conversation", requestId: input.requestId });
      }),
    } as unknown as AgentConversationService;
    await render({ ...props, agentConversation: { ...props.agentConversation!, service } });
    await input("textarea", "生成台灯");
    await act(async () => generate().click());
    const primary = () => el.querySelector<HTMLButtonElement>(".assistant-toolbar__submit .ui-button--primary")!;
    // 侧栏（详情 route）不由提交触发；主操作自己表达执行中。
    expect(props.agentConversation!.onOpenDetail).not.toHaveBeenCalled();
    expect(primary().textContent).toBe("执行中");
    expect(primary().disabled).toBe(true);
    // 详情仍可就近展开，主工具栏固定保留五个调用控件。
    const detailEntry = el.querySelector<HTMLButtonElement>('[data-testid="authoring-generate-detail"]')!;
    expect(detailEntry.textContent).toBe("查看执行与对话");
    expect(detailEntry.getAttribute("title")).toBe("执行中");
  });

  it("打开既往会话只读导航，不触发生成", async () => {
    const { props, service } = fixture();
    await render({
      ...props,
      agentConversation: {
        ...props.agentConversation!,
        conversationId: "past",
        latestRequestId: "past-request",
      },
    });
    const button = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent === "对话详情",
    )!;
    // 详情入口在生成按钮左侧的同一工具栏里，不额外占一行状态区。
    expect(button.closest(".authoring-generate__actions")).not.toBeNull();
    expect(el.querySelector(".authoring-generate__session")).toBeNull();
    await act(async () => button.click());
    expect(props.agentConversation!.onOpenDetail).toHaveBeenCalledWith({
      conversationId: "past",
      requestId: "past-request",
      nodeId: "model",
    });
    expect(service.submitTurn).not.toHaveBeenCalled();
  });
});


it("参考图在提示词上方，助手、模型和 Variant 收在提示词下方工具栏；切换并提交实际参数", async () => {
  const { props, service } = fixture();
  props.onAuthorize = vi.fn();
  props.sourceSelection!.onRefresh = vi.fn();
  props.renderers = { references: () => <div data-testid="references">参考图</div> };
  props.sourceSelection!.connections = [{ connectionId: "c1", label: "Codex", ready: true, models: [
    { id: "model-a", label: "模型 A", reasoningEfforts: ["low", "high"] },
    { id: "model-b", label: "模型 B", reasoningEfforts: ["medium"] }
  ] }];
  await render(props);
  const toolbar = el.querySelector('.assistant-toolbar')!;
  const refresh = toolbar.querySelector<HTMLButtonElement>('button[aria-label="刷新助手"]')!;
  const manage = toolbar.querySelector<HTMLButtonElement>('button[aria-label="管理助手"]')!;
  expect(toolbar.querySelectorAll('button')).toHaveLength(5);
  expect(refresh.textContent).toBe("");
  expect(manage.textContent).toBe("");
  await act(async () => { refresh.click(); manage.click(); });
  expect(props.sourceSelection!.onRefresh).toHaveBeenCalledOnce();
  expect(props.onAuthorize).toHaveBeenCalledOnce();
  expect(service.submitTurn).not.toHaveBeenCalled();
  expect(el.querySelector('.authoring-generate__header button[aria-label="复制 MCP 指引"]')).not.toBeNull();
  expect(el.querySelector('.authoring-generate__header [data-testid="references"]')).not.toBeNull();
  expect(el.querySelector('.authoring-generate__actions button[aria-label="复制 MCP 指引"]')).toBeNull();
  expect(el.querySelector('[data-testid="references"]')!.compareDocumentPosition(el.querySelector("textarea")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(el.querySelector("textarea")!.compareDocumentPosition(el.querySelector('button[aria-label="选择助手"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await input("textarea", "改成四层建筑");
  await select("模型", "模型 A");
  expect(el.querySelector('button[aria-label="Variant"]')).toBeNull();
  expect(el.querySelectorAll(".assistant-toolbar .mc-panel__model-trigger")).toHaveLength(2);
  await select("模型", "high");
  await select("模型", "模型 B");
  await select("模型", "medium");
  await select("模型", "模型 A");
  expect(el.querySelector('button[aria-label="模型"]')!.textContent).not.toContain("high");
  await select("模型", "high");
  await act(async () => generate().click());
  expect(vi.mocked(service.submitTurn).mock.calls[0]![0].entry).toMatchObject({ model: "model-a", reasoningEffort: "high" });
  await act(async () => root.render(<div />));
  await render(props);
  expect(el.querySelector('button[aria-label="模型"]')!.textContent).toContain("high");
});

it("活动门禁关闭已打开的选择菜单，解除门禁后不自行重开或提交", async () => {
  const { props, service } = fixture();
  await render(props);
  await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.querySelector('[role="dialog"][aria-label="模型"]')).not.toBeNull();
  await render({ ...props, sourceSelection: { ...props.sourceSelection!, blockedReason: "正在执行" } });
  expect(document.querySelector('[role="dialog"][aria-label="模型"]')).toBeNull();
  expect(el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.disabled).toBe(true);
  await render(props);
  expect(document.querySelector('[role="dialog"][aria-label="模型"]')).toBeNull();
  expect(service.submitTurn).not.toHaveBeenCalled();
});


it("MCP 按钮只复制公开地址和当前目标指引，失败可重试，切换目标清理反馈", async () => {
  const copyText = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(undefined);
  const props = { canvasId: "canvas-1", nodeId: "film-1", isFilmSet: true, mcpServerUrl: "https://canvas.example/workspace/mcp/model-canvas", copyText };
  await act(async () => root.render(<AuthoringMcpButton {...props} />));
  const button = () => el.querySelector<HTMLButtonElement>("button")!;
  expect(button().textContent).toBe("MCP");
  expect(document.body.textContent).not.toContain("https://canvas.example");
  await act(async () => button().click());
  expect(button().textContent).toContain("复制失败");
  await act(async () => button().click());
  expect(button().textContent).toContain("已复制");
  expect(copyText).toHaveBeenLastCalledWith(expect.stringContaining("安装这个 MCP 服务：https://canvas.example/workspace/mcp/model-canvas"));
  expect(copyText.mock.calls.at(-1)![0]).toContain("画布 canvas-1 的节点 film-1片场");
  expect(copyText.mock.calls.at(-1)![0]).toContain("import_model_snapshot");
  await act(async () => root.render(<AuthoringMcpButton {...props} nodeId="film-2" />));
  expect(button().textContent).toBe("MCP");
  await act(async () => button().click());
  expect(copyText.mock.calls.at(-1)![0]).toContain("film-2");
  expect(copyText.mock.calls.at(-1)![0]).not.toContain("film-1");
});
