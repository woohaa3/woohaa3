/**
 * 任务活动栈 story fixtures
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 4.2）。
 *
 * 渲染生产 `TaskActivityFeed` + 生产 `TaskActivityStore`；这里只把远端 IO 换成受控内存
 * 实现（可注入快照并手动发射事件），并固定时间，使列表与截图可重复。
 */
import { useMemo } from "react";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import type { CanvasGroupRun, ActivityRowCapabilities } from "@woohaa3/extension-task-activity/frontend";
import { TaskActivityStore } from "@woohaa3/extension-task-activity/frontend";
import { fixtureMediaUrl } from "../task-history-fixtures.js";

/** 复用历史页的本地预览夹具，避免展示舞台出现破图；音频仍保留模拟资源入口。 */
export function activityFixtureMediaUrl(storageKey: string): string {
  return storageKey.includes("aud") ? `/showcase-media/${storageKey}` : fixtureMediaUrl(storageKey);
}

export function activityRecord(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return {
    state: "running",
    createdAt: "2026-09-29T08:00:00.000Z",
    updatedAt: "2026-09-29T08:00:05.000Z",
    durationMs: 5_000,
    ...patch
  };
}

export type ActivityFixtureControls = {
  store: TaskActivityStore;
  /** 手动发射一条权威事件（模拟实时推进）。 */
  emit: (record: CanvasTaskActivity, cursor: number) => void;
  /** 模拟断线重连后的快照补偿。 */
  recover: (records: CanvasTaskActivity[]) => void;
  dispose: () => void;
};

export type UseActivityFixtureOptions = {
  seed?: CanvasTaskActivity[];
  /** 组创作记录：与任务/后台活动同列表交错（change: 2026-10-22-unify-task-activity-rows，任务 3.4）。 */
  groups?: readonly CanvasGroupRun[];
  /** 行适配能力（展示解析、节点定位、组动作）；缺省只提供可定位的空实现。 */
  capabilities?: ActivityRowCapabilities;
};

/** 受控 store：先 hydration 种子记录，再暴露事件发射与补偿入口（非 hook 版本）。 */
export function createActivityStoreFixture(options: UseActivityFixtureOptions = {}): ActivityFixtureControls {
  const store = new TaskActivityStore();
  // story 只需能定位；真实定位/详情由宿主处理。
  store.configure(options.capabilities ?? { locateNode: () => undefined });

  // 种子记录在首帧同步合并（不做异步快照，保证 SSR/首屏稳定）。
  for (const record of options.seed ?? []) store.applyServerRecord(record, 1);
  if (options.groups?.length) store.replaceGroupRuns({ rows: options.groups, error: "" });

  return {
    store,
    emit: (record, cursor) => store.applyServerRecord(record, cursor),
    recover: (records) => {
      for (const record of records) store.applyServerRecord(record, store.getSnapshot().cursor + 1);
    },
    dispose: () => store.dispose()
  };
}

/** 受控 store：先 hydration 种子记录，再暴露事件发射与补偿入口。 */
export function useActivityStoreFixture(options: UseActivityFixtureOptions = {}): ActivityFixtureControls {
  // 不在此处注册 unmount dispose：React StrictMode 的双挂载会 dispose 掉 memo 化的 store，
  // 导致后续事件被丢弃。story 生命周期短，dispose 由调用方按需显式触发。
  return useMemo(() => createActivityStoreFixture(options), []);
}

/** 节点 id → 名称 fixture（供任务活动主行展示；change: 2026-10-09，任务 5.1）。 */
export function showcaseActivityNodes(): Map<string, { id: string; type: string; title: string }> {
  return new Map([
    ["image-1", { id: "image-1", type: "image", title: "海边日落（超长作品名称用于验证省略与操作可达性的一整句中文标题）" }],
    ["video-1", { id: "video-1", type: "video", title: "开场镜头" }],
    ["audio-1", { id: "audio-1", type: "audio", title: "环境音" }],
    ["text-1", { id: "text-1", type: "text", title: "旁白草稿" }]
  ]);
}

/** 常用 fixture：一条运行中、一条成功图片、一条失败。 */
export function defaultActivitySeed(): CanvasTaskActivity[] {  return [
    activityRecord({
      taskKey: "worker-run-a",
      runId: "run-a",
      nodeId: "image-1",
      state: "running",
      modelType: "image",
      modelKey: "gpt-image-2",
      progress: 0.45
    }),
    activityRecord({
      taskKey: "worker-run-b",
      runId: "run-b",
      nodeId: "video-1",
      state: "succeeded",
      modelType: "video",
      modelKey: "seedance-1.0",
      result: { mediaKind: "video", storageKey: "sha256-b", durationSeconds: 6, poster: { storageKey: "sha256-b-poster" } },
      createdAt: "2026-09-29T07:59:00.000Z"
    }),
    activityRecord({
      taskKey: "worker-run-c",
      runId: "run-c",
      nodeId: "text-1",
      state: "failed",
      modelType: "language",
      modelKey: "gemini-2.5-flash",
      error: { name: "ProviderError", message: "上游 provider 超时" },
      createdAt: "2026-09-29T07:58:00.000Z"
    })
  ];
}

/** 组创作记录 fixture：一条进行中、一条已结算（change: 2026-10-22-unify-task-activity-rows）。 */
export function groupActivitySeed(active = true): CanvasGroupRun[] {
  return [
    {
      rootGroupId: "fixture-group",
      creation: {
        requestId: "creation-showcase-running", canvasId: "showcase-canvas", rootGroupId: "group-running",
        commandId: "command-running", turnRequestId: "request-running", scopeEpoch: 1, stage: "accepted",
        conversationId: "conversation-running", turnId: "turn-running"
      },
      requestId: "request-running",
      status: "running",
      label: "创作中",
      active,
      createdAt: "2026-09-29T08:00:02.000Z"
    },
    {
      rootGroupId: "fixture-group",
      creation: {
        requestId: "creation-showcase-done", canvasId: "showcase-canvas", rootGroupId: "group-done",
        commandId: "command-done", turnRequestId: "request-done", scopeEpoch: 1, stage: "accepted",
        conversationId: "conversation-done", turnId: "turn-done"
      },
      requestId: "request-done",
      status: "partial",
      label: "部分完成",
      error: "第 3 个节点未通过校验",
      active: false,
      createdAt: "2026-09-29T08:00:03.000Z"
    }
  ];
}
