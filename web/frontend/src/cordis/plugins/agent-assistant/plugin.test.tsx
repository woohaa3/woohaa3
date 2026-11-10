/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { UiProvider } from "@woohaa3/ui/primitives";
import type { GenerationModelsStatusSnapshot } from "../../services/generation-models-status.js";
import type { AgentConnectionView, ServiceConnectionView, SettingsSnapshot, SettingsEntryView } from "@woohaa3/contracts";
import { api, cleanupHarness, declaredSite, local, oauth, render } from "./plugin-harness.js";
let root: Root | undefined; let runtime: FrontendRuntime | undefined;
afterEach(async () => { await cleanupHarness(); act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; });

it("provider-login 贡献同时出现在模型提供商列表，配置直接打开该登录面板", async () => {
  const f = await render([], false, undefined, { canvasId: "canvas", nodeId: "node" }, {}, undefined, true);
  await f.click("模型提供商");
  const list = f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list')!;
  expect(list.textContent).toContain("Demo 微信登录");
  const row = [...list.querySelectorAll("li")].find(item => item.textContent?.includes("Demo 微信登录"))!;
  await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => { await import("../settings/provider-settings-cards.js"); });
  expect(f.el.textContent).toContain("微信扫码登录");
});

it("未配置的 provider-login 不占用模型提供商列表，但仍可从添加连接进入登录", async () => {
  const f = await render([], false, undefined, { canvasId: "canvas", nodeId: "node" }, {}, undefined, true, false, false);
  await f.click("模型提供商");
  const list = f.el.querySelector('[data-ai-page="sources"] .agent-assistant__list');
  expect(list?.textContent ?? "").not.toContain("Demo 微信登录");
  expect(f.el.textContent).toContain("添加你的第一个模型提供商");

  await f.click("添加连接");
  const drawer = f.el.querySelector(".agent-assistant__drawer-layer:not([hidden])")!;
  expect([...drawer.querySelectorAll(".agent-assistant__method strong")].map(item => item.textContent)).toContain("Demo 微信登录");
});

it("provider-login 贡献作为独立供应商方法出现，并在选中后渲染其面板", async () => {
  const f = await render([], false, undefined, { kind: "generation", page: "add" }, {}, undefined, true);
  const methods = [...f.el.querySelectorAll(".agent-assistant__method")].map(item => item.querySelector("strong")?.textContent);
  expect(methods).toContain("Demo 微信登录");
  await f.configure("Demo 微信登录");
  expect(f.el.textContent).toContain("微信扫码登录");
});

it("按 demo 显示能力总览和五项侧栏，MCP 与模型提供商独立", async () => {
  const f = await render();
  expect([...f.el.querySelectorAll(".agent-assistant__sidebar > button > span")].map(button => button.textContent)).toEqual(["能力总览", "本地 Agent", "模型提供商", "MCP 服务", "生成历史"]);
  expect(f.el.querySelector('.agent-assistant__sidebar [data-state="active"]')?.getAttribute("data-page")).toBe("overview");
  expect([...f.el.querySelectorAll('[data-ai-page="overview"] [data-capability] > strong')].map(item => item.textContent)).toEqual(["Agent", "图片", "视频", "音频", "3D", "临时图床"]);
  expect(f.el.querySelector('.agent-assistant__mcp-overview')?.textContent).toContain("MCP");
  expect(f.el.textContent).not.toContain("添加本地助手");
  await f.click("模型提供商");
  await f.click("添加连接");
  const drawer = f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')!;
  expect([...drawer.querySelectorAll('.agent-assistant__method')].map(item => item.querySelector("strong")?.textContent)).toEqual(["我有 API Key", "我有 ChatGPT 账号"]);
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
  await f.configure("我有 API Key");
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
  await f.configure("我有 ChatGPT 账号");
  expect(drawerBody.scrollTop).toBe(0);
  expect(f.el.querySelector(".agent-assistant__form-heading h3")?.textContent).toBe("我有 ChatGPT 账号");
  expect(field.closest("[hidden]")).not.toBeNull();
  expect(option?.closest("[hidden]")).not.toBeNull();
  await f.click("返回选择");
  await f.configure("我有 API Key");
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
  // 能力中心的临时图床状态需要只读设置快照；打开页面不等于写入或上传。
  expect(fetchSnapshot).toHaveBeenCalled();
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
    root!.render(<RuntimeProvider runtime={runtime!}><UiProvider><Renderer instance={dialogs.top()!} requestClose={() => {}} setBusy={() => {}} replace={() => {}} /></UiProvider></RuntimeProvider>);
    await import("./assistant.js");
  });
  const sourceState = () => el.querySelector(".agent-assistant__source-list .agent-assistant__state")?.textContent;
  expect(el.querySelector(".agent-assistant__empty--service")).not.toBeNull();
  await act(async () => {
    el.querySelector<HTMLButtonElement>('[data-kind="provider:test"] button')!.click();
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
    root!.render(<RuntimeProvider runtime={runtime!}><UiProvider><Renderer instance={{ ...first!, payload: {} }} requestClose={() => {}} setBusy={() => {}} replace={() => {}} /></UiProvider></RuntimeProvider>);
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

it("全部提供商直接出现于添加宫格，关闭抽屉和切换页面后保留各自草稿", async () => {
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
  await act(async () => { await f.configure("litellm"); await import("../settings/provider-settings-cards.js"); });
  const field = f.el.querySelector<HTMLInputElement>('[data-setting-key="providers.litellm.apiKey"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "unsaved-provider-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("返回选择");
  await f.configure("tokenhub");
  expect(field.closest("[hidden]")).not.toBeNull();
  await f.click("本地 Agent");
  await f.click("模型提供商");
  await f.click("关闭详情");
  await f.click("添加连接");
  await f.click("返回选择");
  await f.configure("litellm");
  expect(field.closest("[hidden]")).toBeNull();
  expect(field.value).toBe("unsaved-provider-key");
  expect(write).not.toHaveBeenCalled();
  await f.click("保存");
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith({ "providers.litellm.apiKey": "unsaved-provider-key" });
  expect(drawer()).toBeNull();
  expect(f.service.listServiceConnections).toHaveBeenCalledTimes(2);
});

it("添加入口按模型目录标注类型并随目录更新，不混入历史模型或其他提供商", async () => {
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
  expect(f.el.querySelector('[data-capability="agent"] [data-count="local"]')?.textContent).toBe("已配置 1 个本地 Agent");
  expect(f.el.querySelector('[data-capability="agent"] [data-count="suppliers"]')?.textContent).toBe("已配置 1 个提供商");
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

it("能力按来源身份计数，跨能力共享提供商，详情直接打开原配置", async () => {
  const source: ServiceConnectionView = {
    serviceConnectionId: "multi", scope: "personal", kind: "api", name: "多能力来源", endpoints: [],
    capabilities: ["discussion", "image", "image", "video"].map((purpose, index) => ({ purpose, protocol: "chat-completions", modelId: `model-${index}`, imageInput: false, evidence: "adapter" })) as ServiceConnectionView["capabilities"],
    bindings: [{ bindingId: "agent", extensionId: "sdk-agent", consumer: "agent", consumerId: api.connectionId, purposes: ["discussion"], modelKeys: [] }],
    enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1,
  };
  const unconfigured = { ...source, serviceConnectionId: "draft", name: "未授权来源", credentialConfigured: false, bindings: [] };
  const removed = { ...source, serviceConnectionId: "removed", name: "已移除来源", removed: true, bindings: [] };
  const f = await render([api, local], true, undefined, {}, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [source, unconfigured, removed], providers: [], duplicates: [] } }),
  });
  expect(f.el.querySelector('[data-capability="agent"] [data-count="local"]')?.textContent).toBe("已配置 1 个本地 Agent");
  expect(f.el.querySelector('[data-capability="agent"] [data-count="suppliers"]')?.textContent).toBe("已配置 1 个提供商");
  for (const kind of ["image", "video"]) expect(f.el.querySelector(`[data-capability="${kind}"] .agent-assistant__capability-count`)?.textContent).toBe("已配置 1 个提供商");
  await f.click("图片");
  const detail = f.el.querySelector('[data-capability-detail="image"]')!;
  expect(detail.textContent).toContain("多能力来源");
  expect(detail.textContent).toContain("未授权来源");
  expect(detail.textContent).not.toContain("已移除来源");
  expect(detail.textContent).toContain("model-1");
  expect(detail.textContent).toContain("model-2");
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')?.textContent).toContain("多能力来源");
  expect(f.el.querySelector('input[aria-label="新增 API Key"]')).not.toBeNull();
  await f.click("能力总览");
  await f.click("3D");
  const placeholder = f.el.querySelector('[data-capability-detail="model3d"]')!;
  expect(placeholder.textContent).toContain("暂未接入");
  expect(placeholder.textContent).not.toContain("添加提供商");
});

it("从图片能力添加时仅列出图片提供商，普通添加保留所有方式", async () => {
  const snapshot = { settings: ["pictures", "sound"].map(id => ({
    key: `providers.${id}.apiKey`, kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true,
    source: null, lockedBy: null, value: null, configured: false, pendingRestart: false, group: id,
  })), plugins: [
    { id: "pictures-provider", configPrefix: "providers.pictures", label: "图片提供商", description: "", layer: "extension" as const, settingCount: 1, siteManaged: false, provider: true, modelTypes: ["image"] as const },
    { id: "sound-provider", configPrefix: "providers.sound", label: "音频提供商", description: "", layer: "extension" as const, settingCount: 1, siteManaged: false, provider: true, modelTypes: ["audio"] as const },
  ], files: { config: "c", secrets: "s" } };
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: vi.fn() });
  const f = await render([], true, store);
  await f.click("图片");
  const drawer = () => f.el.querySelector('.agent-assistant__drawer-layer:not([hidden])')!;
  expect(drawer().textContent).toContain("添加图片提供商");
  expect([...drawer().querySelectorAll(".agent-assistant__method strong")].map(item => item.textContent)).toEqual(["图片提供商"]);
  await f.click("关闭详情");
  await f.click("添加连接");
  expect([...drawer().querySelectorAll(".agent-assistant__method strong")].map(item => item.textContent)).toEqual(["我有 API Key", "我有 ChatGPT 账号", "图片提供商", "音频提供商"]);
});

it("提供商声明的共享讨论用途始终开放，不提供关闭入口", async () => {
  const f = await render([], true, undefined, {}, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [declaredSite()], duplicates: [], providers: [] } }),
  });
  await f.click("模型提供商"); await f.click("配置");
  const page = f.el.querySelector('[data-ai-page="sources"]')!;
  expect(page.textContent).not.toContain("关闭共享讨论用途");
  expect(page.textContent).not.toContain("开放共享讨论用途");
});

it("已停用的来源可显式移除，移除动作带冻结版本", async () => {
  const disabled = declaredSite({ enabled: false });
  const manage = vi.fn(async () => ({ ok: true as const, value: disabled }));
  const f = await render([], true, undefined, {}, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [disabled], duplicates: [], providers: [] } }),
    manageServiceConnection: manage,
  });
  await f.click("模型提供商"); await f.click("配置");
  const page = f.el.querySelector('[data-ai-page="sources"]')!;
  expect(page.textContent).toContain("已停用");
  await f.click("移除来源"); await f.click("确认");
  expect(manage).toHaveBeenCalledWith({ action: "remove", serviceConnectionId: "site-provider", configRevision: 1, credentialEpoch: 1 });
});

it("无提供商声明的自填来源仍需显式开放共享讨论用途", async () => {
  const selfFilled = declaredSite({ serviceConnectionId: "site-manual", name: "自填来源", bindings: [] });
  const f = await render([], true, undefined, {}, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [selfFilled], duplicates: [], providers: [] } }),
    manageServiceConnection: vi.fn(async () => ({ ok: true as const, value: selfFilled })),
  });
  await f.click("模型提供商"); await f.click("配置");
  expect(f.el.querySelector('[data-ai-page="sources"]')?.textContent).toContain("开放共享讨论用途");
});

it("Agent 详情在有目标时显式使用提供商并返回原节点", async () => {
  const source = declaredSite({ serviceConnectionId: "svc", name: "文字提供商", scope: "personal", managedByAdministrator: false });
  const connection = { ...api, connectionId: "auto-c1", name: "文字提供商", serviceConnectionId: "svc", ready: true } as AgentConnectionView;
  const selected = vi.fn(); globalThis.addEventListener("woohaa3-agent-assistant-selection", selected);
  try {
    const f = await render([connection], true, undefined, { canvasId: "canvas", nodeId: "node" }, {
      serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [source], duplicates: [], providers: [] } }),
    });
    await f.click("Agent");
    const detail = f.el.querySelector('[data-capability-detail="agent"]')!;
    const use = [...detail.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "使用");
    expect(use?.disabled).toBe(false);
    expect(selected).not.toHaveBeenCalled();
    await act(async () => use!.click());
    expect(selected).toHaveBeenCalledTimes(1);
    expect((selected.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ canvasId: "canvas", nodeId: "node", connectionId: "auto-c1" });
  } finally { globalThis.removeEventListener("woohaa3-agent-assistant-selection", selected); }
});

it("临时图床展示优先级图标与最近真实失败", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: "runninghub-temporary",
      candidates: [
        { exposerId: "runninghub-temporary", label: "RunningHub 临时图床", category: "provider" as const, ownerExtensionId: "runninghub-provider", priority: 10, configured: true, available: true, selected: true, lastError: "401 unauthorized" },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: true, available: true, selected: false, lastError: null }
      ],
      error: null, lastFailure: { exposerId: "runninghub-temporary", message: "401 unauthorized" }
    } }
  } }));
  const write = vi.fn(async () => ({ ok: false as const, code: "unavailable", error: "test" }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write }));
  await act(async () => { await Promise.resolve(); });
  expect(write).not.toHaveBeenCalled();
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 2 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toMatch(/自动 ·|指定 ·/);
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("RunningHub 临时图床");
  expect(detail.textContent).not.toContain("当前选择");
  expect(detail.querySelectorAll('[data-hosting-priority="first"]')).toHaveLength(1);
  expect(detail.querySelector('[data-hosting-priority="first"]')?.closest("li")?.textContent).toContain("RunningHub");
  expect(detail.textContent).toContain("最近失败：401 unauthorized");
  expect(detail.textContent).toContain("COS / S3 对象存储");
  expect(detail.querySelectorAll("ul")).toHaveLength(1);
  expect(detail.querySelectorAll("ul li")).toHaveLength(2);
  expect(detail.textContent).not.toContain("内置服务");
  expect(detail.textContent).toContain("配置");
  expect(detail.textContent).not.toContain("暂未接入");
});

it("临时图床未配置来源不进入能力列表，仍可从配置抽屉进入配置", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: null,
      candidates: [
        { exposerId: "runninghub-temporary", label: "RunningHub 临时图床", category: "provider" as const, ownerExtensionId: "runninghub-provider", priority: 10, configured: false, available: false, selected: false, lastError: null },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: false, available: false, selected: false, lastError: null }
      ],
      error: "没有可用的临时图床，请检查提供商配置",
      lastFailure: null
    } }
  } }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write: async () => ({ ok: false as const, code: "unavailable", error: "test" }) }));
  await act(async () => { await Promise.resolve(); });
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 0 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toContain("读取失败");
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("没有可用的临时图床");
  expect(detail.querySelectorAll("ul li")).toHaveLength(0);
  expect(detail.textContent).not.toContain("RunningHub 临时图床");
  expect(detail.textContent).not.toContain("COS / S3 对象存储");
  expect(detail.textContent).toContain("尚未配置临时图床来源");
  await f.click("配置");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("RunningHub 临时图床");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("COS / S3 对象存储");
});

function hostingSnapshot(configured = false, primary = "auto", lockedBy: string | null = null): SettingsSnapshot {
  const setting = (key: string, extra: Partial<SettingsEntryView>): SettingsEntryView => ({
    key, kind: "string", label: "来源", description: "", reload: "hot", secret: false,
    source: "file", lockedBy: null, value: null, configured: true, pendingRestart: false, ...extra,
  });
  return {
    settings: [
      setting("exposer.primary", { value: primary, lockedBy }),
      setting("providers.test.apiKey", { label: "API Key", secret: true, configured, ownerExtensionId: "test-provider" }),
    ], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { exposer: [{ id: "test-hosting", label: "测试图床", ownerExtensionId: "test-provider" }], temporaryHosting: {
      mode: primary === "auto" ? "auto" : "manual", selectionSource: primary === "auto" ? "auto" : "manual",
      selectedId: configured || primary !== "auto" ? "test-hosting" : null,
      candidates: [{ exposerId: "test-hosting", label: "测试图床", category: "provider", ownerExtensionId: "test-provider", priority: 10, configured, available: configured, selected: configured || primary !== "auto", lastError: null }],
      error: configured ? null : "没有可用的临时图床", lastFailure: null,
    } },
  };
}

it("临时图床列表只展示已配置来源，就绪说明留在配置入口", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: null,
      candidates: [
        { exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider" as const, ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: true, available: false, selected: false, statusNote: null, lastError: null }
      ],
      error: "没有可用的临时图床，请检查提供商配置",
      lastFailure: null
    } }
  } }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write: async () => ({ ok: false as const, code: "unavailable", error: "test" }) }));
  await act(async () => { await Promise.resolve(); });
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).not.toContain("SDPPPX");
  expect(detail.querySelectorAll("ul li")).toHaveLength(1);
  expect(detail.textContent).toContain("COS / S3 对象存储");
  expect(detail.textContent).toContain("当前请求不可用");
  await f.click("配置");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("未登录 SDPPPX");
});

it("模型目录读取失败不影响图床数量与配置，保存失败保留密钥，成功后返回详情刷新状态", async () => {
  const snapshot = () => hostingSnapshot(configured);
  let configured = false;
  const write = vi.fn(async (_values: unknown) => { configured = true; return { ok: true as const, snapshot: snapshot() }; })
    .mockResolvedValueOnce({ ok: false, code: "unavailable", error: "保存失败，请重试" } as never);
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() }), write }), {}, {
    listServiceConnections: async () => ({ ok: false, code: "unavailable", error: "目录读取失败" }),
  });
  expect(f.el.querySelector('[data-capability="image"]')?.textContent).toContain("读取失败");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 0 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toContain("读取失败");
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  expect(f.el.querySelector('[data-page="overview"]')?.getAttribute("data-state")).toBe("active");
  const field = f.el.querySelector<HTMLInputElement>('.agent-assistant__drawer [data-setting-key="providers.test.apiKey"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "test-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("保存");
  expect(field.value).toBe("test-key");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("保存失败，请重试");
  await f.click("保存");
  expect(write).toHaveBeenLastCalledWith({ "providers.test.apiKey": "test-key" });
  expect(f.el.querySelector(".agent-assistant__drawer")).toBeNull();
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).toContain("已配置 1 个提供商");
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).not.toContain("当前选择");
  expect(f.el.querySelector('[data-hosting-priority="first"]')?.closest("li")?.textContent).toContain("测试图床");
});

function sortableHostingSnapshot() {
  const snapshot = hostingSnapshot(true, "test-hosting");
  snapshot.settings.push({ ...snapshot.settings[0]!, key: "exposer.order", value: "", lockedBy: null });
  const route = snapshot.extensionPoints!.temporaryHosting!;
  snapshot.extensionPoints!.temporaryHosting = { ...route, candidates: [
    ...route.candidates,
    { ...route.candidates[0]!, exposerId: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", selected: false },
    { ...route.candidates[0]!, exposerId: "sdpppx-temporary", label: "SDPPPX", ownerExtensionId: "sdpppx-provider", configured: false, available: false, selected: false }
  ] };
  return snapshot;
}

function hostingPointer(target: EventTarget, type: string, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function mockHostingRects(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-hosting-id]").forEach(row => {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const index = [...row.parentElement!.children].indexOf(row);
      const offset = Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0);
      return { top: index * 80 + offset, height: 80 } as DOMRect;
    });
  });
}

it("临时图床在列表拖动排序，保存失败保留顺序并可重试，成功后刷新保持排序", async () => {
  const snapshot = sortableHostingSnapshot();
  const write = vi.fn(async () => {
    const route = snapshot.extensionPoints!.temporaryHosting!;
    snapshot.extensionPoints!.temporaryHosting = {
      ...route, mode: "auto", selectionSource: "auto", selectedId: "cos",
      candidates: [route.candidates[1]!, route.candidates[0]!, route.candidates[2]!]
    };
    snapshot.settings.find(entry => entry.key === "exposer.order")!.value = "cos,test-hosting,sdpppx-temporary";
    return { ok: true as const, snapshot: { ...snapshot } };
  }).mockResolvedValueOnce({ ok: false, code: "unavailable", error: "暂时无法保存" } as never);
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  expect(f.el.querySelector('[aria-label="临时图床来源"]')).toBeNull();
  const ids = () => [...f.el.querySelectorAll<HTMLElement>("[data-hosting-id]")].map(row => row.dataset.hostingId);
  mockHostingRects(f.el);
  const handle = f.el.querySelector<HTMLButtonElement>('[data-hosting-id="cos"] .agent-assistant__hosting-drag')!;
  const dragged = handle.closest("li")!;
  const neighbour = f.el.querySelector<HTMLElement>('[data-hosting-id="test-hosting"]')!;
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  neighbour.animate = animate as unknown as HTMLElement["animate"];
  dragged.animate = animate as unknown as HTMLElement["animate"];
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 118));
  expect(dragged.style.transform).toBe("translateY(-2px)");
  expect(ids()).toEqual(["test-hosting", "cos"]);
  await act(async () => hostingPointer(document, "pointermove", 100));
  expect(dragged.style.transform).toBe("translateY(-20px)");
  expect(ids()).toEqual(["test-hosting", "cos"]);
  await act(async () => hostingPointer(document, "pointermove", 10));
  expect(ids()).toEqual(["cos", "test-hosting"]);
  expect(dragged.getBoundingClientRect().top).toBe(-30);
  expect(animate).toHaveBeenCalledWith([{ transform: "translateY(-80px)" }, { transform: "translateY(0px)" }], expect.objectContaining({ duration: 180 }));
  expect(f.el.querySelector('[data-hosting-priority="first"]')?.closest("li")?.getAttribute("data-hosting-id")).toBe("cos");
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).not.toContain("当前选择");
  expect(write).not.toHaveBeenCalled();
  await act(async () => hostingPointer(document, "pointerup", 10));
  expect(dragged.style.transform).toBe("");
  expect(animate).toHaveBeenCalledWith([{ transform: "translateY(-30px)" }, { transform: "translateY(0px)" }], expect.objectContaining({ duration: 180 }));
  expect(f.el.textContent).toContain("暂时无法保存");
  expect(ids()).toEqual(["cos", "test-hosting"]);
  await f.click("重试");
  expect(write).toHaveBeenLastCalledWith({ "exposer.order": "cos,test-hosting,sdpppx-temporary", "exposer.primary": "auto" });
  expect(ids()).toEqual(["cos", "test-hosting"]);
  expect(f.el.textContent).not.toContain("暂时无法保存");
  await f.click("刷新状态");
  expect(ids()).toEqual(["cos", "test-hosting"]);
});

it("取消拖动或拖回原位置不保存，配置抽屉只提供来源配置", async () => {
  const snapshot = sortableHostingSnapshot();
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  mockHostingRects(f.el);
  const handle = f.el.querySelector<HTMLButtonElement>('[data-hosting-id="cos"] .agent-assistant__hosting-drag')!;
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 10));
  await act(async () => hostingPointer(document, "pointercancel", 10));
  expect(f.el.querySelector<HTMLElement>("[data-hosting-id]")!.dataset.hostingId).toBe("test-hosting");
  expect(handle.closest("li")!.style.transform).toBe("");
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 10));
  await act(async () => hostingPointer(document, "pointerup", 120));
  expect(write).not.toHaveBeenCalled();
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer [role="combobox"]')).toBeNull();
  expect(f.el.querySelector('.agent-assistant__drawer')?.textContent).toContain("SDPPPX");
});

it("临时图床来源有专用贡献时，配置抽屉渲染扩展自己的就绪面板", async () => {
  const snapshot = hostingSnapshot(false);
  snapshot.extensionPoints!.temporaryHosting = {
    ...snapshot.extensionPoints!.temporaryHosting!,
    candidates: [{ exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider", ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null }],
    selectedId: null,
    error: "没有可用的临时图床"
  };
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }), {}, {}, undefined, false, true);
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  const drawer = f.el.querySelector(".agent-assistant__drawer")!;
  expect(drawer.textContent).toContain("来源自己的登录面板");
  expect(drawer.textContent).not.toContain("当前来源没有可编辑的配置");
  expect(write).not.toHaveBeenCalled();
});

it("没有专用贡献时，来源不可编辑就如实说明，不伪造登录或上传", async () => {
  const snapshot = hostingSnapshot(false);
  snapshot.extensionPoints!.temporaryHosting = {
    ...snapshot.extensionPoints!.temporaryHosting!,
    candidates: [{ exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider", ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null }],
    selectedId: null,
    error: "没有可用的临时图床"
  };
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("当前来源没有可编辑的配置");
  expect(write).not.toHaveBeenCalled();
});

it("环境锁定的图床来源禁止排序，配置抽屉不再展示自动或手动下拉框", async () => {
  const snapshot = sortableHostingSnapshot();
  snapshot.settings[0]!.lockedBy = "WOOHAA_EXPOSER";
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  expect([...f.el.querySelectorAll<HTMLButtonElement>(".agent-assistant__hosting-drag")].every(button => button.disabled)).toBe(true);
  expect(f.el.textContent).toContain("WOOHAA_EXPOSER");
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer [aria-label="临时图床来源"]')).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it("Agent 详情无目标仅配置，来源不可用禁用使用", async () => {
  const source = declaredSite({ serviceConnectionId: "svc", name: "文字提供商", scope: "personal", managedByAdministrator: false });
  const connection = { ...api, connectionId: "auto-c1", name: "文字提供商", serviceConnectionId: "svc", ready: true } as AgentConnectionView;
  const noTarget = await render([connection], true, undefined, { canvasId: "canvas" }, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [source], duplicates: [], providers: [] } }),
  });
  await noTarget.click("Agent");
  const noTargetButtons = [...noTarget.el.querySelectorAll('[data-capability-detail="agent"] button')].map(button => button.textContent);
  expect(noTargetButtons).toContain("配置");
  expect(noTargetButtons).not.toContain("使用");
  await act(async () => { root?.unmount(); }); root = undefined; await runtime?.dispose(); runtime = undefined; document.body.innerHTML = "";
  const unavailable = await render([{ ...connection, ready: false, credentialConfigured: false }], true, undefined, { canvasId: "canvas", nodeId: "node" }, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [{ ...source, credentialConfigured: false }], duplicates: [], providers: [] } }),
  });
  await unavailable.click("Agent");
  const disabled = [...unavailable.el.querySelectorAll<HTMLButtonElement>('[data-capability-detail="agent"] button')].find(button => button.textContent === "使用");
  expect(disabled?.disabled).toBe(true);
  expect(unavailable.el.querySelector('[data-capability-detail="agent"]')?.textContent).toContain("待配置密钥");
});




it("COS 图床复用存储配置，保存后进入已配置列表且可再次编辑", async () => {
  let configured = false;
  const snapshot = (): SettingsSnapshot => ({
    settings: [{
      key: "storage.cos.secretId", kind: "string", label: "SecretId", description: "", reload: "hot", secret: true,
      source: "file", lockedBy: null, value: null, configured, pendingRestart: false, ownerExtensionId: "cos-storage"
    }],
    plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto", selectionSource: "auto", selectedId: configured ? "cos" : null,
      candidates: [{ exposerId: "cos", label: "COS / S3 对象存储", category: "provider", ownerExtensionId: "cos-storage", priority: 100,
        configured, available: configured, selected: configured, lastError: null }], error: null, lastFailure: null
    } }
  });
  const write = vi.fn(async () => { configured = true; return { ok: true as const, snapshot: snapshot() }; });
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() }), write }));
  await f.click("临时图床");
  expect(f.el.querySelectorAll('[data-capability-detail="hosting"] li')).toHaveLength(0);
  await f.click("配置");
  await act(async () => f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!.click());
  const field = f.el.querySelector<HTMLInputElement>('[data-setting-key="storage.cos.secretId"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "cos-id");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("保存");
  expect(write).toHaveBeenLastCalledWith({ "storage.cos.secretId": "cos-id" });
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("已配置 1 个提供商");
  expect(detail.querySelectorAll("li")).toHaveLength(1);
  expect(detail.textContent).toContain("COS / S3 对象存储");
  await act(async () => detail.querySelector<HTMLButtonElement>("li .agent-assistant__actions button")!.click());
  expect(f.el.querySelector('[data-setting-key="storage.cos.secretId"]')).not.toBeNull();
});
