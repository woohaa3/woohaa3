/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { AgentAssistant } from "./assistant.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { SelectInput } from "@woohaa3/ui/forms";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { GenerationModelsStatusService, GenerationModelsStatusSnapshot } from "../../services/generation-models-status.js";
import type { AgentConnectionView, ServiceConnectionView } from "@woohaa3/contracts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let runtime: FrontendRuntime | undefined;
function DraftInput() {
  const [value, setValue] = useState("");
  return <input aria-label="新增 API Key" value={value} onChange={event => setValue(event.target.value)} />;
}
afterEach(async () => { act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; });
async function render(connections: AgentConnectionView[] = [], configure = false, settingsStore?: ReturnType<typeof createBackendSettingsStore>, payload: {canvasId?: string; nodeId?: string; kind?: string; page?: "add"; connectionId?: string; section?: "generation-history" | "diagnostics"} = {canvasId: "canvas", nodeId: "node"}, overrides: Partial<AgentConversationService> = {}, models?: Pick<GenerationModelsStatusService, "getSnapshot" | "subscribe">) {
  const slots = new SlotRegistry();
  if (configure) slots.register("agent-assistant.configuration", { id: "api", owner: "sdk-agent", kind: "api-key", label: "API Key", render: ({ onSaved }) => <><DraftInput /><button onClick={() => onSaved?.("c1")}>保存测试连接</button><SelectInput label="配置类型" value="one" onValueChange={() => {}} options={[{value:"one",label:"类型一"},{value:"two",label:"类型二"}]} /></> });
  if (configure) slots.register("agent-assistant.configuration", { id: "local", owner: "local-agent", kind: "installed", label: "我有本地 agent", render: () => <p>本机工具配置</p> });
  if (configure) slots.register("agent-assistant.configuration", { id: "oauth", owner: "oauth-agent", kind: "login", label: "账号授权", render: () => <p>ChatGPT 授权</p> });
  const listConnections = vi.fn(async () => ({ ok: true as const, value: connections }));
  const sourceViews = connections.filter(item => item.authMode !== "local-login").map(item => ({
    serviceConnectionId: `source:${item.connectionId}`, scope: "personal", kind: item.authMode === "oauth" ? "oauth" : "api", name: item.name,
    bindings: [{ bindingId: item.connectionId, extensionId: item.extensionId, consumer: item.authMode === "oauth" ? "oauth" : "agent", consumerId: item.connectionId, purposes: ["discussion"], modelKeys: [] }],
    endpoints: [], capabilities: [], enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1,
  })) as ServiceConnectionView[];
  const service = { listConnections, listServiceConnections: vi.fn(async () => ({ ok: true as const, value: sourceViews })), listConversations: vi.fn(async () => ({ ok: true as const, value: [] })), ...overrides } as unknown as AgentConversationService;
  runtime = await startFrontendRuntime({ installPlatform: (ctx) => { ctx.provide("slots" as never, slots as never); if (models) ctx.provide("generationModelsStatus" as never, models as never); }, plugins: [] });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  const close = vi.fn();
  const updatePayload = async (next: typeof payload) => { await act(async () => { root!.render(<RuntimeProvider runtime={runtime!}><AgentAssistant settingsStore={settingsStore} service={service} payload={next} onClose={close} /></RuntimeProvider>); }); };
  await updatePayload(payload);
  const click = async (label: string) => { const button = [...el.querySelectorAll("button")].find((item) => !item.closest("[hidden]") && (item.querySelector("strong")?.textContent ?? (item.matches("[data-page]") ? item.querySelector("span")?.textContent : item.textContent)) === label); expect(button).toBeDefined(); await act(async () => button!.click()); };
  return { el, click, service, listConnections, close, updatePayload };
}
const status = { transport: { state: "unknown" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } };
const api = { connectionId: "c1", extensionId: "sdk-agent", name: "我的 API", authMode: "api-key", ready: true, status } as AgentConnectionView;
const local = { ...api, connectionId: "local", extensionId: "local-agent", authMode: "local-login", name: "本地 Codex" } as AgentConnectionView;
const oauth = { ...api, connectionId: "oauth", extensionId: "oauth-agent", authMode: "oauth", name: "me@example.com" } as AgentConnectionView;

it("按 demo 显示能力总览和五项侧栏，MCP 与模型提供商独立", async () => {
  const f = await render();
  expect([...f.el.querySelectorAll(".agent-assistant__sidebar > button > span")].map(button => button.textContent)).toEqual(["能力总览", "本地 Agent", "MCP 服务", "模型提供商", "生成历史"]);
  expect(f.el.querySelector('.agent-assistant__sidebar [data-state="active"]')?.getAttribute("data-page")).toBe("overview");
  expect(f.el.querySelector('[data-ai-page="overview"]')?.textContent).toContain("模型提供商");
  expect(f.el.textContent).not.toContain("添加本地助手");
  await f.click("模型提供商");
  await f.click("添加连接");
  const drawer = f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')!;
  expect([...drawer.querySelectorAll('.agent-assistant__method')].map(item => item.querySelector("strong")?.textContent)).toEqual(["我有 ChatGPT 账号", "我有 API Key"]);
  expect(drawer.querySelector('[data-kind="api-key"]')?.textContent).not.toMatch(/OpenAI|Anthropic|Gemini/);
  expect(drawer.textContent).not.toContain("安装这个 MCP 服务");
  expect(f.listConnections).toHaveBeenCalledTimes(1);
});

it("按真实来源分区，本地 Agent 不进入服务连接，账号邮箱保留", async () => {
  const f = await render([api, local, oauth]);
  await f.click("本地 Agent");
  expect(f.el.querySelector('[data-ai-page="agents"] .agent-assistant__list')?.textContent).toContain("本地 Codex");
  expect(f.el.querySelector('[data-ai-page="agents"] .agent-assistant__list')?.textContent).not.toContain("我的 API");
  await f.click("模型提供商");
  const list = f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list')!;
  expect(list.textContent).toContain("我的 API");
  expect(list.textContent).toContain("me@example.com");
  expect(list.textContent).not.toContain("本地 Codex");
});

it.each(["api-key", "installed", "login", "generation", "mcp"])("旧 kind=%s 定位新 Tab，保留原配置入口", async kind => {
  const f = await render([], true, undefined, { canvasId: "canvas", kind });
  const services = ["api-key", "login", "generation"].includes(kind);
  expect(f.el.querySelector('.agent-assistant__sidebar [data-state="active"] > span')?.textContent).toBe(services ? "模型提供商" : kind === "mcp" ? "MCP 服务" : "本地 Agent");
  if (kind === "api-key") expect(f.el.querySelector('input[aria-label="新增 API Key"]')).not.toBeNull();
  if (kind === "installed") expect(f.el.textContent).toContain("本机工具配置");
  if (kind === "mcp") expect(f.el.textContent).toContain("复制安装指引");
  expect(f.listConnections).toHaveBeenCalledTimes(1);
  expect(f.close).not.toHaveBeenCalled();
});

it.each([api, local, oauth])("按 connectionId=$connectionId 解析真实来源而非旧 Tab", async connection => {
  const f = await render([api, local, oauth], true, undefined, { connectionId: connection.connectionId, kind: "mcp" });
  expect(f.el.querySelector('.agent-assistant__sidebar [data-state="active"] > span')?.textContent).toBe(connection === local ? "本地 Agent" : "模型提供商");
  if (connection === api) expect(f.el.querySelector('input[aria-label="新增 API Key"]')).not.toBeNull();
  if (connection === local) expect(f.el.textContent).toContain("本机工具配置");
});

it("点击接入方式切换到独立配置页，返回恢复选择位置并保留 Key 草稿与浮层归属", async () => {
  const f = await render([], true, undefined, { kind: "generation", page: "add" });
  const apiButton = f.el.querySelector<HTMLButtonElement>('[data-kind="api-key"]')!;
  expect(apiButton.textContent).toContain("兼容服务");
  const login = f.el.querySelector<HTMLButtonElement>('[data-kind="login"]')!;
  await act(async () => apiButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(f.el.querySelector("input")).toBeNull();
  const drawerBody = apiButton.closest<HTMLElement>(".agent-assistant__drawer-body")!;
  drawerBody.scrollTop = 320;
  await f.click("我有 API Key");
  expect(apiButton.closest("[hidden]")).not.toBeNull();
  expect(drawerBody.scrollTop).toBe(0);
  expect(f.el.querySelector(".agent-assistant__form-heading h3")?.textContent).toBe("我有 API Key");
  const field = f.el.querySelector<HTMLInputElement>('input[aria-label="新增 API Key"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "draft-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    login.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(apiButton.dataset.selected).toBe("true");
  expect(field.closest("[hidden]")).toBeNull();
  await act(async () => f.el.querySelector<HTMLButtonElement>('button[aria-label="配置类型"]')!.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent === "类型二");
  expect(option?.closest(".agent-assistant")).toBe(f.el.querySelector(".agent-assistant"));
  await f.click("返回选择");
  expect(drawerBody.scrollTop).toBe(320);
  expect(apiButton.closest("[hidden]")).toBeNull();
  expect(field.closest("[hidden]")).not.toBeNull();
  expect(option?.closest("[hidden]")).not.toBeNull();
  await f.click("我有 ChatGPT 账号");
  expect(drawerBody.scrollTop).toBe(0);
  expect(f.el.querySelector(".agent-assistant__form-heading h3")?.textContent).toBe("我有 ChatGPT 账号");
  expect(field.closest("[hidden]")).not.toBeNull();
  expect(option?.closest("[hidden]")).not.toBeNull();
  await f.click("返回选择");
  await f.click("我有 API Key");
  await f.click("本地 Agent");
  expect(field.closest("[hidden]")).not.toBeNull();
  await f.click("模型提供商");
  expect(field.closest("[hidden]")).toBeNull();
  expect(field.value).toBe("draft-key");
  expect(f.listConnections).toHaveBeenCalledTimes(1);
  expect(f.close).not.toHaveBeenCalled();
});

it("保存后返回列表且需显式使用；不发生成事件", async () => {
  const f = await render([api], true, undefined, { canvasId: "canvas", nodeId: "node", kind: "api-key" });
  await f.click("保存测试连接");
  expect(f.close).not.toHaveBeenCalled();
  expect(f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list')?.textContent).toContain("我的 API");
  const selected = vi.fn(); globalThis.addEventListener("woohaa3-agent-assistant-selection", selected);
  try {
    await f.click("使用");
    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.calls[0]![0].detail).toEqual({ canvasId: "canvas", nodeId: "node", connectionId: "c1" });
    expect(f.close).toHaveBeenCalledOnce();
  } finally { globalThis.removeEventListener("woohaa3-agent-assistant-selection", selected); }
});

it("不可用连接仍可管理，不能因保存成功自动用于作品", async () => {
  const f = await render([{ ...api, ready: false }], true, undefined, { kind: "generation", canvasId: "canvas", nodeId: "node" });
  expect([...f.el.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "使用")?.disabled).toBe(true);
  await f.click("配置");
  expect(f.el.querySelector(".agent-assistant__diagnostics")).toBeNull();
  expect(f.el.textContent).not.toContain("待验证");
  await f.click("关闭详情");
  expect(f.close).not.toHaveBeenCalled();
});

it("保留 MCP 安装前缀、画布指引及复制失败恢复", async () => {
  const { setAppBasePathForTesting } = await import("../../services/app-base-path.js");
  setAppBasePathForTesting("/workspace");
  const writeText = vi.fn(async (_text: string) => undefined);
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const f = await render();
    await f.click("MCP 服务");
    await f.click("复制安装指引");
    expect(writeText.mock.calls[0]?.[0]).toContain("/workspace/mcp/model-canvas");
    await f.click("复制画布指引");
    expect(writeText.mock.calls[1]?.[0]).toContain("画布 canvas");
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await f.click("复制安装指引");
    expect(f.el.textContent).toContain("复制失败，请手动选择并复制内容，或点击按钮重试。");
  } finally {
    setAppBasePathForTesting("");
    if (previous) Object.defineProperty(navigator, "clipboard", previous); else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("服务连接按需读取现有 Provider 配置，空密钥不从浏览器回读", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: { settings: [
    { key: "providers.test.apiKey", kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true, source: null, lockedBy: null, value: null, configured: true, pendingRestart: false, group: "测试 Provider" },
    { key: "providers.test.baseUrl", kind: "url" as const, label: "地址", description: "", reload: "hot" as const, secret: false, source: null, lockedBy: null, value: "https://example.com", configured: true, pendingRestart: false, group: "测试 Provider" }
  ], plugins: [], files: { config: "c", secrets: "s" } } }));
  const write = vi.fn(async () => ({ ok: false as const, code: "unavailable", error: "test" }));
  const source = { serviceConnectionId: "site-test", scope: "site", kind: "api", name: "测试 Provider", endpoints: [], capabilities: [], bindings: [{ bindingId: "provider:test", extensionId: "test", consumer: "provider", consumerId: "test", purposes: ["text"], modelKeys: [] }], enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1 } as import("@woohaa3/contracts").ServiceConnectionView;
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write }), { kind: "mcp" }, { listServiceConnections: async () => ({ ok: true, value: [source] }) });
  expect(fetchSnapshot).not.toHaveBeenCalled();
  await act(async () => { await f.click("模型提供商"); await import("../settings/provider-settings-cards.js"); });
  await f.click("添加连接");
  expect(f.el.querySelector('[data-ai-page="sources"] [data-kind="provider:test"]')).not.toBeNull();
  await f.click("关闭详情");
  await f.click("配置");
  expect(f.el.querySelector('[data-setting-key="providers.test.apiKey"] input')?.getAttribute("type")).toBe("password");
  expect(write).not.toHaveBeenCalled();
});


it("保存首个 Provider Key 后空引导消失并显示已配置的模型提供商，失败时保留草稿", async () => {
  const { agentAssistantExtension } = await import("./plugin.js");
  const { DialogService } = await import("../../services/dialogs/service.js");
  const { CanvasNavigationStore } = await import("../../navigation/store.js");
  const slots = new SlotRegistry();
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore({ openDialog: request => dialogs.open({ dialogId: request.dialogId, payload: request.payload }) });
  let configured = false;
  const snapshot = () => ({ settings: [{
    key: "providers.test.apiKey", kind: "string", label: "API Key", description: "", reload: "hot", secret: true,
    source: null, lockedBy: null, value: null, configured, pendingRestart: false, group: "测试 Provider",
  }], plugins: [], files: { config: "c", secrets: "s" } });
  const write = vi.fn(async () => { configured = true; return { ok: true, snapshot: snapshot() }; })
    .mockResolvedValueOnce({ ok: false, code: "unavailable", error: "保存失败，请重试" } as never);
  const extensionRefresh = vi.fn(async () => {});
  const modelRefresh = vi.fn(async () => {});
  const invalidateCatalog = vi.fn();
  const listServiceConnections = vi.fn(async () => ({ ok: true, value: configured ? [{
    serviceConnectionId: "provider:test", scope: "site", kind: "api", name: "测试 Provider", endpoints: [], capabilities: [],
    bindings: [{ bindingId: "test", extensionId: "test", consumer: "provider", consumerId: "test", purposes: [], modelKeys: [] }],
    enabled: true, removed: false, credentialConfigured: configured, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1,
  }] : [] }));
  runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("slots" as never, slots as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("canvasNavigation" as never, navigation as never);
    ctx.provide("agentConversationService" as never, { listConnections: async () => ({ ok: true, value: [] }), listServiceConnections } as never);
    ctx.provide("settingsRemote" as never, { fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() }), write } as never);
    ctx.provide("applicationExtensionStatus" as never, { refresh: extensionRefresh } as never);
    ctx.provide("generationModelsStatus" as never, { refresh: modelRefresh, subscribe: () => () => {}, getSnapshot: () => null } as never);
    ctx.provide("taskCatalog" as never, { invalidate: invalidateCatalog } as never);
  }, plugins: [{ id: "agent-assistant", required: true, plugin: agentAssistantExtension() }] });
  dialogs.open({ dialogId: "agent-assistant", payload: { page: "add" } });
  const Renderer = dialogs.resolveRenderer("agent-assistant")!;
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => {
    root!.render(<RuntimeProvider runtime={runtime!}><Renderer instance={dialogs.top()!} requestClose={() => {}} setBusy={() => {}} replace={() => {}} /></RuntimeProvider>);
    await import("./assistant.js");
  });
  const sourceState = () => el.querySelector(".agent-assistant__source-list .agent-assistant__state")?.textContent;
  expect(el.querySelector(".agent-assistant__empty--service")).not.toBeNull();
  await act(async () => {
    el.querySelector<HTMLButtonElement>('[data-kind="provider:test"]')!.click();
    await import("../settings/provider-settings-cards.js");
  });
  const field = el.querySelector<HTMLInputElement>('[data-setting-key="providers.test.apiKey"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "test-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(el.querySelector(".agent-assistant__source-list")).toBeNull();
  const save = () => act(async () => field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await save();
  expect(field.value).toBe("test-key");
  expect(extensionRefresh).not.toHaveBeenCalled();
  expect(modelRefresh).not.toHaveBeenCalled();
  expect(el.querySelector(".agent-assistant__empty--service")).not.toBeNull();
  await save();
  expect(sourceState()).toBe("已配置");
  expect(el.querySelector(".agent-assistant__empty--service")).toBeNull();
  expect(el.querySelector(".agent-assistant__source-list")?.textContent).toContain("测试 Provider");
  expect(el.querySelector('[data-page="sources"] small')?.textContent).toBe("1");
  expect(extensionRefresh).toHaveBeenCalledOnce();
  expect(modelRefresh).toHaveBeenCalledOnce();
  expect(invalidateCatalog).toHaveBeenCalledOnce();
  expect(listServiceConnections).toHaveBeenCalledTimes(2);
  expect(el.querySelector('.agent-assistant__drawer-layer:not([hidden])')).toBeNull();
});

it("工具栏单例打开且不读取模型，dispose 撤销事件、槽位和 Dialog 注册", async () => {
  const { agentAssistantExtension } = await import("./plugin.js");
  const { DialogService } = await import("../../services/dialogs/service.js");
  const { CanvasNavigationStore } = await import("../../navigation/store.js");
  const slots = new SlotRegistry();
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore({ openDialog: (request) => dialogs.open({ dialogId: request.dialogId, payload: request.payload }) });
  const listConnections = vi.fn(async () => ({ ok: true, value: [] }));
  runtime = await startFrontendRuntime({ installPlatform: (ctx) => {
    ctx.provide("slots" as never, slots as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("canvasNavigation" as never, navigation as never);
    ctx.provide("canvasScope" as never, { canvasId: () => "current-canvas" } as never);
    ctx.provide("agentConversationService" as never, { listConnections } as never);
  }, plugins: [{ id: "agent-assistant", required: true, plugin: agentAssistantExtension() }] });
  globalThis.dispatchEvent(new CustomEvent("woohaa3-open-agent-assistant", { detail: { canvasId: "canvas", nodeId: "node" } }));
  const first = dialogs.top();
  expect(first?.dialogId).toBe("agent-assistant");
  globalThis.dispatchEvent(new CustomEvent("woohaa3-open-agent-assistant"));
  expect(dialogs.top()?.instanceId).toBe(first?.instanceId);
  expect(listConnections).not.toHaveBeenCalled();
  expect(slots.list("canvas.toolbar-action")).toHaveLength(1);
  // 面板主操作：AI 助手用 primary 实底且排在其他入口之前（priority 更低）。
  expect(slots.list("canvas.toolbar-action")[0]).toMatchObject({ id: "agent-assistant", tone: "primary", priority: 0 });
  const Renderer = dialogs.resolveRenderer("agent-assistant")!;
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => {
    root!.render(<RuntimeProvider runtime={runtime!}><Renderer instance={{ ...first!, payload: {} }} requestClose={() => {}} setBusy={() => {}} replace={() => {}} /></RuntimeProvider>);
    await import("./assistant.js");
  });
  expect(el.querySelector('[data-ai-tab="mcp"]')?.textContent).toContain("画布 current-canvas");
  act(() => root!.unmount()); root = undefined;
  await runtime.dispose();
  runtime = undefined;
  expect(slots.list("canvas.toolbar-action")).toHaveLength(0);
  expect(dialogs.open({ dialogId: "agent-assistant", payload: {} }).ok).toBe(false);
  globalThis.dispatchEvent(new CustomEvent("woohaa3-open-agent-assistant"));
  expect(dialogs.top()).toBeNull();
});
it("unified directory keeps source identity, readonly shared views and original personal form after Provider binding", async () => {
  const source = { serviceConnectionId: "source", scope: "personal", kind: "api", name: "Unified relay", endpoints: [{ protocol: "chat-completions", baseUrl: "https://relay.example/v1" }], capabilities: [{ purpose: "discussion", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" }], bindings: [
    { bindingId: "sdk:c1", extensionId: "sdk-agent", consumer: "agent", consumerId: "c1", purposes: ["discussion"], modelKeys: ["model"] },
    { bindingId: "provider:demo", extensionId: "demo", consumer: "provider", consumerId: "demo", purposes: ["text"], modelKeys: ["demo:model"] },
  ], enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1 } as import("@woohaa3/contracts").ServiceConnectionView;
  const shared = { ...source, serviceConnectionId: "shared", scope: "site" as const, name: "Shared relay", managedByAdministrator: true, endpoints: [], bindings: [] };
  const manage = vi.fn(async () => ({ ok: false as const, code: "conflict", error: "版本冲突，草稿保留" }));
  const f = await render([api, local], true, undefined, { kind: "mcp" }, {
    listServiceConnections: async () => ({ ok: true, value: [source, shared] }),
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [source, shared], duplicates: [], providers: [] } }),
    manageServiceConnection: manage,
  });
  await f.click("模型提供商");
  const list = f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list')!;
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(list.textContent).toContain("Unified relay");
  expect(list.textContent).not.toContain("本地 Codex");
  await f.click("配置");
  const input = f.el.querySelector<HTMLInputElement>('input[aria-label="新增 API Key"]')!;
  expect(input.closest("[hidden]")).toBeNull(); // The source's original form, never global Provider settings.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unsaved-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("停用来源");
  expect(manage).not.toHaveBeenCalled();
  await f.click("确认");
  expect(manage).toHaveBeenCalledWith({ action: "enabled", serviceConnectionId: "source", configRevision: 1, credentialEpoch: 1, enabled: false });
  expect(f.el.textContent).toContain("版本冲突，草稿保留");
  await f.click("取消");
  await f.click("关闭详情");
  await f.click("本地 Agent"); await f.click("模型提供商"); await f.click("配置");
  expect(f.el.querySelector<HTMLInputElement>('input[aria-label="新增 API Key"]')?.value).toBe("unsaved-key");
  await f.click("关闭详情");
  const manageButtons = [...f.el.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "配置" && !button.closest("[hidden]"));
  await act(async () => manageButtons[1].click());
  const visible = f.el.querySelector('[data-ai-page="sources"]')!;
  expect([...visible.querySelectorAll("button")].filter(button => !button.closest("[hidden]")).map(button => button.textContent)).not.toContain("停用来源");
  expect(f.close).not.toHaveBeenCalled();
});

it("空服务目录的大引导直接打开宫格抽屉", async () => {
  const f = await render([], true, undefined, { kind: "mcp" });
  await f.click("模型提供商");
  expect(f.el.textContent).toContain("添加你的第一个模型提供商");
  await f.click("添加第一个模型提供商");
  expect(f.el.querySelectorAll('.agent-assistant__drawer-layer:not([hidden]) .agent-assistant__method')).toHaveLength(2);
  expect(f.el.querySelector('.agent-assistant__drawer-layer:not([hidden]) .agent-assistant__list')).toBeNull();
});

it("已有服务连接时，点击添加直接替换为宫格选择面板", async () => {
  const source = { serviceConnectionId: "source", scope: "personal", kind: "api", name: "Unified relay", endpoints: [], capabilities: [], bindings: [], enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1 } as import("@woohaa3/contracts").ServiceConnectionView;
  const f = await render([], true, undefined, { kind: "mcp" }, {
    serviceConnectionDirectory: async () => ({ ok: true as const, value: { connections: [source], duplicates: [], providers: [] } }),
    listServiceConnections: async () => ({ ok: true as const, value: [] }),
  });
  await f.click("模型提供商");
  expect(f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list')?.textContent).toContain("Unified relay");
  await f.click("添加连接");
  const services = f.el.querySelector('[data-ai-page="sources"]')!;
  expect(services.querySelectorAll(".agent-assistant__method")).toHaveLength(2);
  expect(services.querySelector(".agent-assistant__drawer-layer:not([hidden]) .agent-assistant__list")).toBeNull();
  expect(services.textContent).not.toContain("其他服务模板");
});

it("本地 Agent 直接展示检测配置，不再有添加按钮或分类宫格", async () => {
  const f = await render([], true);
  await f.click("本地 Agent");
  const localPage = f.el.querySelector('[data-ai-page="agents"]')!;
  expect(localPage.textContent).toContain("本机工具配置");
  expect(localPage.textContent).not.toContain("添加本地助手");
  expect(localPage.querySelector(".agent-assistant__method")).toBeNull();
});

it("全部供应商直接出现于添加宫格，关闭抽屉和切换页面后保留各自草稿", async () => {
  const snapshot = { settings: ["litellm", "tokenhub", "fal"].map(id => ({
    key: `providers.${id}.apiKey`, kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true,
    source: null, lockedBy: null, value: null, configured: true, pendingRestart: false, group: id,
  })), plugins: [], files: { config: "c", secrets: "s" } };
  const write = vi.fn(async () => ({ ok: true as const, snapshot }));
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write });
  const f = await render([], true, store);
  await f.click("添加连接"); // Overview opens the source chooser directly.
  const drawer = () => f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')!;
  expect([...drawer().querySelectorAll('[data-kind^="provider:"]')].map(item => item.getAttribute("data-kind"))).toEqual(["provider:litellm", "provider:tokenhub", "provider:fal"]);
  await act(async () => { await f.click("litellm"); await import("../settings/provider-settings-cards.js"); });
  const field = f.el.querySelector<HTMLInputElement>('[data-setting-key="providers.litellm.apiKey"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "unsaved-provider-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("返回选择");
  await f.click("tokenhub");
  expect(field.closest("[hidden]")).not.toBeNull();
  await f.click("本地 Agent");
  await f.click("模型提供商");
  await f.click("关闭详情");
  await f.click("添加连接");
  await f.click("返回选择");
  await f.click("litellm");
  expect(field.closest("[hidden]")).toBeNull();
  expect(field.value).toBe("unsaved-provider-key");
  expect(write).not.toHaveBeenCalled();
  await f.click("保存");
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith({ "providers.litellm.apiKey": "unsaved-provider-key" });
  expect(drawer()).toBeNull();
  expect(f.service.listServiceConnections).toHaveBeenCalledTimes(2);
});

it("添加入口按模型目录标注类型并随目录更新，不混入历史模型或其他供应商", async () => {
  const snapshot = { settings: ["mixed", "images", "empty", "declared"].map(id => ({
    key: `providers.${id}.apiKey`, kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true,
    source: null, lockedBy: null, value: null, configured: false, pendingRestart: false, group: id,
  })), plugins: [{ id: "declared-provider", configPrefix: "providers.declared", label: "声明类型", description: "", layer: "extension" as const,
    settingCount: 1, siteManaged: false, provider: true, modelTypes: ["language", "audio"] as const,
  }], files: { config: "c", secrets: "s" } };
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: vi.fn() });
  const model = (providerId: string, modelType: "language" | "image" | "video" | "audio", suffix = "", tombstone = false) => ({
    providerId, modelType, modelKey: `${providerId}:${modelType}${suffix}`, enabled: false, executable: false, isDefault: false, tombstone,
  });
  let state: GenerationModelsStatusSnapshot = { revision: 1, catalogRevision: 1, initialized: true, loading: false, error: null, models: [
    model("mixed", "audio"), model("mixed", "image"), model("mixed", "video"), model("mixed", "language"), model("mixed", "image", "2"),
    model("images", "image"), model("images", "video", "old", true), model("other", "language"),
  ] };
  let notify = () => {};
  const f = await render([], true, store, {}, {}, { getSnapshot: () => state, subscribe: listener => { notify = listener; return () => {}; } });
  await f.click("添加连接");
  const tags = (id: string) => [...f.el.querySelectorAll(`[data-kind="${id}"] .agent-assistant__model-types > span`)].map(tag => tag.textContent);
  expect(tags("api-key")).toEqual(["文本"]);
  expect(tags("login")).toEqual(["文本"]);
  expect(tags("provider:mixed")).toEqual(["文本", "图片", "视频", "音频"]);
  expect(tags("provider:images")).toEqual(["图片"]);
  expect(tags("provider:empty")).toEqual(["模型待发现"]);
  expect(tags("provider:declared")).toEqual(["文本", "音频"]); // Available before keys or model discovery.
  await act(async () => { state = { ...state, revision: 2, models: [...state.models, model("empty", "audio")] }; notify(); });
  expect(tags("provider:empty")).toEqual(["音频"]);
  expect(f.el.querySelectorAll('.agent-assistant__method')).toHaveLength(6);
});

it("总览不展示诊断状态或会话历史入口", async () => {
  const listConversations = vi.fn(async () => ({ ok: true as const, value: [] }));
  const f = await render([api, local], true, undefined, { canvasId: "canvas" }, { listConversations });
  expect(f.el.textContent).not.toContain("诊断与历史");
  expect(f.el.textContent).not.toContain("待验证");
  expect(f.el.querySelector('[data-ai-page="overview"]')?.textContent).toContain("1 个可用");
  expect(f.el.querySelector('[data-ai-page="overview"]')?.textContent).toContain("1 个提供商");
  expect(listConversations).not.toHaveBeenCalled();
});

it("服务目录失败时总览报告失败，服务页提供重试而不假称空目录", async () => {
  const directory = vi.fn(async () => ({ ok: false as const, code: "offline", error: "目录暂不可用" }));
  const f = await render([], true, undefined, {}, { serviceConnectionDirectory: directory });
  expect(f.el.querySelector('[data-ai-page="overview"]')?.textContent).toContain("读取失败");
  await f.click("模型提供商");
  const page = f.el.querySelector('[data-ai-page="sources"]')!;
  expect(page.textContent).toContain("目录暂不可用");
  expect(page.querySelector(".agent-assistant__empty--service")).toBeNull();
  await f.click("重新读取");
  expect(directory).toHaveBeenCalledTimes(2);
});


it("显式历史定位优先于连接 ID，用户侧栏选择不被迟到目录抢走", async () => {
  let resolveConnections!: (value: any) => void;
  const listConnections = vi.fn(() => new Promise<any>(resolve => { resolveConnections = resolve; }));
  const f = await render([], false, undefined, { canvasId: "canvas", section: "generation-history", connectionId: "c1" }, { listConnections });
  expect(f.el.querySelector('[data-page="generation-history"]')?.getAttribute("data-state")).toBe("active");
  expect(f.el.querySelector('[data-ai-page="generation-history"]')?.textContent).toContain("历史模块未装配");
  await f.click("本地 Agent");
  await act(async () => resolveConnections({ ok: true, value: [api] }));
  expect(f.el.querySelector('[data-page="agents"]')?.getAttribute("data-state")).toBe("active");
});

it("无显式定位的旧连接入口也尊重用户先行选择", async () => {
  let resolveConnections!: (value: any) => void;
  const f = await render([], false, undefined, { connectionId: "c1" }, { listConnections: () => new Promise<any>(resolve => { resolveConnections = resolve; }) });
  await f.click("MCP 服务");
  await act(async () => resolveConnections({ ok: true, value: [api] }));
  expect(f.el.querySelector('[data-page="mcp"]')?.getAttribute("data-state")).toBe("active");
});
