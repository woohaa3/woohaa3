/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConnectionView } from "@woohaa3/contracts";
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

async function render(listConnections: AgentConversationService["listConnections"]) {
  // These tests cover the persistent corner hint after first-use onboarding was dismissed.
  localStorage.setItem(assistantFirstUseKey("first"), "seen");
  localStorage.setItem(assistantFirstUseKey("second"), "seen");
  const dialogs = new DialogService();
  const slots = new SlotRegistry();
  const listeners = new Set<() => void>();
  let user = { dataScopeId: "first" };
  const service = { listConnections, catalog: vi.fn(), getDataScopeId: () => user.dataScopeId } as unknown as AgentConversationService;
  runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("slots" as never, slots as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("agentConversationService" as never, service as never);
    ctx.provide("currentUser" as never, {
      getSnapshot: () => user,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } as never);
    ctx.provide("canvasSession" as never, { subscribe: () => () => undefined, getStatus: () => ({ phase: "ready" }) } as never);
    ctx.provide("canvasNavigation" as never, { openDialog: (request: Parameters<typeof dialogs.open>[0]) => dialogs.open(request) } as never);
  }, plugins: [{ id: "agent-assistant", required: true, plugin: agentAssistantExtension() }] });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<RuntimeProvider runtime={runtime!}><CanvasToolbarHost revision={0} writable /></RuntimeProvider>));
  return { service, dialogs, switchScope: async (dataScopeId: string) => {
    await act(async () => { user = { dataScopeId }; for (const listener of listeners) listener(); });
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
