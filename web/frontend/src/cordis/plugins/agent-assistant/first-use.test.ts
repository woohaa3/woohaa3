/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConnectionView } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../../services/current-user.js";
import type { CanvasSession } from "../../services/canvas-session.js";
import { DialogService } from "../../services/dialogs/service.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { assistantFirstUseKey, installAssistantFirstUse } from "./first-use.js";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); localStorage.clear(); vi.restoreAllMocks(); });
const ok = (value: AgentConnectionView[] = []) => ({ ok: true as const, value });
const configured = [{ connectionId: "configured", adapterId: "api" }] as AgentConnectionView[];

function fixture(phase = "ready") {
  const listeners = new Set<() => void>();
  let userSnapshot: { dataScopeId: string } | null = { dataScopeId: "first" };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const list = vi.fn<AgentConversationService["listConnections"]>().mockResolvedValue(ok());
  const service = { listConnections: list, catalog: async () => ({ ok: true, value: { models: [] } }) } as unknown as AgentConversationService;
  const dialogs = new DialogService();
  for (const dialogId of ["agent-assistant", "other"]) dialogs.registerDialog(dialogId, {
    definition: { validatePayload: payload => ({ ok: true, payload }) },
  });
  const open = vi.fn(() => dialogs.open({ dialogId: "agent-assistant", payload: {} }));
  const options = { service, dialogs, open,
    user: { subscribe, getSnapshot: () => userSnapshot } as Pick<CurrentUserService, "subscribe" | "getSnapshot">,
    session: { subscribe, getStatus: () => ({ phase }) } as Pick<CanvasSession, "subscribe" | "getStatus">,
  };
  const start = () => { const dispose = installAssistantFirstUse(options); disposers.push(dispose); return dispose; };
  const notify = () => { for (const listener of listeners) listener(); };
  const flush = async (scope = userSnapshot?.dataScopeId ?? "first") => {
    await Promise.resolve();
    if (phase === "ready" && userSnapshot) await agentDirectory(service, scope).load();
    await Promise.resolve();
  };
  return { service, dialogs, open, list, start, flush,
    setPhase: (next: string) => { phase = next; notify(); },
    setScope: (scope: string | null) => { userSnapshot = scope ? { dataScopeId: scope } : null; notify(); },
  };
}

it("waits for canvas readiness, then opens the AI capability center once and respects closing across restarts", async () => {
  const f = fixture("loading");
  const stop = f.start();
  await f.flush();
  expect(f.list).not.toHaveBeenCalled();
  f.setPhase("ready");
  await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.dialogs.top()?.payload).toEqual({});
  expect(localStorage.getItem(assistantFirstUseKey("first"))).toBe("seen");
  f.dialogs.closeTop(); await f.flush();
  stop(); f.start(); await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
});

it("remembers a configured first visit so deleting its connections later does not trigger onboarding", async () => {
  const f = fixture(); f.list.mockResolvedValue(ok(configured));
  f.start(); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
  expect(localStorage.getItem(assistantFirstUseKey("first"))).toBe("seen");
  f.list.mockResolvedValue(ok()); await agentDirectory(f.service, "first").load(true); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not consume first use on a failed read and can open after a successful retry", async () => {
  const f = fixture(); f.list.mockResolvedValue({ ok: false, code: "unavailable", error: "读取失败" });
  f.start(); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
  expect(localStorage.getItem(assistantFirstUseKey("first"))).toBeNull();
  f.list.mockResolvedValue(ok()); await agentDirectory(f.service, "first").load(true); await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
});

it("defers behind other dialogs and opens after they close", async () => {
  const f = fixture(); f.dialogs.open({ dialogId: "other" });
  f.start(); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
  f.dialogs.closeTop(); await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
});

it("respects an explicitly opened assistant instead of reopening it on close", async () => {
  const f = fixture(); f.dialogs.open({ dialogId: "agent-assistant", payload: { kind: "api-key" } });
  f.start(); await f.flush();
  f.dialogs.closeTop(); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
});

it("ignores a previous data space's late empty result", async () => {
  const f = fixture(); let resolve!: (value: ReturnType<typeof ok>) => void;
  f.list.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(ok(configured));
  f.start(); await Promise.resolve(); await Promise.resolve();
  f.setScope("second"); await f.flush("second");
  resolve(ok()); await Promise.resolve(); await Promise.resolve();
  expect(f.open).not.toHaveBeenCalled();
  expect(localStorage.getItem(assistantFirstUseKey("first"))).toBeNull();
  expect(localStorage.getItem(assistantFirstUseKey("second"))).toBe("seen");
});

it("keeps the in-session dismissal when local storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const f = fixture(); const stop = f.start(); await f.flush();
  f.dialogs.closeTop(); stop(); f.start(); await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
});

it("does not open a dialog after disposal while a directory read is pending", async () => {
  const f = fixture(); let resolve!: (value: ReturnType<typeof ok>) => void;
  f.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  const stop = f.start(); await Promise.resolve(); await Promise.resolve();
  stop(); resolve(ok()); await f.flush();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not spin when navigation rejects opening and publishes a dialog update", async () => {
  const f = fixture();
  f.open.mockImplementation(() => {
    f.dialogs.open({ dialogId: "other" }); f.dialogs.closeTop();
    return { ok: false, error: "navigation blocked" };
  });
  f.start(); await f.flush();
  expect(f.open).toHaveBeenCalledOnce();
  expect(localStorage.getItem(assistantFirstUseKey("first"))).toBeNull();
});
