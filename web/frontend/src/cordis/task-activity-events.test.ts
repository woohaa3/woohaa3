/**
 * Task Activity 事件总线集成测试
 * （change: formalize-frontend-event-bus，任务 6.2 / 8.1）。
 *
 * 用真实 `installPlatform` + `createCanvasExtensionManifest` 启动，验证：
 * - `task.activity.started` 经 Context 事件合并进活动 store；
 * - 权威 `task.activity.updated` 无 started 也可 upsert；
 * - optional task-activity 缺失时抛事件不报错（fire-and-forget）。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { isValidElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { installAppServices, installCanvasPageServices } from "./install-services.js";
import { createSourceCanvasExtensionManifest } from "./test-support/source-extensions.js";

let runtime: FrontendRuntime | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function installGlobals(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("{}", { status: 200 });
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

function activityService(ctx: FrontendRuntime["ctx"]): { getSnapshot: () => { items: Array<{ taskKey: string; state: string }> } } | undefined {
  return ctx.get("taskActivityStore" as never) as
    | { getSnapshot: () => { items: Array<{ taskKey: string; state: string }> } }
    | undefined;
}

describe("Task Activity 事件总线", () => {
  it("started 事件合并进活动 store；权威 updated 无 started 也可 upsert", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: async (ctx) => {
        installAppServices(ctx, { testHooks: false });
        await installCanvasPageServices(ctx, { testHooks: false });
      },
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const service = activityService(ctx);
    expect(service).toBeDefined();
    ctx.emit("task.activity.started", {
      runId: "r1",
      jobId: "job-r1",
      nodeId: "n1",
      state: "queued",
      createdAt: "2026-01-01T00:00:00Z"
    });
    expect(service!.getSnapshot().items.map((item) => item.state)).toEqual(["queued"]);

    ctx.emit("task.activity.updated", {
      source: "live",
      cursor: 1,
      activity: {
        taskKey: "worker-r1",
        runId: "r1",
        nodeId: "n1",
        state: "running",
        progress: 0.5,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
        durationMs: 1000
      }
    });
    expect(service!.getSnapshot().items).toHaveLength(1);
    expect(service!.getSnapshot().items[0].taskKey).toBe("worker-r1");

    // Activity clicks must use the same registered dialog as the canvas toolbar.
    const overlay = ctx.slots.list("canvas.overlay").find((entry) => entry.id === "task-activity-feed");
    const feed = (overlay?.render as unknown as (() => unknown) | undefined)?.();
    expect(isValidElement<{ onOpenHistory: () => void }>(feed)).toBe(true);
    if (!isValidElement<{ onOpenHistory: () => void }>(feed)) throw new Error("Missing activity feed");
    feed.props.onOpenHistory();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ctx.dialogs.top()?.dialogId).toBe("agent-assistant");
    ctx.dialogs.close();
    expect(ctx.slots.list("canvas.toolbar-action").find(entry => entry.label === "作品生成历史")).toBeUndefined();
    const opened = ctx.dialogs.open({ dialogId: "canvas-generation-history", payload: {} });
    expect(opened.ok).toBe(true);
    expect(ctx.dialogs.top()?.dialogId).toBe("agent-assistant");
    expect((ctx.dialogs.top()?.payload as { section: string }).section).toBe("generation-history");

  });

  it("optional task-activity 缺失时提交仍可用（事件无 listener 不阻塞）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: async (ctx) => {
        installAppServices(ctx, { testHooks: false });
        await installCanvasPageServices(ctx, { testHooks: false });
      },
      plugins: createSourceCanvasExtensionManifest().filter((definition) => definition.id !== "task-activity")
    });
    const ctx = runtime.ctx;
    expect(activityService(ctx)).toBeUndefined();
    expect(() =>
      ctx.emit("task.activity.started", {
        runId: "r1",
        jobId: "job-r1",
        nodeId: "n1",
        state: "queued",
        createdAt: "2026-01-01T00:00:00Z"
      })
    ).not.toThrow();
  });
});
