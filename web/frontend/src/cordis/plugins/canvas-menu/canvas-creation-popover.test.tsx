/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiProvider } from "../../../shared/ui/UiProvider.js";
import CanvasCreationPopover from "./canvas-creation-popover.js";
import { creationDraft } from "./canvas-creation-drafts.js";
import { agentDirectory } from "../../services/agent-directory.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";

const mocks = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock("../../react.js", () => ({ useService: (key: string) => mocks.services[key] }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
let canvasId: string;
let request: ReturnType<typeof vi.fn>;
let locate: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let transport: any;
beforeEach(() => {
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  canvasId = "canvas"; request = vi.fn(); locate = vi.fn(); select = vi.fn(); close = vi.fn();
  transport = { request };
  const identity = { dataScopeId: "space" };
  mocks.services = {
    applicationRemote: { transport }, canvasScope: { canvasId: () => canvasId },
    currentUser: { subscribe: () => () => undefined, getSnapshot: () => identity },
    canvasLocate: { locateNodes: locate }, canvasRuntime: { controller: () => ({ selectNode: select }) }, canvasGroupRuns: { refresh: vi.fn() }, canvasNavigation: { openDialog: vi.fn(), openPanel: vi.fn() },
    agentConversationService: {
      queryTurn: vi.fn(),
      listConnections: async () => ({ ok: true, value: [{ connectionId: "connection", adapterId: "adapter", name: "助手", ready: true, authMode: "api-key", configRevision: 1, credentialEpoch: 1, capabilities: { tools: true }, models: [{ id: "model", label: "真实模型", reasoningEfforts: ["high"] }] }] }),
      catalog: async () => ({ ok: true, value: { capabilities: { targets: ["canvas-group"], tools: true }, models: [] } })
    }
  };
  Object.assign(creationDraft(transport, "space", canvasId), { prompt: "创建场景", connectionId: "connection", model: "model" });
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
async function render(key = canvasId) {
  await act(async () => root.render(<UiProvider><CanvasCreationPopover key={key} screen={{ x: 100, y: 100 }} world={{ x: 40, y: 50 }} items={[{ id: "insert:text", label: "文本", section: "basic-material" }]} writable onSelect={() => undefined} onClose={close} /></UiProvider>));
  await act(async () => { await vi.dynamicImportSettled(); });
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!; }
const view = { requestId: "request", canvasId: "canvas", rootGroupId: "root", commandId: "cmd", turnRequestId: "turn", scopeEpoch: 0, stage: "accepted" };
describe("blank creation lifecycle", () => {
  it("offers configuration when the directory is empty and preserves the creation draft", async () => {
    const service = mocks.services.agentConversationService as AgentConversationService;
    service.listConnections = vi.fn(async () => ({ ok: true as const, value: [] }));
    await render();
    expect(button("创建").disabled).toBe(true);
    expect(document.body.textContent).toContain("尚未配置助手。连接一个助手即可开始，创作描述会保留在这里。");
    await act(async () => button("配置助手").click());
    expect((mocks.services.canvasNavigation as { openDialog: ReturnType<typeof vi.fn> }).openDialog).toHaveBeenCalledWith({ dialogId: "agent-assistant", payload: { canvasId } });
    expect(creationDraft(transport, "space", canvasId).prompt).toBe("创建场景");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses the preloaded directory on the first AI render and when reopening without a loading flash", async () => {
    const service = mocks.services.agentConversationService as AgentConversationService;
    const connections = vi.spyOn(service, "listConnections");
    const catalogs = vi.spyOn(service, "catalog");
    await agentDirectory(service, "space").load();
    act(() => root.render(<UiProvider><CanvasCreationPopover screen={{ x: 100, y: 100 }} world={{ x: 40, y: 50 }} items={[]} writable onSelect={() => undefined} onClose={close} /></UiProvider>));
    expect(button("创建").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("正在读取");
    await render("reopened");
    expect(button("创建").disabled).toBe(false);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(catalogs).toHaveBeenCalledTimes(1);
  });
  it("does not block first creation for a local-login assistant whose account evidence arrives during execution", async () => {
    mocks.services.agentConversationService = {
      listConnections: async () => ({
        ok: true,
        value: [{
          connectionId: "connection",
          adapterId: "adapter",
          name: "本机工具",
          authMode: "local-login",
          ready: false,
          reason: "尚未确认本机工具配置或账号；执行时会启动专用进程并核对",
          configRevision: 1,
          credentialEpoch: 1,
          capabilities: { tools: true },
          models: []
        }]
      }),
      catalog: async () => ({
        ok: true,
        value: { capabilities: { targets: ["canvas-group"], tools: true }, models: [] }
      })
    };
    creationDraft(transport, "space", canvasId).model = "";
    await render();
    expect(document.body.textContent).not.toContain("尚未确认本机工具");
    expect(button("创建").disabled).toBe(false);
  });
  it("still blocks other auth modes until their readiness is verified", async () => {
    mocks.services.agentConversationService = {
      listConnections: async () => ({
        ok: true,
        value: [{
          connectionId: "connection",
          adapterId: "adapter",
          name: "远端助手",
          authMode: "api-key",
          ready: false,
          reason: "尚未保存凭据",
          configRevision: 1,
          credentialEpoch: 1,
          capabilities: { tools: true },
          models: [{ id: "model", label: "真实模型" }]
        }]
      }),
      catalog: async () => ({
        ok: true,
        value: { capabilities: { targets: ["canvas-group"], tools: true }, models: [] }
      })
    };
    await render();
    expect(button("创建").disabled).toBe(true);
    expect(document.body.textContent).toContain("尚未保存凭据");
  });
  it("starts with a top search field and discoverable AI entry, filters shortcuts, and reveals AI controls only on intent", async () => {
    const draft = creationDraft(transport, "space", "canvas");
    draft.prompt = "";
    await render();
    const field = document.querySelector("textarea")!;
    expect(field.placeholder).toContain("描述想创作");
    expect(field.compareDocumentPosition(button("文本")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button("创建")).toBeUndefined();
    expect(document.body.textContent).toContain("用 AI 创作");
    draft.prompt = "文本"; await render();
    expect(button("文本")).toBeTruthy();
    expect(document.body.textContent).toContain("让 AI 创作");
    expect(button("创建")).toBeUndefined();
    await act(async () => document.querySelector<HTMLButtonElement>(".canvas-create__ai-entry")!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(button("创建")).toBeTruthy();
    expect(field.value).toBe("文本");
  });
  it("switches unmatched text to AI and returns to matching shortcuts without losing the draft", async () => {
    const draft = creationDraft(transport, "space", "canvas");
    await render();
    expect(button("创建")).toBeTruthy();
    expect(document.querySelector(".canvas-create__materials")).toBeNull();
    draft.prompt = "文本"; await render();
    expect(button("创建")).toBeUndefined();
    expect(button("文本")).toBeTruthy();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("文本");
  });
  it("keeps the original pending draft when a response belongs to another request", async () => {
    request.mockResolvedValue({ ok: true, data: { creation: { ...view, canvasId: "other" } } });
    await render(); await act(async () => button("创建").click());
    expect(creationDraft(transport, "space", "canvas").pending).toBeDefined();
    expect(creationDraft(transport, "space", "canvas").prompt).toBe("创建场景");
    expect(locate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it("deduplicates double click and clears only its sent draft without opening details", async () => {
    let resolve!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(r => { resolve = r; }));
    await render();
    await act(async () => { const create = button("创建"); create.click(); create.click(); });
    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0]![0].body;
    expect(sent.position).toEqual({ x: 40, y: 50 });
    await act(async () => resolve({ ok: true, data: { creation: { ...view, requestId: sent.requestId } } }));
    expect(creationDraft(transport, "space", "canvas").prompt).toBe("");
    expect(locate).not.toHaveBeenCalled(); expect(select).toHaveBeenCalledWith("root"); expect(close).toHaveBeenCalledTimes(1);
  });
  it("a reopened pending draft observes completion; a different canvas never receives a late selection", async () => {
    let resolve!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(r => { resolve = r; }));
    await render(); await act(async () => button("创建").click());
    canvasId = "other"; await render();
    const other = creationDraft(transport, "space", "other"); other.prompt = "new draft";
    await act(async () => resolve({ ok: true, data: { creation: { ...view, requestId: request.mock.calls[0]![0].body.requestId } } }));
    expect(locate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(other.prompt).toBe("new draft");
    canvasId = "canvas"; await render();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false);
    expect(creationDraft(transport, "space", "canvas").busy).toBe(false);
  });
  it("accepting one group immediately permits another creation with a fresh request identity", async () => {
    request.mockImplementation(async ({ body }) => ({ ok: true, data: { creation: { ...view, requestId: body.requestId, rootGroupId: body.requestId } } }));
    await render();
    await act(async () => button("创建").click());
    const first = request.mock.calls[0]![0].body.requestId;
    const draft = creationDraft(transport, "space", "canvas");
    expect(draft.pending).toBeUndefined();
    draft.prompt = "另一个创作"; draft.version++;
    await render("second-menu");
    expect(button("创建").disabled).toBe(false);
    await act(async () => button("创建").click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0].body.requestId).not.toBe(first);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("queries the same identity after response loss and permits editing after a definitive preflight rejection", async () => {
    request.mockResolvedValueOnce({ ok: false, error: "timeout", code: "unavailable" }).mockImplementationOnce(async () => ({ ok: true, data: { creation: { ...view, requestId: request.mock.calls[0]![0].body.requestId } } }));
    await render(); await act(async () => button("创建").click());
    const sent = request.mock.calls[0]![0].body;
    expect(request.mock.calls[1]![0].path).toContain(encodeURIComponent(sent.requestId));
    expect(request).toHaveBeenCalledTimes(2);
    expect(locate).not.toHaveBeenCalled(); expect(select).toHaveBeenCalledOnce();
    Object.assign(creationDraft(transport, "space", "canvas"), { prompt: "try again", pending: undefined, result: undefined });
    request.mockResolvedValueOnce({ ok: false, error: "model expired", status: 400, body: { creationRegistered: false } });
    await render("reopened"); await act(async () => button("创建").click());
    expect(creationDraft(transport, "space", "canvas").pending).toBeUndefined();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false);
  });
  it("does not submit during IME composition and preserves the nested model Portal", async () => {
    request.mockResolvedValue({ ok: true, data: { creation: view } });
    await render();
    const field = document.querySelector("textarea")!;
    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(request).not.toHaveBeenCalled();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="选择助手模型"]')!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    // 模型与 Variant 收在同一个横向选项面板里，仍挂在当前菜单的 Portal 内。
    expect(document.querySelector('[role="dialog"][aria-label="选择助手模型"] .assistant-model-panel__option')).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });
});
