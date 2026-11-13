/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CanvasGenerationHistoryListItem } from "@woohaa3/contracts";
import { UiProvider } from "@woohaa3/ui/primitives";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { DialogService } from "../../services/dialogs/service.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { agentAssistantExtension } from "./plugin.js";
import { createCanvasHistoryWorkspace } from "../node-history/canvas-history-browser.js";
import type { CanvasHistoryClient } from "../node-history/canvas-history-controller.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let runtime: FrontendRuntime | undefined;
afterEach(async () => { act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const counts = { text: 1, image: 1, video: 0, audio: 1, motion: 0, model: 0 };
const entry = (entryId: string, preview: CanvasGenerationHistoryListItem["preview"] = { kind: "text", excerpt: entryId }): CanvasGenerationHistoryListItem => ({ entryId, nodeId: "node", nodeTitle: entryId, kind: preview.kind === "failure" ? "text" : preview.kind, preview, source: { label: "生成" }, createdAt: "2026-10-26T00:00:00Z", current: false, recoverable: true, previewable: true });
const page = (items = [entry("first"), entry("second")], nextCursor: string | null = null) => ({ ok: true as const, items, nextCursor, total: items.length, kindCounts: counts });
async function fixture(read: CanvasHistoryClient["listCanvas"] = async () => page(), canvasId: string | null = "canvas") {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const slots = new SlotRegistry(); const dialogs = new DialogService();
  let namespace: string | null = "owner-a"; const users = new Set<() => void>();
  const listCanvas = vi.fn(read); const listConversations = vi.fn(); const submitTurn = vi.fn(); const write = vi.fn();
  const service = { listConnections: vi.fn(async () => ({ ok: true, value: [] })), listServiceConnections: vi.fn(async () => ({ ok: true, value: [] })), listConversations, submitTurn, manageServiceConnection: write };
  const Workspace = createCanvasHistoryWorkspace({ listCanvas }, vi.fn(), () => ({ ok: true }));
  const remove = slots.register("ai-center.generation-history", { id: "history", owner: "node-history", render: Workspace });
  runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("slots" as never, slots as never); ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("canvasNavigation" as never, new CanvasNavigationStore({ openDialog: request => dialogs.open(request) }) as never);
    if (canvasId) ctx.provide("canvasScope" as never, { canvasId: () => canvasId } as never);
    ctx.provide("currentUser" as never, { getSnapshot: () => namespace ? { dataScopeId: namespace } : null, subscribe: (listener: () => void) => { users.add(listener); return () => users.delete(listener); } } as never);
    ctx.provide("agentConversationService" as never, service as never);
  }, plugins: [{ id: "agent-assistant", required: true, plugin: agentAssistantExtension() }] });
  function Host() {
    const snapshot = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot);
    const instance = snapshot.stack.at(-1); if (!instance) return null;
    const Renderer = dialogs.resolveRenderer(instance.dialogId)!;
    return <Renderer instance={instance} requestClose={() => dialogs.requestClose(instance.instanceId)} setBusy={() => {}} replace={() => {}} />;
  }
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => { root!.render(<RuntimeProvider runtime={runtime!}><UiProvider><Host /></UiProvider></RuntimeProvider>); });
  const open = async (payload: object = { section: "generation-history" }) => { await act(async () => { dialogs.open({ dialogId: "agent-assistant", payload }); await import("./assistant.js"); }); };
  const click = async (selector: string) => { const button = el.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()); };
  const changeUser = async (next: string | null) => { await act(async () => { namespace = next; users.forEach(notify => notify()); }); };
  return { el, open, click, changeUser, dialogs, listCanvas, listConversations, submitTurn, write, pause, remove, slots, service };
}

it("仅首次访问读取；侧栏往返和重复打开保留筛选、分页、选中、滚动；关闭重开读取最新首页", async () => {
  const f = await fixture(async input => page(input.cursor ? [entry("third")] : [entry("first"), entry("second")], input.cursor ? null : "next"));
  await f.open({}); expect(f.listCanvas).not.toHaveBeenCalled();
  await f.click('[data-page="generation-history"]'); expect(f.listCanvas).toHaveBeenCalledTimes(1);
  await f.click('.canvas-history__filters button[aria-label^="文本"]');
  await f.click('.canvas-history__more');
  await f.click('.canvas-history__item:nth-child(2)');
  const list = f.el.querySelector<HTMLElement>('.canvas-history__list-panel')!; list.scrollTop = 80; list.dispatchEvent(new Event("scroll"));
  const calls = f.listCanvas.mock.calls.length;
  await f.click('[data-page="sources"]'); await f.click('[data-page="generation-history"]'); await f.open();
  expect(f.listCanvas).toHaveBeenCalledTimes(calls);
  expect(f.el.querySelector('.canvas-history__item.is-selected')?.textContent).toContain("second");
  expect(f.el.querySelector<HTMLElement>('.canvas-history__list-panel')!.scrollTop).toBe(80);
  expect(f.el.querySelectorAll('.canvas-history__item')).toHaveLength(3);

  await f.open({});
  expect(f.el.querySelector('[data-page="overview"]')?.getAttribute("data-state")).toBe("active");
  await f.open();
  expect(f.listCanvas).toHaveBeenCalledTimes(calls);
  await act(async () => { f.dialogs.requestCloseTop(); }); await f.open();
  expect(f.listCanvas).toHaveBeenCalledTimes(calls + 1);
  expect(f.el.querySelectorAll('.canvas-history__item')).toHaveLength(2);
  expect(f.listConversations).not.toHaveBeenCalled(); expect(f.submitTurn).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
});

it("确认数据空间时先显示可关闭的能力中心外壳，关闭后身份就绪不重开", async () => {
  const f = await fixture();
  await f.changeUser(null);
  await f.open({});
  const shell = f.el.querySelector('.agent-assistant.dlg')!;
  expect(shell.querySelector('.dlg__title')?.textContent).toBe("AI 能力中心");
  expect(shell.querySelector('.dlg__body .agent-assistant__loading')?.textContent).toBe("正在确认用户数据空间…");
  expect(shell.querySelector('[data-ai-page]')).toBeNull();
  expect(f.service.listConnections).not.toHaveBeenCalled();
  expect(f.service.listServiceConnections).not.toHaveBeenCalled();
  await f.click('.dlg__close');
  expect(f.el.querySelector('.agent-assistant')).toBeNull();
  await f.changeUser("owner-a");
  expect(f.el.querySelector('.agent-assistant')).toBeNull();
  expect(f.dialogs.getSnapshot().stack).toHaveLength(0);
});

it("切换数据空间隔离旧响应；未确认身份时卸载，贡献撤销呈现不可用", async () => {
  const pending: Array<(result: Awaited<ReturnType<CanvasHistoryClient["listCanvas"]>>) => void> = [];
  const f = await fixture(() => new Promise(resolve => pending.push(resolve)));
  await f.open(); await f.changeUser(null);
  expect(f.el.querySelector('.agent-assistant .agent-assistant__loading')?.textContent).toContain("正在确认用户数据空间");
  await act(async () => pending[0]!(page([entry("old-owner")])));
  await f.changeUser("owner-b"); expect(f.listCanvas).toHaveBeenCalledTimes(2);
  expect(f.el.querySelector('.agent-assistant__loading')).toBeNull();
  expect(f.el.textContent).not.toContain("old-owner");
  await act(async () => pending[1]!(page([entry("new-owner")])));
  expect(f.el.textContent).toContain("new-owner");
  await act(async () => f.remove());
  expect(f.el.textContent).toContain("历史模块未装配"); expect(f.el.textContent).not.toContain("new-owner");
  await f.click('[data-page="sources"]'); expect(f.listConversations).not.toHaveBeenCalled();
});

it("无画布不查询；缺少助手目录不影响历史，显式定位不被迟到目录抢走", async () => {
  const f = await fixture(undefined, null); await f.open();
  expect(f.el.textContent).toContain("从画布打开后查看生成历史"); expect(f.listCanvas).not.toHaveBeenCalled();
  expect(f.el.querySelector('[data-page="generation-history"]')?.getAttribute("data-state")).toBe("active");
});

it("Pad 返回列表、离页和关闭卸载播放器并暂停，保持选择和列表", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const f = await fixture(async () => page([entry("audio", { kind: "audio", href: "/audio", durationSeconds: 1 })]));
  await f.open(); expect(f.el.querySelector("audio")).toBeNull();
  await f.click('.canvas-history__item'); expect(f.el.querySelector("audio")).not.toBeNull();
  expect(f.el.querySelector("audio")?.autoplay).toBe(false);
  const before = f.pause.mock.calls.length; await f.click('.canvas-history__back');
  expect(f.el.querySelector("audio")).toBeNull(); expect(f.pause.mock.calls.length).toBeGreaterThan(before);
  await f.click('.canvas-history__item'); await f.click('[data-page="sources"]');
  expect(f.el.querySelector("audio")).toBeNull(); await f.click('[data-page="generation-history"]');
  expect(f.el.querySelector("audio")).not.toBeNull(); await act(async () => { f.dialogs.requestCloseTop(); });
  expect(f.el.querySelector("audio")).toBeNull();
});


it("历史贡献失败可重试且目录失败不阻断历史", async () => {
  const f = await fixture();
  f.service.listConnections.mockRejectedValue(new Error("连接离线"));
  f.service.listServiceConnections.mockRejectedValue(new Error("目录离线"));
  await f.open(); expect(f.el.querySelectorAll(".canvas-history__item")).toHaveLength(2);
  let broken = true;
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => { f.slots.register("ai-center.generation-history", { id: "broken", owner: "test", priority: -1, render: () => { if (broken) throw new Error("模块失败"); return <p>模块已恢复</p>; } }); });
  expect(f.el.textContent).toContain("生成历史模块加载失败");
  expect(f.el.textContent).toContain("连接读取失败");
  await f.click('[data-page="sources"]');
  expect(f.el.querySelector('[data-page="sources"]')?.getAttribute("data-state")).toBe("active");
  await f.click('[data-page="generation-history"]'); broken = false;
  const retry = [...f.el.querySelectorAll("button")].find(button => button.textContent === "重新加载")!;
  await act(async () => retry.click()); expect(f.el.textContent).toContain("模块已恢复");
  expect(f.listConversations).not.toHaveBeenCalled(); expect(f.submitTurn).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  errorLog.mockRestore();
});


it("同一单例换画布时先隔离旧条目并读取目标画布，切回不复用旧缓存", async () => {
  const f = await fixture(async input => page([entry(input.canvasId)]));
  await f.open(); expect(f.el.querySelector('.canvas-history__item')?.textContent).toContain("canvas");
  await f.open({ canvasId: "other", section: "generation-history" });
  expect(f.listCanvas.mock.calls.at(-1)?.[0].canvasId).toBe("other");
  expect(f.el.querySelector('.canvas-history__item')?.textContent).toContain("other");
  expect(f.el.querySelector('.canvas-history__item')?.textContent).not.toContain("canvas");
  await f.open(); expect(f.listCanvas).toHaveBeenCalledTimes(3);
});
