/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import type { AgentConversationService, AgentConversationSnapshotView } from "../../contract/agent-conversation.js";
import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";

vi.mock("../../ui/assistant-execution/text-input.js", () => ({
  AssistantTextInput: () => <textarea />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
const catalogMetadata = {
  authState: "ready" as const,
  capabilities: { discussion: true, targets: ["model3d"] as const, tools: true, models: "remote" as const },
};
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

function fixture(catalog: AgentConversationService["catalog"], toolDefault = false): AuthoringGenerationProps {
  const snapshot: AgentConversationSnapshotView = {
    active: null, conversations: [], detail: null, loading: false,
    error: null, mcp: null, contextRevision: 0,
  };
  const service = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    catalog,
    readConversation: async () => ({ ok: false, code: "not-found", error: "no history" }),
  } as unknown as AgentConversationService;
  return {
    canvasId: "canvas", nodeId: "model", mode: "model3d", writable: true,
    sourceSelection: {
      sources: [{ sourceId: "sdk", label: "API" }],
      selectedSourceId: "sdk", selectedConnectionId: "connection",
      connections: [{
        connectionId: "connection", label: "助手", ready: true, models: [],
        modelSelection: toolDefault ? "tool-default" : "explicit",
      }],
      onSelectSource: vi.fn(), onSelectConnection: vi.fn(),
    },
    agentConversation: { service, onOpenDetail: vi.fn() },
  };
}

function selector() {
  expect(el.querySelector('input[aria-label="模型 ID"]')).toBeNull();
  const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="模型"]');
  expect(trigger).not.toBeNull();
  expect(trigger!.getAttribute("aria-haspopup")).toBe("dialog");
  return trigger!;
}
async function open() {
  await act(async () => selector().click());
}

describe("创作助手模型选择回归", () => {
  it("目录加载中保留下拉，加载成功后可选择真实模型", async () => {
    let resolve!: (result: Awaited<ReturnType<NonNullable<AgentConversationService["catalog"]>>>) => void;
    const catalog = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<AgentConversationService["catalog"]>>>>(done => { resolve = done; }));
    await act(async () => root.render(<AuthoringGeneratePanel {...fixture(catalog)} />));
    expect(selector().textContent).toContain("正在读取模型");
    await open();
    expect(document.querySelector<HTMLButtonElement>('.assistant-model-panel__option')!.disabled).toBe(true);
    await act(async () => resolve({ ok: true, value: { ...catalogMetadata, models: [{ id: "model-a", label: "模型 A" }] } }));
    const option = document.querySelector<HTMLButtonElement>('.assistant-model-panel__option[aria-label="模型 A"]');
    expect(option).not.toBeNull();
    await act(async () => option!.click());
    expect(selector().textContent).toContain("模型 A");
    expect(option!.getAttribute("data-state")).toBe("on");
    expect(catalog).toHaveBeenCalledOnce();
  });

  it.each([false, true])("空目录保持下拉并保留工具默认语义（toolDefault=%s）", async toolDefault => {
    const catalog = vi.fn(async () => ({ ok: true as const, value: { ...catalogMetadata, models: [] } }));
    await act(async () => root.render(<AuthoringGeneratePanel {...fixture(catalog, toolDefault)} />));
    expect(selector().textContent).toContain(toolDefault ? "跟随工具设置" : "暂无可用模型");
    await open();
    const option = document.querySelector<HTMLButtonElement>('.assistant-model-panel__option')!;
    expect(option.disabled).toBe(!toolDefault);
  });

  it("目录读取失败保留下拉与错误提示，连接目录恢复后可以选择", async () => {
    const catalog = vi.fn(async () => ({ ok: false as const, code: "unavailable", error: "模型服务暂时不可用" }));
    const props = fixture(catalog);
    await act(async () => root.render(<AuthoringGeneratePanel {...props} />));
    expect(selector().textContent).toContain("模型读取失败");
    expect(el.textContent).toContain("模型服务暂时不可用");
    await act(async () => root.render(<AuthoringGeneratePanel {...props} sourceSelection={{
      ...props.sourceSelection!,
      connections: [{ connectionId: "connection", label: "助手", ready: true,
        modelSelection: "explicit", models: [{ id: "recovered", label: "恢复后的模型" }] }],
    }} />));
    await open();
    await act(async () => document.querySelector<HTMLButtonElement>('.assistant-model-panel__option[aria-label="恢复后的模型"]')!.click());
    expect(selector().textContent).toContain("恢复后的模型");
  });
});
