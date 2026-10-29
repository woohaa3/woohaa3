// @vitest-environment jsdom
/**
 * 组创作记录在统一活动面板中的行为
 * （change: 2026-10-22-unify-task-activity-rows，任务 2.1 / 2.4 / 3.2 / 3.3）。
 *
 * 组记录不再是专属行组件：它接入同一 `ActivityListRow`，寿命、关闭与清理与任务/后台活动一致，
 * 差异只在 `ActivityRow.actions`（定位创作组 / 查看对话 / 停止 / 重试原请求 / 核对状态）与
 * 点击锁定、选中滚动的交互能力。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiProvider } from "@woohaa3/ui/primitives";
import { type CanvasGroupRun } from "@woohaa3/frontend/extension-api";
import { ACTIVITY_EXIT_DURATION_MS, ACTIVITY_TERMINAL_LINGER_MS, TaskActivityStore } from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, active = true, createdAt = "2026-10-20T00:00:00Z"): CanvasGroupRun => ({
  rootGroupId: id, conversationId: `conversation-${id}`,
  creation: { requestId: `creation-${id}`, canvasId: "c", rootGroupId: id, commandId: `cmd-${id}`, turnRequestId: `request-${id}`, scopeEpoch: 1, stage: "accepted", conversationId: `conversation-${id}`, turnId: `turn-${id}` },
  requestId: `request-${id}`, status: active ? "running" : "succeeded", label: active ? "创作中" : "已完成", active, createdAt
});

it("组记录与任务共用同一条终态期限，到期退出后移除，可从组节点重开并重新计时", () => {
  vi.useFakeTimers();
  const store = new TaskActivityStore();
  try {
    store.replaceGroupRuns({ rows: [row("g1", false, "2026-10-20T00:00:01Z"), row("g2", true, "2026-10-20T00:00:02Z")], error: "" });
    expect(store.getSnapshot().rows.map(entry => entry.key)).toEqual(["group:request-g2", "group:request-g1"]);
    // 终态组记录进入统一计时：与任务、后台活动同一停留时长。
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS - 1);
    expect(store.getSnapshot().rows).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().exitingKeys).toEqual(["group:request-g1"]);
    vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS);
    expect(store.getSnapshot().rows.map(entry => entry.key)).toEqual(["group:request-g2"]);

    // 组来源是整表轮询：重放旧终态不得复活已移除的记录。
    store.replaceGroupRuns({ rows: [row("g1", false, "2026-10-20T00:00:01Z"), row("g2", true, "2026-10-20T00:00:02Z")], error: "" });
    expect(store.getSnapshot().rows.map(entry => entry.key)).toEqual(["group:request-g2"]);

    // 组节点入口是用户显式动作：重开并按新的终态观察重新计时。
    store.openGroup("g1");
    expect(store.getSnapshot().rows.map(entry => entry.key)).toEqual(["group:request-g2", "group:request-g1"]);
    expect(store.getSnapshot().selectedGroupId).toBe("g1");
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS - 1);
    expect(store.getSnapshot().rows).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().exitingKeys).toEqual(["group:request-g1"]);
    store.dispose();
    const before = store.getSnapshot();
    store.replaceGroupRuns({ rows: [], error: "" });
    expect(store.getSnapshot()).toBe(before);
  } finally { store.dispose(); vi.useRealTimers(); }
});

it("同一组再次执行：重新 active 清除移除标记并独立计时", () => {
  vi.useFakeTimers();
  const store = new TaskActivityStore();
  try {
    store.replaceGroupRuns({ rows: [row("g1", false)], error: "" });
    store.dismissRow("group:request-g1");
    expect(store.getSnapshot().rows).toHaveLength(0);
    // 再次执行：新的进行中记录出现，不被上一次的移除状态永久屏蔽。
    store.replaceGroupRuns({ rows: [row("g1", true)], error: "" });
    expect(store.getSnapshot().rows.map(entry => [entry.key, entry.active])).toEqual([["group:request-g1", true]]);
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS * 2);
    expect(store.getSnapshot().rows).toHaveLength(1);
    // 再次结算：从这一刻重新计时，而不是沿用上一次的终态时刻。
    store.replaceGroupRuns({ rows: [row("g1", false)], error: "" });
    expect(store.getSnapshot().unread).toBeGreaterThan(0);
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS - 1);
    expect(store.getSnapshot().rows).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().exitingKeys).toEqual(["group:request-g1"]);
  } finally { store.dispose(); vi.useRealTimers(); }
});

it("打开匹配的组并展开定位；动作路由到确切运行身份", async () => {
  const store = new TaskActivityStore();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onGroupAction = vi.fn().mockResolvedValue(undefined);
  const onOpenGroupConversation = vi.fn();
  const locate = vi.fn();
  try {
    store.configure({
      locateNode: locate,
      group: {
        action: onGroupAction,
        openConversation: onOpenGroupConversation,
        writable: () => true,
        resolveTitle: (nodeId) => `组 ${nodeId}`
      }
    });
    act(() => {
      store.replaceGroupRuns({ rows: [row("g1"), row("g2", false)], error: "" });
      root.render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={key => key} /></UiProvider>);
    });
    act(() => (container.querySelector('[aria-label="收起任务活动"]') as HTMLButtonElement).click());
    expect(container.querySelector(".task-activity-feed__entry")).toBeTruthy();
    act(() => store.openGroup("g1"));
    const selected = container.querySelector('[data-kind="group"][data-group-id="g1"][data-selected]')!;
    expect(selected.textContent).toContain("创作中");
    expect(selected.classList.contains("task-activity-feed__card")).toBe(true);
    expect(container.querySelector(".task-activity-feed__header")).toBeNull();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".task-activity-feed__pop--group button")];
    await act(async () => buttons.find(b => b.textContent === "定位创作组")!.click());
    expect(locate).toHaveBeenCalledWith("g1");
    await act(async () => buttons.find(b => b.textContent === "停止")!.click());
    expect(onGroupAction).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-g1" }), "stop");
    // 查看对话成功后按交互契约收起详情。
    await act(async () => buttons.find(b => b.textContent === "查看对话")!.click());
    expect(onOpenGroupConversation).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-g1" }));
    expect(container.querySelector(".canvas-agent-status")).toBeNull();
  } finally { act(() => root.unmount()); store.dispose(); container.remove(); }
});

it("导航失败在统一详情里可见，可再次打开同一对话", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const open = vi.fn().mockRejectedValueOnce(new Error("对话服务尚未就绪")).mockResolvedValueOnce(undefined);
  const store = new TaskActivityStore();
  try {
    store.configure({
      group: { openConversation: open, writable: () => true, resolveTitle: () => "节点搭建" }
    });
    act(() => {
      store.replaceGroupRuns({ rows: [row("g1")], error: "" });
      root.render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={key => key} /></UiProvider>);
    });
    // 点击主行锁定详情（组记录保留的交互）。
    act(() => container.querySelector<HTMLButtonElement>('[data-kind="group"] .task-activity-feed__primary')!.click());
    const button = () => [...document.querySelectorAll<HTMLButtonElement>(".task-activity-feed__pop--group button")].find(b => b.textContent === "查看对话")!;
    await act(async () => button().click());
    expect(document.querySelector(".task-activity-feed__pop--group")?.textContent).toContain("对话服务尚未就绪");
    await act(async () => button().click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".task-activity-feed__pop--group")).toBeNull();
  } finally { act(() => root.unmount()); store.dispose(); container.remove(); }
});
