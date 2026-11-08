/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vitest";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { AgentAssistant } from "./assistant.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { SelectInput } from "@woohaa3/ui/forms";
import { UiProvider } from "@woohaa3/ui/primitives";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { GenerationModelsStatusService } from "../../services/generation-models-status.js";
import type { AgentConnectionView, ServiceConnectionView } from "@woohaa3/contracts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let runtime: FrontendRuntime | undefined;

function DraftInput() {
  const [value, setValue] = useState("");
  return <input aria-label="新增 API Key" value={value} onChange={event => setValue(event.target.value)} />;
}

export async function cleanupHarness() { act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; }

export async function render(connections: AgentConnectionView[] = [], configure = false, settingsStore?: ReturnType<typeof createBackendSettingsStore>, payload: {canvasId?: string; nodeId?: string; kind?: string; page?: "add"; connectionId?: string; section?: "generation-history" | "diagnostics"} = {canvasId: "canvas", nodeId: "node"}, overrides: Partial<AgentConversationService> = {}, models?: Pick<GenerationModelsStatusService, "getSnapshot" | "subscribe">) {
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
  const updatePayload = async (next: typeof payload) => { await act(async () => { root!.render(<RuntimeProvider runtime={runtime!}><UiProvider><AgentAssistant settingsStore={settingsStore} service={service} payload={next} onClose={close} /></UiProvider></RuntimeProvider>); }); };
  await updatePayload(payload);
  const click = async (label: string) => { const button = [...el.querySelectorAll("button")].find((item) => !item.closest("[hidden]") && (item.querySelector("strong")?.textContent ?? item.getAttribute("aria-label") ?? (item.matches("[data-page]") ? item.querySelector("span")?.textContent : item.textContent)) === label); expect(button).toBeDefined(); await act(async () => button!.click()); };
  const configureMethod = async (label: string) => {
    const card = [...el.querySelectorAll(".agent-assistant__method")].find(item => !item.closest("[hidden]") && item.querySelector("strong")?.textContent === label);
    expect(card).toBeDefined();
    await act(async () => card!.querySelector<HTMLButtonElement>("button")!.click());
  };
  return { el, click, configure: configureMethod, service, listConnections, close, updatePayload };
}

const status = { transport: { state: "unknown" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } };
export const api = { connectionId: "c1", extensionId: "sdk-agent", name: "我的 API", authMode: "api-key", ready: true, status } as AgentConnectionView;
export const local = { ...api, connectionId: "local", extensionId: "local-agent", authMode: "local-login", name: "本地 Codex" } as AgentConnectionView;
export const oauth = { ...api, connectionId: "oauth", extensionId: "oauth-agent", authMode: "oauth", name: "me@example.com" } as AgentConnectionView;

export const declaredSite = (overrides: Partial<ServiceConnectionView> = {}): ServiceConnectionView => ({
  serviceConnectionId: "site-provider", scope: "site", kind: "api", name: "声明提供商",
  endpoints: [{ protocol: "chat-completions", baseUrl: "https://relay.example/v1" }],
  capabilities: [{ purpose: "discussion", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" }],
  bindings: [{ bindingId: "provider-assistant:demo", extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["discussion"], modelKeys: ["model"] }],
  enabled: true, removed: false, credentialConfigured: true, locked: false, managedByAdministrator: false, configRevision: 1, credentialEpoch: 1,
  ...overrides,
});
