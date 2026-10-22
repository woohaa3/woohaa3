/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { AgentAssistant } from "./assistant.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { SelectInput } from "../../../shared/ui/FormControls.js";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { AgentConnectionView } from "@woohaa3/contracts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let runtime: FrontendRuntime | undefined;
function DraftInput() {
  const [value, setValue] = useState("");
  return <input aria-label="新增 API Key" value={value} onChange={event => setValue(event.target.value)} />;
}
afterEach(async () => { act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; });
async function render(connections: AgentConnectionView[] = [], configure = false, settingsStore?: ReturnType<typeof createBackendSettingsStore>, payload: {canvasId?: string; nodeId?: string; kind?: string} = {canvasId: "canvas", nodeId: "node"}) {
  const slots = new SlotRegistry();
  if (configure) slots.register("agent-assistant.configuration", { id: "api", owner: "sdk-agent", kind: "api-key", label: "API Key", render: ({ onSaved }) => <><DraftInput /><button onClick={() => onSaved?.("c1")}>保存测试连接</button><SelectInput label="配置类型" value="one" onValueChange={() => {}} options={[{value:"one",label:"类型一"},{value:"two",label:"类型二"}]} /></> });
  if (configure) slots.register("agent-assistant.configuration", { id: "local", owner: "local-agent", kind: "installed", label: "调用本机 Agent", render: () => <p>本机工具配置</p> });
  const listConnections = vi.fn(async () => ({ ok: true as const, value: connections }));
  const service = { listConnections } as unknown as AgentConversationService;
  runtime = await startFrontendRuntime({ installPlatform: (ctx) => { ctx.provide("slots" as never, slots as never); }, plugins: [] });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  const close = vi.fn();
  const updatePayload = async (next: typeof payload) => { await act(async () => { root!.render(<RuntimeProvider runtime={runtime!}><AgentAssistant settingsStore={settingsStore} service={service} payload={next} onClose={close} /></RuntimeProvider>); }); };
  await updatePayload(payload);
  const click = async (label: string) => { const button = [...el.querySelectorAll("button")].find((item) => (item.querySelector("strong")?.textContent ?? item.textContent) === label); expect(button).toBeDefined(); await act(async () => button!.click()); };
  return { el, click, service, listConnections, close, updatePayload };
}
it("全部扩展缺失仍能添加和读取外部指引，打开不推理", async () => {
  const f = await render();
  expect(f.el.textContent).toContain("连接你的第一个助手");
  expect([...f.el.querySelectorAll(".agent-assistant__tabs > button")].map(button => button.textContent)).toEqual(["助手", "生成服务", "MCP"]);
  expect(f.el.querySelector('[data-ai-tab="intelligence"]')!.textContent).not.toContain("MCP");
  await f.click("MCP");
  expect(f.el.textContent).toContain("安装这个 MCP 服务：");
  await f.click("助手");
  await f.click("添加助手");
  for (const text of ["授权", "调用本机 Agent", "API Key"]) expect(f.el.textContent).toContain(text);
  expect(f.el.querySelectorAll("button:disabled")).toHaveLength(3);
  expect(f.listConnections).toHaveBeenCalledTimes(1);
});
it("配置贡献的下拉浮层归属助手弹窗，不落到应用背景层", async () => {
  const f = await render([], true);
  await f.click("添加助手"); await f.click("API Key");
  await act(async () => f.el.querySelector<HTMLButtonElement>('button[aria-label="配置类型"]')!.click());
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === "类型二");
  expect(option?.closest(".agent-assistant")).toBe(f.el.querySelector(".agent-assistant"));
  expect(option?.closest("[data-ui-portal-scope]")).not.toBeNull();
  await f.click("调用本机 Agent");
  expect(option?.closest("[hidden]")).not.toBeNull();
  await f.click("API Key");
  await f.click("MCP");
  for (const popup of f.el.querySelectorAll('[data-ui-portal-scope] [data-ui-popover]')) expect(popup.closest("[hidden]")).not.toBeNull();
  expect(f.el.querySelector('[data-ai-tab="intelligence"]')?.hasAttribute("hidden")).toBe(true);
});
it("同一容器内添加、诊断并显式用于作品；关闭不执行", async () => {
  const connection = { connectionId: "c1", extensionId: "sdk-agent", name: "我的 API", authMode: "api-key", ready: false, status: { transport: { state: "unknown" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } } } as AgentConnectionView;
  const f = await render([connection], true);
  await f.click("添加助手"); await f.click("API Key");
  expect(f.el.querySelectorAll(".agent-assistant")).toHaveLength(1);
  await f.click("保存测试连接");
  expect(f.el.textContent).toContain("我的 API");
  expect([...f.el.querySelectorAll("h3")].some(heading => heading.textContent === "助手已保存")).toBe(false);
  expect(f.el.querySelector(".agent-assistant__list")).not.toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  await f.click("管理");
  expect(f.el.querySelector<HTMLDetailsElement>(".agent-assistant__diagnostics")!.open).toBe(false);
  expect(f.el.textContent).toContain("已保存（模型权限待验证）");
  await f.click("所有助手");
  const selected = vi.fn(); globalThis.addEventListener("woohaa3-agent-assistant-selection", selected);
  try { await f.click("使用"); expect(selected).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1); }
  finally { globalThis.removeEventListener("woohaa3-agent-assistant-selection", selected); }
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
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "MCP")!.click());
  expect(el.querySelector('[data-ai-tab="mcp"]')?.textContent).toContain("画布 current-canvas");
  act(() => root!.unmount()); root = undefined;
  await runtime.dispose();
  runtime = undefined;
  expect(slots.list("canvas.toolbar-action")).toHaveLength(0);
  expect(dialogs.open({ dialogId: "agent-assistant", payload: {} }).ok).toBe(false);
  globalThis.dispatchEvent(new CustomEvent("woohaa3-open-agent-assistant"));
  expect(dialogs.top()).toBeNull();
});


it("外部指引复制给出反馈，地址使用应用挂载前缀且不声称连接", async () => {
  const { setAppBasePathForTesting } = await import("../../services/app-base-path.js");
  setAppBasePathForTesting("/workspace");
  const writeText = vi.fn(async (_text: string) => undefined);
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const f = await render();
    await f.click("MCP");
    expect(f.el.querySelector(".agent-assistant__mcp > code")).toBeNull();
    expect(f.el.textContent).not.toContain("复制地址");
    await f.click("复制安装指引");
    expect(writeText.mock.calls[0]?.[0]).toContain("安装这个 MCP 服务：");
    expect(writeText.mock.calls[0]?.[0]).toContain("/workspace/mcp/model-canvas");
    expect(f.el.textContent).toContain("已复制");
    await f.click("复制画布指引");
    expect(writeText.mock.calls[1]?.[0]).toContain("画布 canvas");
    expect(f.el.querySelectorAll(".agent-assistant__mcp-field")).toHaveLength(2);
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await f.click("复制安装指引");
    expect(f.el.textContent).toContain("复制失败，请手动选择并复制内容，或点击按钮重试。");
  } finally {
    setAppBasePathForTesting("");
    if (previous) Object.defineProperty(navigator, "clipboard", previous); else Reflect.deleteProperty(navigator, "clipboard");
  }
});


it("列表只显示名称和实际异常，常态身份与检查信息留在管理页", async () => {
  const status = { transport: { state: "unknown" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } };
  const connections = [
    { connectionId: "oauth", extensionId: "oauth-agent", name: "我的账号", authMode: "oauth", status },
    { connectionId: "local", extensionId: "local-agent", name: "我的工具", authMode: "local-login", reason: "尚未确认本机 Codex 配置或账号；执行时会启动专用进程并核对", status },
    { connectionId: "api", extensionId: "sdk-agent", name: "我的 API", authMode: "api-key", status: { ...status, credential: { state: "failed", reason: "Key 已失效，请替换" } } }
  ] as AgentConnectionView[];
  const f = await render(connections);
  expect(f.el.querySelector(".agent-assistant__navigation h3")?.textContent).toBe("当前已配置助手");
  for (const text of ["我的账号", "我的工具", "我的 API", "Key 已失效，请替换"]) expect(f.el.textContent).toContain(text);
  for (const text of ["个人账号", "本机工具", "模型 API", "已保存，生成与目标能力待验证", "当前检查通过", "助手运行在应用宿主机器", "尚未确认本机 Codex 配置"]) expect(f.el.textContent).not.toContain(text);
});

it("管理直接进入当前助手配置；列表中的使用只选择目标", async () => {
  const status = { transport: { state: "unknown" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } };
  const f = await render([{ connectionId: "c1", extensionId: "sdk-agent", name: "我的 API", authMode: "api-key", status } as AgentConnectionView], true);
  await f.click("管理");
  expect(f.el.textContent).toContain("保存测试连接");
  expect(f.el.textContent).not.toContain("配置与检查");
  await f.click("所有助手");
  const selected = vi.fn(); globalThis.addEventListener("woohaa3-agent-assistant-selection", selected);
  try {
    await f.click("使用");
    expect(selected.mock.calls[0]![0].detail).toEqual({ canvasId: "canvas", nodeId: "node", connectionId: "c1" });
    expect(f.close).toHaveBeenCalledOnce();
  } finally { globalThis.removeEventListener("woohaa3-agent-assistant-selection", selected); }
});


it("仅点击选择完整宽度表单，悬停与移开不改变选择，跨方式/tab 保留草稿且不执行", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const f = await render([], true);
    await f.click("添加助手");
    const api = f.el.querySelector<HTMLElement>('[data-kind="api-key"]')!;
    const local = f.el.querySelector<HTMLElement>('[data-kind="installed"]')!;
    await act(async () => api.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(f.el.querySelector("input")).toBeNull();
    // Touch activation follows the same click path, without a preceding hover.
    await act(async () => {
      api.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      api.dispatchEvent(new Event("pointerup", { bubbles: true }));
      api.click();
    });
    const field = f.el.querySelector<HTMLInputElement>('input[aria-label="新增 API Key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "draft-key");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      api.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: local }));
      local.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(api.dataset.selected).toBe("true");
    expect(field.closest("[hidden]")).toBeNull();
    await f.click("API Key"); // Selecting the same method does not collapse it.
    expect(field.closest("[hidden]")).toBeNull();
    await f.click("调用本机 Agent");
    expect(field.closest("[hidden]")).not.toBeNull();
    expect(f.el.querySelectorAll("[data-form-kind]:not([hidden])")).toHaveLength(1);
    await f.click("API Key");
    expect(f.el.querySelector("input")).toBe(field);
    expect(field.value).toBe("draft-key");
    for (const tab of ["MCP", "生成服务"]) {
      await f.click(tab);
      expect(field.closest("[hidden]")).not.toBeNull();
      await f.click("助手");
      expect(field.closest("[hidden]")).toBeNull();
      expect(field.value).toBe("draft-key");
      expect(api.dataset.selected).toBe("true");
    }
    expect(f.listConnections).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/mcp-installation", expect.objectContaining({ method: "GET" }));
    expect(f.el.querySelector(".agent-assistant__list")).toBeNull();
  } finally { fetch.mockRestore(); }
});

it("生成 tab 惰性读取现有 Provider 设置，复用密钥与地址表单", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: { settings: [
    { key: "providers.test.apiKey", kind: "string" as const, label: "API Key", description: "", reload: "hot" as const, secret: true, source: null, lockedBy: null, value: null, configured: true, pendingRestart: false, group: "测试 Provider" },
    { key: "providers.test.baseUrl", kind: "url" as const, label: "地址", description: "", reload: "hot" as const, secret: false, source: null, lockedBy: null, value: "https://example.com", configured: true, pendingRestart: false, group: "测试 Provider" }
  ], plugins: [], files: { config: "c", secrets: "s" } } }));
  const write = vi.fn(async () => ({ ok: false as const, code: "unavailable", error: "test" }));
  const store = createBackendSettingsStore({ fetchSnapshot, write });
  const f = await render([], false, store);
  expect(fetchSnapshot).not.toHaveBeenCalled();
  await act(async () => { await f.click("生成服务"); await import("../settings/provider-settings-cards.js"); });
  expect(f.el.querySelector('[data-testid="provider-settings-list"]')).not.toBeNull();
  expect(f.el.querySelector('[data-setting-key="providers.test.apiKey"] input')?.getAttribute("type")).toBe("password");
  expect(f.el.querySelector('[data-setting-key="providers.test.baseUrl"]')).not.toBeNull();
  expect(write).not.toHaveBeenCalled();
});


it.each(["api-key", "installed", "login", "generation", "mcp"])("旧 kind=%s 入口保持兼容且不写配置", async kind => {
  const f = await render([], true, undefined, { canvasId: "canvas", kind });
  const expectedTab = ["generation", "mcp"].includes(kind) ? kind : "intelligence";
  expect(f.el.querySelector('.agent-assistant__tabs [data-state="active"]')?.textContent).toBe(({ intelligence: "助手", generation: "生成服务", mcp: "MCP" })[expectedTab as "intelligence" | "generation" | "mcp"]);
  if (kind === "api-key") expect(f.el.querySelector('input[aria-label="新增 API Key"]')).not.toBeNull();
  if (kind === "installed") expect(f.el.textContent).toContain("本机工具配置");
  if (kind === "login") expect(f.el.textContent).toContain("当前环境未启用此连接的配置扩展");
  expect(f.listConnections).toHaveBeenCalledTimes(1);
  expect(f.close).not.toHaveBeenCalled();
});
