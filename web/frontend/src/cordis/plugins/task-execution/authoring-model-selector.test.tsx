/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";
import { supplyAuthoringDirectory } from "./test-support/authoring-directory.js";
vi.mock("../../ui/assistant-execution/text-input.js", () => ({ AssistantTextInput: () => <textarea /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let el: HTMLDivElement;
beforeEach(() => { el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { await act(async () => root.unmount()); el.remove(); localStorage.clear(); });
function fixture(catalog: AgentConversationService["catalog"], toolDefault = false): AuthoringGenerationProps {
  const snapshot = { active: null, conversations: [], detail: null, loading: false, error: null, mcp: null, contextRevision: 0 };
  return { canvasId: "canvas", nodeId: "model", mode: "model3d", writable: true,
    sourceSelection: { sources: [{ sourceId: "sdk", label: "API" }], selectedSourceId: "sdk", selectedConnectionId: "connection",
      connections: [{ connectionId: "connection", label: "助手", ready: true, models: [], modelSelection: toolDefault ? "tool-default" : "explicit" }], onSelectSource: vi.fn(), onSelectConnection: vi.fn() },
    agentConversation: { service: { subscribe: () => () => undefined, getSnapshot: () => snapshot, catalog,
      readConversation: async () => ({ ok: false, code: "not-found", error: "no history" }), submitTurn: vi.fn() } as unknown as AgentConversationService, onOpenDetail: vi.fn() } };
}
async function mount(props: AuthoringGenerationProps) { supplyAuthoringDirectory(props); await act(async () => root.render(<AuthoringGeneratePanel {...props} />)); }
async function open() { await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="来源与模型"]')!.click()); }
it("loading is incomplete; selecting a loaded model atomically preserves the connection without inference", async () => {
  let resolve!: (value: any) => void;
  const props = fixture(vi.fn(() => new Promise<Awaited<ReturnType<AgentConversationService["catalog"]>>>(done => { resolve = done; })));
  await mount(props); await open(); expect(document.body.textContent).toContain("部分来源尚未完整读取");
  await act(async () => resolve({ ok: true, value: { models: [{ id: "model-a", label: "模型 A" }] } }));
  await act(async () => document.querySelector<HTMLButtonElement>('.generation-directory__model')!.click());
  expect(el.querySelector('button[aria-label="来源与模型"]')?.textContent).toContain("模型 A");
  expect(props.sourceSelection!.onSelectConnection).not.toHaveBeenCalled(); expect(props.agentConversation!.service.submitTurn).not.toHaveBeenCalled();
});
it.each([false, true])("empty catalog exposes a default only when the owner allows it (%s)", async toolDefault => {
  await mount(fixture(vi.fn(async () => ({ ok: true, value: { models: [] } } as never)), toolDefault)); await open();
  expect(document.querySelectorAll('.generation-directory__model')).toHaveLength(toolDefault ? 1 : 0);
  if (toolDefault) expect(document.querySelector('.generation-directory__model')?.textContent).toContain("使用助手默认模型");
  expect(document.querySelector('input[aria-label="模型 ID"]')).toBeNull();
});
it("failed source has local retry and a recovered model becomes selectable", async () => {
  const catalog = vi.fn().mockResolvedValueOnce({ ok: false, code: "unavailable", error: "模型服务暂时不可用" }).mockResolvedValue({ ok: true, value: { models: [{ id: "recovered", label: "恢复后的模型" }] } });
  await mount(fixture(catalog)); await open(); expect(document.body.textContent).toContain("模型服务暂时不可用");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === "重试")!.click());
  expect(catalog).toHaveBeenCalledTimes(2); expect(document.querySelector('.generation-directory__model')?.textContent).toContain("恢复后的模型");
});
it.each(["opencode-server", "codex-appserver"])("keeps ready %s models and the native default selectable despite deferred account-check information", async adapterId => {
  const props = fixture(vi.fn(async () => ({ ok: true, value: { models: [{ id: "native/model", label: "本地真实模型" }] } } as never)), true);
  props.sourceSelection!.selectedSourceId = adapterId;
  props.sourceSelection!.sources = [{ sourceId: adapterId, label: "本地" }];
  props.sourceSelection!.connections = [{ ...props.sourceSelection!.connections[0]!, reason: "尚未确认本机工具配置或账号；执行时会启动专用进程并核对" }];
  await mount(props); await open();
  const options = [...document.querySelectorAll<HTMLButtonElement>('.generation-directory__model')];
  expect(options).toHaveLength(2);
  expect(options.every(option => !option.disabled)).toBe(true);
  await act(async () => options.find(option => option.textContent?.includes("本地真实模型"))!.click());
  expect(el.querySelector('button[aria-label="来源与模型"]')?.textContent).toContain("本地真实模型");
  expect(props.agentConversation!.service.submitTurn).not.toHaveBeenCalled();
});
it("keeps genuinely unavailable owner connections disabled with their actual reason", async () => {
  const props = fixture(vi.fn(async () => ({ ok: true, value: { models: [{ id: "model", label: "模型" }] } } as never)));
  props.sourceSelection!.connections = [{ ...props.sourceSelection!.connections[0]!, ready: false, reason: "此连接不支持当前用途" }];
  await mount(props); await open();
  const option = document.querySelector<HTMLButtonElement>('.generation-directory__model')!;
  expect(option.disabled).toBe(true); expect(option.textContent).toContain("此连接不支持当前用途");
  expect(props.agentConversation!.service.submitTurn).not.toHaveBeenCalled();
});
it("explains an unsupported effort reset and restores the original model's independent draft", async () => {
  const props = fixture(vi.fn(async () => ({ ok: true, value: { models: [{ id: "a", label: "模型 A", reasoningEfforts: ["low"] }, { id: "b", label: "模型 B", reasoningEfforts: ["high"] }] } } as never)));
  await mount(props);
  const choose = async (label: string) => {
    const parameters = el.querySelector<HTMLButtonElement>('button[aria-label="生成参数"]');
    if (parameters?.getAttribute("aria-expanded") === "true") await act(async () => parameters.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await open();
    const option = [...document.querySelectorAll<HTMLButtonElement>('.generation-directory__model')].find(b => b.textContent?.includes(label));
    expect(option, document.body.textContent ?? "").toBeDefined();
    await act(async () => option!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  await choose("模型 A");
  await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="生成参数"]')!.click());
  const low = [...document.querySelectorAll<HTMLButtonElement>('.generation-parameters button')].find(option => option.textContent === "低");
  expect(low, document.body.innerHTML).toBeDefined();
  await act(async () => low!.click());
  await choose("模型 B"); expect(el.textContent).toContain("新模型不支持原思考强度，已恢复默认");
  await choose("模型 A"); expect(el.querySelector('button[aria-label="生成参数"]')?.textContent).toContain("低");
  expect(props.agentConversation!.service.submitTurn).not.toHaveBeenCalled();
});
