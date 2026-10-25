/**
 * TaskActivityFeed 受控预览浮层与 actions（change: adopt-radix-lucide-canvas-ui，任务 5.2）。
 *
 * 用 jsdom 驱动 hover/focus 打开受控 Popover，验证：
 * - 成功媒体项 hover 打开贴右侧的受控预览；
 * - 离开关闭且 portal 内容被清理；
 * - 音频仍不自动播放。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import { ACTIVITY_EXIT_DURATION_MS, TaskActivityStore } from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";
import { UiProvider } from "@woohaa3/frontend/extension-api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function storeWith(records: CanvasTaskActivity[]): TaskActivityStore {
  const store = new TaskActivityStore();
  for (const record of records) store.applyServerRecord(record, 1);
  return store;
}

function record(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return { state: "succeeded", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", durationMs: 0, ...patch };
}

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

const media = (key: string) => `/api/media/${key}`;

describe("TaskActivityFeed 受控预览（任务 5.2）", () => {
  it("进行中的组记录自动展开面板，单纯的后台录制不抢开", () => {
    const store = new TaskActivityStore();
    try {
      const container = render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={media} /></UiProvider>);
      expect(container.querySelector(".task-activity-feed__entry")).not.toBeNull();
      // 只有后台录制：面板保持收起（画布加载即自动录制，不应抢开）。
      act(() => store.applyJob({
        id: "attempt-1", canvasId: "c1", kind: "shot-reference-recording",
        title: "镜头 1", status: "running", updatedAt: "2026-01-01T00:00:00Z"
      }));
      expect(container.querySelector(".task-activity-feed")).toBeNull();
      expect(container.querySelector(".task-activity-feed__entry")).not.toBeNull();
      // 新的进行中组记录：自动展开。
      act(() => store.replaceGroupRuns({
        rows: [{
          rootGroupId: "g1",
          creation: {
            requestId: "creation-g1", canvasId: "c", rootGroupId: "g1", commandId: "cmd",
            turnRequestId: "request-g1", scopeEpoch: 1, stage: "accepted"
          },
          requestId: "request-g1", status: "running", label: "创作中", active: true,
          createdAt: "2026-01-01T00:00:01Z"
        }],
        error: ""
      }));
      expect(container.querySelector(".task-activity-feed")).not.toBeNull();
    } finally { store.dispose(); }
  });

  it("到期时关闭预览并保留退出行，最后一项退出后才收起面板", () => {
    vi.useFakeTimers();
    const store = storeWith([record({ taskKey: "t", runId: "r", nodeId: "n" })]);
    try {
      const container = render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={media} /></UiProvider>);
      const row = container.querySelector<HTMLElement>(".task-activity-feed__card")!;
      act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      expect(container.querySelector(".task-activity-feed__pop")).not.toBeNull();
      act(() => vi.advanceTimersByTime(10_000));
      expect(row.dataset.exiting).toBe("true");
      expect(row.isConnected).toBe(true);
      expect(container.querySelector(".task-activity-feed__pop")).toBeNull();
      expect(container.querySelector(".task-activity-feed__entry")).toBeNull();
      act(() => vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS));
      expect(row.isConnected).toBe(false);
      expect(container.querySelector(".task-activity-feed__entry")).not.toBeNull();
    } finally { store.dispose(); vi.useRealTimers(); }
  });

  it("后台录制失败可悬停查看原因，重试不覆盖旧失败", () => {
    const store = new TaskActivityStore();
    const failed = {
      id: "attempt-1", canvasId: "c1", kind: "shot-reference-recording" as const,
      title: "双刃锁链 · 默认动画", status: "failed" as const,
      detail: "第 0 秒镜头捕捉失败或超时", nodeId: "film",
      updatedAt: "2026-01-01T00:00:00Z"
    };
    const locate = vi.fn();
    store.configure({ locateNode: locate });
    store.applyJob(failed);
    store.applyJob({ ...failed, id: "attempt-2", status: "running", detail: undefined });
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    expect(container.querySelectorAll(".task-activity-feed__card")).toHaveLength(2);
    const card = container.querySelector<HTMLElement>('[data-kind="job"][data-state="failed"]')!;
    act(() => card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".task-activity-feed__pop")?.textContent).toContain(failed.detail);
    act(() => card.querySelector<HTMLButtonElement>(".task-activity-feed__primary")!.click());
    expect(locate).toHaveBeenCalledWith("film");
    act(() => card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(container.querySelector(".task-activity-feed__pop")).toBeNull();
    store.dispose();
  });

  it("失败悬停直接显示模型和原因，点击打开当前画布弹窗，清理保留运行项", () => {
    const store = storeWith([
      record({ taskKey: "failed", runId: "rf", nodeId: "nf", state: "failed", error: { name: "ProviderError", message: "服务超时" } }),
      record({ taskKey: "running", runId: "rr", nodeId: "nr", state: "running" }),
      record({ taskKey: "cancelled", runId: "rc", nodeId: "nc", state: "cancelled" })
    ]);
    const history = vi.fn();
    store.configure({ openHistory: history });
    const container = render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={media} onOpenHistory={history} /></UiProvider>);
    const row = container.querySelector<HTMLElement>('[data-state="failed"]')!;
    expect(container.querySelector("summary")).toBeNull();
    act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".task-activity-feed__pop")?.textContent).toContain("服务超时");
    act(() => row.querySelector<HTMLButtonElement>(".task-activity-feed__primary")!.click());
    expect(history.mock.calls[0][0].taskKey).toBe("failed");
    act(() => container.querySelector<HTMLButtonElement>(".task-activity-feed__footer .task-activity-feed__history")!.click());
    expect(history.mock.calls[1]).toEqual([]);
    expect(container.querySelector(".task-activity-feed__clear")?.textContent).toBe("清除已结束");
    act(() => container.querySelector<HTMLButtonElement>(".task-activity-feed__clear")!.click());
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["running"]);
    store.dispose();
  });

  it("作品已删除时仍可查看该任务，标题不执行定位", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1" }),
      record({ taskKey: "t2", runId: "r2", nodeId: "missing" })
    ]);
    const locate = vi.fn();
    const open = vi.fn();
    store.configure({
      locateNode: locate,
      openHistory: open,
      resolveTaskDisplay: (item) => ({ primary: item.nodeId, secondary: "" })
    });
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    const titles = [...container.querySelectorAll<HTMLButtonElement>(".task-activity-feed__primary")];
    act(() => titles.find((title) => title.textContent === "n1")!.click());
    expect(locate).not.toHaveBeenCalled();
    expect(open.mock.calls[0][0].taskKey).toBe("t1");
    const missing = titles.find((title) => title.textContent === "missing")!;
    expect(missing.disabled).toBe(false);
    act(() => missing.click());
    expect(open.mock.calls[1][0].taskKey).toBe("t2");
    expect(locate).not.toHaveBeenCalled();
    store.dispose();
  });

  it("Agent 记录优先按确切 run 打开详情；无关联的普通 Task 保留原任务详情", async () => {
    const store = storeWith([
      record({ taskKey: "agent", runId: "run-agent", nodeId: "n1" }),
      record({ taskKey: "plain", runId: "run-plain", nodeId: "n2" })
    ]);
    const openHistory = vi.fn();
    const openAgent = vi.fn(async (item: { runId: string }) => item.runId === "run-agent");
    store.configure({
      openTaskDetail: openAgent,
      openHistory,
      resolveTaskDisplay: (item) => ({ primary: item.runId, secondary: "" })
    });
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    const click = (label: string) => {
      const title = [...container.querySelectorAll<HTMLButtonElement>(".task-activity-feed__primary")]
        .find((entry) => entry.textContent === label)!;
      act(() => title.click());
    };
    await act(async () => click("run-agent"));
    expect(openAgent.mock.calls[0][0]).toMatchObject({ runId: "run-agent" });
    expect(openHistory).not.toHaveBeenCalled();

    // 无 Agent 关联 → 保留原任务详情，不伪造对话。
    await act(async () => click("run-plain"));
    expect(openAgent.mock.calls[1][0]).toMatchObject({ runId: "run-plain" });
    expect(openHistory).toHaveBeenCalledTimes(1);
    expect(openHistory.mock.calls[0][0]).toMatchObject({ runId: "run-plain" });
    store.dispose();
  });

  it("成功图片 hover 打开受控预览，离开后关闭", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", result: { mediaKind: "image", storageKey: "sha256-img" } })
    ]);
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    expect(container.querySelector(".task-activity-feed__pop")).toBeNull();
    const card = container.querySelector<HTMLElement>(".task-activity-feed__card")!;
    act(() => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    // 受控 Popover 挂到 theme-root 内的 portal。
    const pop = container.querySelector(".task-activity-feed__pop")!;
    expect(pop).not.toBeNull();
    expect(pop.querySelector("img")?.getAttribute("src")).toBe("/api/media/sha256-img");

    act(() => {
      card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container.querySelector(".task-activity-feed__pop")).toBeNull();
    store.dispose();
  });

  it("video 预览显示海报与时长", () => {
    const store = storeWith([
      record({
        taskKey: "t1",
        runId: "r1",
        nodeId: "n1",
        result: { mediaKind: "video", storageKey: "sha256-v", durationSeconds: 65, poster: { storageKey: "sha256-p" } }
      })
    ]);
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    const card = container.querySelector<HTMLElement>(".task-activity-feed__card")!;
    act(() => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const pop = container.querySelector(".task-activity-feed__pop")!;
    expect(pop.querySelector("img")?.getAttribute("src")).toBe("/api/media/sha256-p");
    expect(pop.textContent).toContain("1:05");
    store.dispose();
  });

  it("音频项 hover 不自动创建播放控件", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", result: { mediaKind: "audio", storageKey: "sha256-a", durationSeconds: 12 } })
    ]);
    const container = render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={media} />
      </UiProvider>
    );
    const card = container.querySelector<HTMLElement>(".task-activity-feed__card")!;
    act(() => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector("audio")).toBeNull();
    expect(container.querySelector(".task-activity-feed__pop")?.textContent).toContain("音频 · 12s");
    store.dispose();
  });
});
