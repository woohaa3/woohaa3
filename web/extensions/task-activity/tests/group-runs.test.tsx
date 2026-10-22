// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiProvider, type CanvasGroupRun } from "@woohaa3/frontend/extension-api";
import { TaskActivityStore } from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";
import { GroupRunRow } from "../src/frontend/group-run-row.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, active = true): CanvasGroupRun => ({
  creation: { requestId: `creation-${id}`, canvasId: "c", rootGroupId: id, commandId: `cmd-${id}`, turnRequestId: `request-${id}`, scopeEpoch: 1, stage: "accepted", conversationId: `conversation-${id}`, turnId: `turn-${id}` },
  requestId: `request-${id}`, status: active ? "running" : "succeeded", label: active ? "创作中" : "已完成", active, createdAt: "2026-10-20T00:00:00Z"
});

it("keeps completed group status available after dismissal, clearing, and task expiry", () => {
  vi.useFakeTimers();
  const store = new TaskActivityStore();
  try {
    store.replaceGroupRuns({ rows: [row("g1", false), row("g2")], error: "" });
    vi.advanceTimersByTime(20000);
    expect(store.getSnapshot().groups).toHaveLength(2);
    store.clearTerminal();
    expect(store.getSnapshot().groups.map(r => r.creation.rootGroupId)).toEqual(["g2"]);
    store.openGroup("g1");
    expect(store.getSnapshot().groups).toHaveLength(2);
    expect(store.getSnapshot().selectedGroupId).toBe("g1");
    store.dismissGroup("creation-g1");
    store.replaceGroupRuns({ rows: [row("g1", false), row("g2")], error: "" });
    expect(store.getSnapshot().groups).toHaveLength(1);
    store.openGroup("g1");
    expect(store.getSnapshot().groups).toHaveLength(2);
    store.dispose();
    const before = store.getSnapshot();
    store.replaceGroupRuns({ rows: [], error: "" });
    expect(store.getSnapshot()).toBe(before);
  } finally { store.dispose(); vi.useRealTimers(); }
});

it("opens the matching group in the existing panel and routes actions to the exact run", async () => {
  const store = new TaskActivityStore();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onGroupAction = vi.fn().mockResolvedValue(undefined);
  const onOpenGroupConversation = vi.fn();
  try {
    act(() => {
      store.replaceGroupRuns({ rows: [row("g1"), row("g2", false)], error: "" });
      root.render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={key => key} onLocateNode={() => undefined} onGroupAction={onGroupAction} onOpenGroupConversation={onOpenGroupConversation} groupWritable={() => true} /></UiProvider>);
    });
    act(() => (container.querySelector('[aria-label="收起任务活动"]') as HTMLButtonElement).click());
    expect(container.querySelector(".task-activity-feed__entry")).toBeTruthy();
    act(() => store.openGroup("g1"));
    const selected = container.querySelector('[data-group-id="g1"][data-selected]')!;
    expect(selected.textContent).toContain("创作中");
    expect(selected.classList.contains("task-activity-feed__card")).toBe(true);
    expect(container.querySelector(".task-activity-feed__header")).toBeNull();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".task-activity-feed__pop--group button")];
    await act(async () => buttons.find(b => b.textContent === "停止")!.click());
    expect(onGroupAction).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-g1" }), "stop");
    await act(async () => buttons.find(b => b.textContent === "查看对话")!.click());
    expect(onOpenGroupConversation).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-g1" }));
    expect(container.querySelector(".canvas-agent-status")).toBeNull();
  } finally { act(() => root.unmount()); store.dispose(); container.remove(); }
});

it("shows a navigation failure and lets the same conversation be opened again", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const open = vi.fn().mockRejectedValueOnce(new Error("对话服务尚未就绪")).mockResolvedValueOnce(undefined);
  try {
    act(() => root.render(<UiProvider><ul><GroupRunRow row={row("g1")} selected openRevision={1} onLocateNode={() => undefined} onDismiss={() => undefined} onOpenGroupConversation={open} /></ul></UiProvider>));
    const button = () => [...document.querySelectorAll<HTMLButtonElement>(".task-activity-feed__pop--group button")].find(b => b.textContent === "查看对话")!;
    await act(async () => button().click());
    expect(document.querySelector(".task-activity-feed__pop--group")?.textContent).toContain("对话服务尚未就绪");
    await act(async () => button().click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".task-activity-feed__pop--group")).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});
