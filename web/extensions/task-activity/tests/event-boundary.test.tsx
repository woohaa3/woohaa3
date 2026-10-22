/**
 * Task Activity 与事件总线输入边界的联合验证
 * （change: adopt-radix-lucide-canvas-ui，任务 5.3 / design「并行 change」风险条目）。
 *
 * 并行 change `formalize-frontend-event-bus` 把 started / 多个 updated / finished / 直接
 * finished 分类为 store 的公开事件输入。本 change 的 UI 迁移**只依赖 store 公开 snapshot/
 * callback**（本 change 不引入事件监听），因此本测试锁定三条边界不变量：
 *
 * 1. TaskActivityFeed 生产源码不 import 事件目录、不订阅总线、不缓存 activity record；
 * 2. started -> 多个 updated -> finished、直接 finished 各只有一次 store transition；
 * 3. Canvas scope dispose 后迟到输入不再产生新渲染（scope identity 由 store/bridge owner）。
 *
 * store 的公开变更 API（insertOptimistic / applyServerRecord / markLocalFailure）即事件输入
 * contract 的落点；桥接层在合并事件输入后调用它们。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import { TaskActivityStore } from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";
import { UiProvider } from "@woohaa3/frontend/extension-api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function makeStore(): TaskActivityStore {
  return new TaskActivityStore();
}

function authoritative(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return { state: "running", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", durationMs: 0, ...patch };
}

/** 把权威记录分类为 updated/finished 事件（与 bridge 相同的输入契约）。 */
function classify(store: TaskActivityStore, record: CanvasTaskActivity, cursor: number): void {
  if (record.state === "succeeded" || record.state === "failed" || record.state === "cancelled") {
    store.applyEvent({
      name: "task.activity.finished",
      payload: { source: "live", cursor, activity: record as CanvasTaskActivity & { state: "succeeded" | "failed" | "cancelled" } }
    });
    return;
  }
  store.applyEvent({
    name: "task.activity.updated",
    payload: { source: "live", cursor, activity: record as CanvasTaskActivity & { state: "queued" | "pending" | "running" } }
  });
}

/** 挂载 feed 并统计每次 store transition 的通知次数（= publish 次数）。 */
function mountCountingRenders(store: TaskActivityStore) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() =>
    root.render(
      <UiProvider>
        <TaskActivityFeed store={store} resolveMediaUrl={(key) => `/api/media/${key}`} onLocateNode={() => undefined} />
      </UiProvider>
    )
  );
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  return {
    container,
    /** 执行一次 store transition，返回该次 transition 的 publish/通知次数。 */
    transition(run: () => void): number {
      const before = notifications;
      act(() => run());
      return notifications - before;
    },
    stop: unsubscribe
  };
}

describe("Task Activity 输入边界（任务 5.3）", () => {
  it("Feed 源码不订阅事件总线、不缓存 activity record", () => {
    const source = stripComments(readFileSync(path.resolve(HERE, "../src/frontend/feed.tsx"), "utf8"));
    // 不 import 事件目录 / 不注册事件监听。
    expect(source).not.toMatch(/events\/catalog|events\/task-activity/);
    expect(source).not.toMatch(/\.on\(|\.emit\(|addEventListener/);
    // 只从 store 公开 snapshot 读取；本地 state 只承载展开态与预览锚点。
    expect(source).toContain("useSyncExternalStore(store.subscribe, store.getSnapshot");
    expect(source).not.toMatch(/useState<.*CanvasTaskActivity/);
  });

  it("started -> 多个 updated -> finished 每个 store transition 只触发一次通知", () => {
    const store = makeStore();
    const harness = mountCountingRenders(store);

    // started：插入乐观项（1 次 publish）。
    expect(
      harness.transition(() =>
        store.applyEvent({
          name: "task.activity.started",
          payload: { runId: "r1", jobId: "j1", nodeId: "n1", state: "queued", modelType: "image", createdAt: "2026-01-01T00:00:00Z" }
        })
      )
    ).toBe(1);
    // 多个 updated：权威进度推进（每次 1 次 publish）。
    expect(
      harness.transition(() =>
        store.applyServerRecord(authoritative({ taskKey: "t1", runId: "r1", nodeId: "n1", progress: 0.3 }), 1)
      )
    ).toBe(1);
    expect(
      harness.transition(() =>
        store.applyServerRecord(authoritative({ taskKey: "t1", runId: "r1", nodeId: "n1", progress: 0.6 }), 2)
      )
    ).toBe(1);
    // finished。
    expect(
      harness.transition(() =>
        classify(store, authoritative({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "succeeded", result: { mediaKind: "image", storageKey: "k" } }), 3)
      )
    ).toBe(1);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0]!.state).toBe("succeeded");
    harness.stop();
    store.dispose();
  });

  it("直接 finished（无 started）也被 upsert 一次", () => {
    const store = makeStore();
    const harness = mountCountingRenders(store);
    const delta = harness.transition(() =>
      classify(store, authoritative({ taskKey: "t-direct", runId: "r-direct", nodeId: "n2", state: "succeeded" }), 1)
    );
    expect(delta).toBe(1);
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["t-direct"]);
    harness.stop();
    store.dispose();
  });

  it("Canvas scope dispose 后迟到输入不产生通知", () => {
    const store = makeStore();
    const harness = mountCountingRenders(store);
    harness.transition(() =>
      store.applyServerRecord(authoritative({ taskKey: "t1", runId: "r1", nodeId: "n1" }), 1)
    );
    harness.stop();
    // dispose store（等价于 Canvas scope 释放）。
    act(() => store.dispose());
    expect(() =>
      store.applyServerRecord(authoritative({ taskKey: "t-late", runId: "r-late", nodeId: "n9" }), 2)
    ).not.toThrow();
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["t1"]);
  });
});
