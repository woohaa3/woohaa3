/** @vitest-environment jsdom */
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { AuthoringMcpButton } from "./model-parameter-panel.js";
import { rememberAssistantPreference } from "./../../services/assistant-execution/selection.js";

// 从主用例文件原样移出（file-budget 拆分）。这一组都是「面板外围」行为：工具栏排布、
// 活动门禁、MCP 指引文案、刷新语义与草稿分区。主文件保留「统一 Agent 创作入口」那组
// 会话选择的用例。夹具与 DOM 生命周期共用 harness。
import {
  el,
  fixture,
  generate,
  input,
  ok,
  render,
  root,
  select,
} from "./authoring-generate-panel-harness.js";

vi.mock("./../../ui/assistant-execution/text-input.js", () => ({
  AssistantTextInput: (props: {
    value: string;
    onChange(value: string): void;
    disabled: boolean;
    showEditor?: boolean;
  }) =>
    props.showEditor === false ? (
      <div data-testid="text-references" />
    ) : (
      <textarea
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    ),
}));
it("参考图在提示词上方，助手、模型和 Variant 收在提示词下方工具栏；切换并提交实际参数", async () => {
  const { props, service } = fixture();
  props.onAuthorize = vi.fn();
  props.sourceSelection!.onRefresh = vi.fn();
  props.renderers = {
    references: () => <div data-testid="references">参考图</div>,
  };
  props.sourceSelection!.connections = [
    {
      connectionId: "c1",
      label: "Codex",
      ready: true,
      models: [
        { id: "model-a", label: "模型 A", reasoningEfforts: ["low", "high"] },
        { id: "model-b", label: "模型 B", reasoningEfforts: ["medium"] },
      ],
    },
  ];
  await render(props);
  const toolbar = el.querySelector(".assistant-toolbar")!;
  const refresh = toolbar.querySelector<HTMLButtonElement>(
    'button[aria-label="刷新助手"]',
  )!;
  const manage = toolbar.querySelector<HTMLButtonElement>(
    'button[aria-label="管理助手"]',
  )!;
  expect(toolbar.querySelectorAll("button")).toHaveLength(5);
  expect(refresh.textContent).toBe("");
  expect(manage.textContent).toBe("");
  await act(async () => {
    refresh.click();
    manage.click();
  });
  expect(props.sourceSelection!.onRefresh).toHaveBeenCalledOnce();
  expect(props.onAuthorize).toHaveBeenCalledOnce();
  expect(service.submitTurn).not.toHaveBeenCalled();
  expect(
    el.querySelector(
      '.authoring-generate__header button[aria-label="复制 MCP 指引"]',
    ),
  ).not.toBeNull();
  expect(
    el.querySelector('.authoring-generate__header [data-testid="references"]'),
  ).not.toBeNull();
  expect(
    el.querySelector(
      '.authoring-generate__actions button[aria-label="复制 MCP 指引"]',
    ),
  ).toBeNull();
  expect(
    el
      .querySelector('[data-testid="references"]')!
      .compareDocumentPosition(el.querySelector("textarea")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    el
      .querySelector("textarea")!
      .compareDocumentPosition(
        el.querySelector('button[aria-label="选择助手"]')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await input("textarea", "改成四层建筑");
  await select("模型", "模型 A");
  expect(el.querySelector('button[aria-label="Variant"]')).toBeNull();
  expect(
    el.querySelectorAll(".assistant-toolbar .mc-panel__model-trigger"),
  ).toHaveLength(2);
  await select("模型", "high");
  await select("模型", "模型 B");
  await select("模型", "medium");
  await select("模型", "模型 A");
  expect(
    el.querySelector('button[aria-label="模型"]')!.textContent,
  ).not.toContain("high");
  await select("模型", "high");
  await act(async () => generate().click());
  expect(vi.mocked(service.submitTurn).mock.calls[0]![0].entry).toMatchObject({
    model: "model-a",
    reasoningEffort: "high",
  });
  await act(async () => root.render(<div />));
  await render(props);
  expect(el.querySelector('button[aria-label="模型"]')!.textContent).toContain(
    "high",
  );
});

it("活动门禁关闭已打开的选择菜单，解除门禁后不自行重开或提交", async () => {
  const { props, service } = fixture();
  await render(props);
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>('button[aria-label="模型"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
  expect(
    document.querySelector('[role="dialog"][aria-label="模型"]'),
  ).not.toBeNull();
  await render({
    ...props,
    sourceSelection: { ...props.sourceSelection!, blockedReason: "正在执行" },
  });
  expect(
    document.querySelector('[role="dialog"][aria-label="模型"]'),
  ).toBeNull();
  expect(
    el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.disabled,
  ).toBe(true);
  await render(props);
  expect(
    document.querySelector('[role="dialog"][aria-label="模型"]'),
  ).toBeNull();
  expect(service.submitTurn).not.toHaveBeenCalled();
});

it("MCP 按钮只复制公开地址和当前目标指引，失败可重试，切换目标清理反馈", async () => {
  const copyText = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(undefined);
  const props = {
    canvasId: "canvas-1",
    nodeId: "film-1",
    isFilmSet: true,
    mcpServerUrl: "https://canvas.example/workspace/mcp/model-canvas",
    copyText,
  };
  await act(async () => root.render(<AuthoringMcpButton {...props} />));
  const button = () => el.querySelector<HTMLButtonElement>("button")!;
  expect(button().textContent).toBe("MCP");
  expect(document.body.textContent).not.toContain("https://canvas.example");
  await act(async () => button().click());
  expect(button().textContent).toContain("复制失败");
  await act(async () => button().click());
  expect(button().textContent).toContain("已复制");
  expect(copyText).toHaveBeenLastCalledWith(
    expect.stringContaining(
      "安装这个 MCP 服务：https://canvas.example/workspace/mcp/model-canvas",
    ),
  );
  expect(copyText.mock.calls.at(-1)![0]).toContain(
    "画布 canvas-1 的节点 film-1片场",
  );
  expect(copyText.mock.calls.at(-1)![0]).toContain("import_model_snapshot");
  await act(async () =>
    root.render(<AuthoringMcpButton {...props} nodeId="film-2" />),
  );
  expect(button().textContent).toBe("MCP");
  await act(async () => button().click());
  expect(copyText.mock.calls.at(-1)![0]).toContain("film-2");
  expect(copyText.mock.calls.at(-1)![0]).not.toContain("film-1");
});

it("text uses assistant selection without a Task directory and accepts another round before the first HTTP response", async () => {
  const f = fixture({ getDataScopeId: () => "text-continuous" });
  f.service.submitTurn = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<AgentConversationService["submitTurn"]>>>(
        () => undefined,
      ),
  );
  const props: AuthoringGenerationProps = {
    ...f.props,
    mode: "text",
    nodeId: "text-node",
    initialPrompt: "legacy prompt",
  };
  props.sourceSelection!.connections[0]!.modelSelection = "explicit";
  props.sourceSelection!.connections[0]!.textDelivery = {
    imageInput: true,
    maxImages: 12,
  };
  rememberAssistantPreference("text-continuous", {
    sourceId: "sdk",
    connectionId: "c1",
    model: "model-a",
  });
  await render(props);
  expect(el.querySelector("textarea")!.value).toBe("");
  await act(async () => {
    generate().click();
  });
  expect(f.service.submitTurn).toHaveBeenCalledTimes(1);
  await input("textarea", "second independent draft");
  expect(generate().disabled).toBe(false);
  await act(async () => {
    generate().click();
  });
  expect(f.service.submitTurn).toHaveBeenCalledTimes(2);
  const requests = vi
    .mocked(f.service.submitTurn)
    .mock.calls.map(([request]) => request);
  expect(requests.map((request) => request.entry)).toMatchObject([
    { mode: "text", prompt: "", model: "model-a" },
    { mode: "text", prompt: "second independent draft", model: "model-a" },
  ]);
  expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
  await act(async () => root.render(<div />));
  await render(props);
  expect(el.querySelector("textarea")!.value).toBe("second independent draft");
  expect(f.service.submitTurn).toHaveBeenCalledTimes(2);
});

it("text keeps drafts on target switches and disables submission in read-only sessions", async () => {
  const { props, service } = fixture({
    getDataScopeId: () => "text-isolation",
  });
  const a = {
    ...props,
    mode: "text" as const,
    nodeId: "text-a",
    initialPrompt: "a",
  };
  await render(a);
  await input("textarea", "a edited");
  await render({ ...a, nodeId: "text-b", initialPrompt: "b" });
  expect(el.querySelector("textarea")!.value).toBe("");
  await render({ ...a, writable: false });
  expect(el.querySelector("textarea")!.value).toBe("a edited");
  expect(generate().disabled).toBe(true);
  expect(service.submitTurn).not.toHaveBeenCalled();
});

it("刷新按钮同时重读模型目录，而不只刷新连接列表", async () => {
  const { props, service } = fixture();
  props.sourceSelection!.onRefresh = vi.fn();
  props.sourceSelection!.connections = [
    { connectionId: "c1", label: "本地 OpenCode", ready: true, models: [] },
  ];
  vi.mocked(service.catalog).mockResolvedValue(
    ok({ models: [{ id: "p/m", label: "M (p)" }] }) as never,
  );
  await render(props);
  await act(async () => undefined);
  expect(service.catalog).toHaveBeenCalledTimes(1);
  const refresh = el.querySelector<HTMLButtonElement>(
    'button[aria-label="刷新助手"]',
  )!;
  await act(async () => {
    refresh.click();
  });
  await act(async () => undefined);
  expect(props.sourceSelection!.onRefresh).toHaveBeenCalledOnce();
  expect(service.catalog).toHaveBeenCalledTimes(2);
  await act(async () => {
    el.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!.click();
  });
  expect(document.body.textContent).toContain("M (p)");
});

it("reports the exact controller draft and restores each film-set clip/item partition without copying or submitting", async () => {
  const { props, service } = fixture();
  const onDraftStateChange = vi.fn();
  const film = { ...props, mode: "film-set" as const, nodeId: "film", clipId: "shot-a", itemId: "object-a", onDraftStateChange };
  await render(film);
  expect(onDraftStateChange).toHaveBeenLastCalledWith({ hasDraft: false, busy: false });
  await input("textarea", "仅修改 A 的动作");
  expect(onDraftStateChange).toHaveBeenLastCalledWith({ hasDraft: true, busy: false });
  await render({ ...film, itemId: "object-b" });
  expect(el.querySelector("textarea")!.value).toBe("");
  expect(onDraftStateChange).toHaveBeenLastCalledWith({ hasDraft: false, busy: false });
  await input("textarea", "仅修改 B 的动作");
  await render({ ...film, clipId: "shot-b" });
  expect(el.querySelector("textarea")!.value).toBe("");
  await render(film);
  expect(el.querySelector("textarea")!.value).toBe("仅修改 A 的动作");
  expect(onDraftStateChange).toHaveBeenLastCalledWith({ hasDraft: true, busy: false });
  expect(service.submitTurn).not.toHaveBeenCalled();
});
