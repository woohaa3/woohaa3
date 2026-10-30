/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConnectionView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { CanvasToolbarHost } from "../../host.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { DialogService } from "../../services/dialogs/service.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { agentAssistantExtension } from "./plugin.js";
import { assistantFirstUseKey } from "./first-use.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let runtime: FrontendRuntime | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  await runtime?.dispose();
  document.body.innerHTML = "";
  localStorage.clear();
});

const apiKeyEntry = (configured: boolean): SettingsEntryView => ({
  key: "providers.test.apiKey",
  kind: "string",
  label: "API Key",
  description: "",
  reload: "hot",
  secret: true,
  source: configured ? "secrets" : null,
  lockedBy: null,
  value: null,
  configured,
  pendingRestart: false
});
const settingsSnapshot = (apiKeyConfigured: boolean): SettingsSnapshot => ({
  settings: [apiKeyEntry(apiKeyConfigured)],
  plugins: [],
  files: { config: "c", secrets: "s" }
});

async function render(listConnections: AgentConversationService["listConnections"], apiKeyConfigured = false) {
  // These tests cover the persistent corner hint after first-use onboarding was dismissed.
  localStorage.setItem(assistantFirstUseKey("first"), "seen");
  localStorage.setItem(assistantFirstUseKey("second"), "seen");
  const dialogs = new DialogService();
  dialogs.registerDialog("probe", { definition: { validatePayload: payload => ({ ok: true, payload }) } });
  const slots = new SlotRegistry();
  const listeners = new Set<() => void>();
  let user = { dataScopeId: "first" };
  let hasApiKey = apiKeyConfigured;
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: settingsSnapshot(hasApiKey) }));
  const service = { listConnections, catalog: vi.fn(), getDataScopeId: () => user.dataScopeId } as unknown as AgentConversationService;
  runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("slots" as never, slots as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("agentConversationService" as never, service as never);
    ctx.provide("settingsRemote" as never, { fetchSnapshot, write: vi.fn() } as never);
    ctx.provide("currentUser" as never, {
      getSnapshot: () => user,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } as never);
    ctx.provide("canvasSession" as never, { subscribe: () => () => undefined, getStatus: () => ({ phase: "ready" }) } as never);
    ctx.provide("canvasNavigation" as never, { openDialog: (request: Parameters<typeof dialogs.open>[0]) => dialogs.open(request) } as never);
  }, plugins: [{ id: "agent-assistant", required: true, plugin: agentAssistantExtension() }] });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<RuntimeProvider runtime={runtime!}><CanvasToolbarHost revision={0} writable /></RuntimeProvider>));
  return { service, dialogs, fetchSnapshot, switchScope: async (dataScopeId: string) => {
    await act(async () => { user = { dataScopeId }; for (const listener of listeners) listener(); });
  }, saveApiKey: async (configured: boolean) => {
    // 密钥写入发生在弹窗内；关掉弹窗后引导重读配置。
    hasApiKey = configured;
    await act(async () => { dialogs.open({ dialogId: "probe", payload: {} }); });
    await act(async () => { dialogs.closeTop(); });
  } };
}

const guidance = () => document.querySelector(".ui-tooltip")?.textContent;

it("shows guidance only after an empty result, opens configuration, and removes guidance when a connection is saved", async () => {
  let resolve!: (value: { ok: true; value: AgentConnectionView[] }) => void;
  const list = vi.fn(() => new Promise<{ ok: true; value: AgentConnectionView[] }>(done => { resolve = done; }));
  const f = await render(list);
  expect(guidance()).toBeUndefined();
  await act(async () => resolve({ ok: true, value: [] }));
  expect(guidance()).toContain("尚未配置助手，点击这里配置");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="AI 助手"]')!.click());
  expect(f.dialogs.top()?.dialogId).toBe("agent-assistant");
  expect(guidance()).toBeUndefined();
  list.mockResolvedValue({ ok: true, value: [{ connectionId: "saved", adapterId: "sdk" }] as AgentConnectionView[] });
  (f.service.catalog as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { models: [] } });
  await act(async () => { await agentDirectory(f.service, "first").load(true); f.dialogs.close(f.dialogs.top()!.instanceId); });
  expect(guidance()).toBeUndefined();
});

it("keeps the guidance on screen regardless of hover, Escape, or other dismissals", async () => {
  const list = vi.fn<AgentConversationService["listConnections"]>().mockResolvedValue({ ok: true, value: [] });
  await render(list);
  await act(async () => { await agentDirectory({ listConnections: list } as unknown as AgentConversationService, "first"); });
  expect(guidance()).toContain("尚未配置助手");
  // 受控常驻：悬停结束、Escape、滚动都不关闭。
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="AI 助手"]')!.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new Event("pointermove", { bubbles: true }));
  });
  expect(guidance()).toContain("尚未配置助手");
});

it("hides the guidance after a model API key is saved, without any assistant connection", async () => {
  const list = vi.fn<AgentConversationService["listConnections"]>().mockResolvedValue({ ok: true, value: [] });
  const f = await render(list);
  expect(guidance()).toContain("尚未配置助手");
  // 写入发生在弹窗内；关闭弹窗后重读配置，发现密钥已保存即不再提示。
  await f.saveApiKey(true);
  expect(guidance()).toBeUndefined();
  await f.saveApiKey(false);
  expect(guidance()).toContain("尚未配置助手");});

it("does not mistake a failed read or another data space's empty result for an unconfigured account", async () => {
  const list = vi.fn<AgentConversationService["listConnections"]>().mockResolvedValue({ ok: false, code: "unavailable", error: "读取失败" });
  const f = await render(list);
  expect(guidance()).toBeUndefined();
  list.mockResolvedValue({ ok: true, value: [] });
  await act(async () => { await agentDirectory(f.service, "first").load(true); });
  expect(guidance()).toContain("尚未配置助手");
  list.mockResolvedValue({ ok: false, code: "unavailable", error: "另一个空间读取失败" });
  await f.switchScope("second");
  expect(guidance()).toBeUndefined();
});
