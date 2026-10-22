import { useMemo, useState } from "react";
import { CanvasHistoryController } from "../../../frontend/src/cordis/plugins/node-history/canvas-history-controller.js";
import { createCanvasHistoryRenderer } from "../../../frontend/src/cordis/plugins/node-history/canvas-history-browser.js";
import { CANVAS_HISTORY_DIALOG_ID } from "../../../frontend/src/cordis/plugins/node-history/plugin.js";
import { objectPayload } from "../../../frontend/src/cordis/services/dialogs/registry.js";
import { DialogHost } from "../../../frontend/src/cordis/ui/index.js";
import { useShowcaseDialogs } from "../dialog-fixtures.js";
import type { Story, StoryDefault } from "@ladle/react";
import {
  TaskActivityFeed,
  resolveTaskActivityDisplay,
  type ActivityRow,
  type ActivityRowCapabilities,
  type TaskActivityFeedProps
} from "@woohaa3/extension-task-activity/frontend";
import {
  activityFixtureMediaUrl,
  activityRecord,
  defaultActivitySeed,
  groupActivitySeed,
  showcaseActivityNodes,
  useActivityStoreFixture
} from "../fixtures/activity-fixtures.js";

export default {
  title: "画布组件/任务活动栈",
} satisfies StoryDefault;

/** 生产展示解析：主行作品+操作、次行模型（任务 5.1）。 */
function makeResolveDisplay() {
  const nodes = showcaseActivityNodes();
  return (item: { nodeId: string; modelType?: string; modelKey?: string }) => {
    const node = nodes.get(item.nodeId) ?? null;
    return resolveTaskActivityDisplay({
      item: item as never,
      node,
      catalog: {
        available: true,
        defaultModels: {},
        models: [
          { modelKey: "gpt-image-2", providerId: "p", providerModelId: "x", modelType: "image", title: "图片主模型", interaction: { id: "i", version: 1 }, inputSchema: {}, defaultInput: {}, bindings: [], taskTimeoutMs: 1000 },
          { modelKey: "seedance-1.0", providerId: "p", providerModelId: "y", modelType: "video", title: "视频生成模型", interaction: { id: "i", version: 1 }, inputSchema: {}, defaultInput: {}, bindings: [], taskTimeoutMs: 1000 }
        ]
      }
    });
  };
}

/** Use the production dialog renderer and host; clicking never leaves this page. */
function StoryFeed({ onOpenHistory: _ignored, ...props }: TaskActivityFeedProps) {
  const controller = useMemo(() => new CanvasHistoryController({ listCanvas: async () => {
    const items = props.store.getSnapshot().items.filter((item) => item.state === "succeeded").map((item) => ({
      entryId: item.taskKey, nodeId: item.nodeId, nodeTitle: item.modelKey ?? item.nodeId,
      kind: "text" as const, createdAt: item.createdAt, current: false, recoverable: false, previewable: true,
      source: { label: "生成结果" }, preview: { kind: "text" as const, excerpt: item.result?.text || "历史结果预览" }
    }));
    return { ok: true, items, nextCursor: null, total: items.length, kindCounts: { text: items.length, image: 0, video: 0, audio: 0, model: 0 } };
  } }), [props.store]);
  const dialogs = useShowcaseDialogs([{ dialogId: CANVAS_HISTORY_DIALOG_ID, definition: {
    dismissible: true, singleton: true, size: "lg", variant: "standard",
    validatePayload: objectPayload(CANVAS_HISTORY_DIALOG_ID, () => ({}))
  }, renderer: createCanvasHistoryRenderer(controller, "showcase-canvas") }]);
  return <>
    <TaskActivityFeed {...props} onOpenHistory={() => dialogs.open({ dialogId: CANVAS_HISTORY_DIALOG_ID, payload: {} })} />
    <DialogHost dialogs={dialogs} />
  </>;
}

function Stage({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        <code>TaskActivityFeed</code> · {note}
      </div>
      <div className="showcase__activity-stage">{children}</div>
    </div>
  );
}

/** 默认：并发运行、成功媒体、失败混排；最近提交在顶部。 */
export const Ready: Story = () => {
  const controls = useActivityStoreFixture({
    seed: defaultActivitySeed(),
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <Stage note="运行中 + 成功视频 + 失败">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
Ready.storyName = "默认";

/** 成功四类结果：图片 / 视频 / 音频 / 文本。 */
export const Results: Story = () => {
  const controls = useActivityStoreFixture({
    seed: [
      activityRecord({ taskKey: "w-img", runId: "r-img", nodeId: "image-1", state: "succeeded", modelType: "image", result: { mediaKind: "image", storageKey: "sha256-img", contentType: "image/png", size: 1024, checksum: "c" } }),
      activityRecord({ taskKey: "w-vid", runId: "r-vid", nodeId: "video-1", state: "succeeded", result: { mediaKind: "video", storageKey: "sha256-vid", durationSeconds: 8, poster: { storageKey: "sha256-vid-poster" } } }),
      activityRecord({ taskKey: "w-aud", runId: "r-aud", nodeId: "audio-1", state: "succeeded", result: { mediaKind: "audio", storageKey: "sha256-aud", durationSeconds: 21 } }),
      activityRecord({ taskKey: "w-txt", runId: "r-txt", nodeId: "text-1", state: "succeeded", result: { mediaKind: "text", text: "这是一段生成文本结果的安全摘要。" } })
    ],
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <Stage note="图片 / 视频海报 / 音频 / 文本">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
Results.storyName = "成功结果";

/** 长中英文名称：主行作品优先、模型次行、状态与操作不被挤掉（任务 5.2）。 */
export const LongNames: Story = () => {
  const controls = useActivityStoreFixture({
    seed: defaultActivitySeed(),
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <Stage note="长作品名 + 长模型名 · 状态与操作可达">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
LongNames.storyName = "长名称";

/** 目录缺失 / 节点已删除：主行操作、次行 modelKey 兜底、定位禁用（任务 5.3）。 */
export const MissingTargets: Story = () => {
  const controls = useActivityStoreFixture({
    seed: [
      activityRecord({ taskKey: "w-gone", runId: "r-gone", nodeId: "deleted-node", state: "running", modelType: "image", modelKey: "some-model-key", progress: 0.3 })
    ],
    capabilities: {
      resolveTaskDisplay: (item) => resolveTaskActivityDisplay({ item: item as never, node: null, catalog: null })
    }
  });
  return (
    <Stage note="节点已删除 · 定位禁用并说明原因">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
MissingTargets.storyName = "失效目标";

/** 空：无任务时收起为入口。 */
export const Empty: Story = () => {
  const controls = useActivityStoreFixture({
    seed: [],
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <Stage note="空状态（折叠入口）">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
Empty.storyName = "空";

/** 实时推进 + 断线恢复。 */
export const LiveUpdate: Story = () => {
  const controls = useActivityStoreFixture({
    seed: [],
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  const [events, setEvents] = useState(0);
  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        <code>TaskActivityFeed</code> · 按钮驱动插入 / 推进 / 断线补偿
      </div>
      <div className="showcase__actions">
        <button
          type="button"
          data-testid="activity-insert"
          onClick={() => {
            controls.emit(activityRecord({ taskKey: "w-live", runId: "r-live", nodeId: "image-1", state: "running", modelType: "image", modelKey: "gpt-image-2", progress: 0.1 }), events + 1);
            setEvents((value) => value + 1);
          }}
        >
          插入运行中任务
        </button>
        <button
          type="button"
          data-testid="activity-complete"
          onClick={() => {
            controls.emit(activityRecord({ taskKey: "w-live", runId: "r-live", nodeId: "image-1", state: "succeeded", progress: 1 }), events + 1);
            setEvents((value) => value + 1);
          }}
        >
          标记完成
        </button>
        <button
          type="button"
          data-testid="activity-recover"
          onClick={() => controls.recover(defaultActivitySeed())}
        >
          断线补偿
        </button>
      </div>
      <div className="showcase__activity-stage">
        <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
      </div>
    </div>
  );
};
LiveUpdate.storyName = "实时更新";

/** 窄屏 390px：活动栈在窄视口收窄且不横向溢出。 */
export const Narrow: Story = () => {
  const controls = useActivityStoreFixture({
    seed: defaultActivitySeed(),
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        <code>TaskActivityFeed</code> · 390px 窄屏
      </div>
      <div className="showcase__frame showcase__frame--narrow showcase__activity-stage">
        <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
      </div>
    </div>
  );
};
Narrow.storyName = "窄屏 390";

/** 全部状态：queued / running / succeeded / failed / cancelled 的主次信息一致（任务 5.4）。 */
export const States: Story = () => {
  const controls = useActivityStoreFixture({
    seed: [
      activityRecord({ taskKey: "s-q", runId: "q", nodeId: "image-1", state: "queued", modelType: "image", modelKey: "gpt-image-2" }),
      activityRecord({ taskKey: "s-r", runId: "r", nodeId: "video-1", state: "running", modelType: "video", modelKey: "seedance-1.0", progress: 0.6 }),
      activityRecord({ taskKey: "s-ok", runId: "ok", nodeId: "text-1", state: "succeeded", modelType: "language", result: { mediaKind: "text", text: "生成结果摘要" } }),
      activityRecord({ taskKey: "s-f", runId: "f", nodeId: "audio-1", state: "failed", modelType: "audio", error: { name: "ProviderError", message: "上游超时" } }),
      activityRecord({ taskKey: "s-c", runId: "c", nodeId: "image-1", state: "cancelled", modelType: "image" })
    ],
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return (
    <Stage note="queued / running / succeeded / failed / cancelled">
      <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
    </Stage>
  );
};
States.storyName = "状态覆盖";

/** 超过展示上限时保留最早运行项，完整列表由宿主历史承接。 */
export const Overflow: Story = () => {
  const controls = useActivityStoreFixture({
    seed: Array.from({ length: 13 }, (_, index) => activityRecord({
      taskKey: `overflow-${index}`, runId: `overflow-run-${index}`, nodeId: "image-1",
      modelType: "image", modelKey: "gpt-image-2", state: index === 0 ? "running" : "succeeded",
      ...(index === 0 ? { progress: 0.28 } : {}),
      createdAt: `2026-09-29T08:00:${String(index).padStart(2, "0")}.000Z`
    })),
    capabilities: { resolveTaskDisplay: makeResolveDisplay() }
  });
  return <Stage note="13 条记录 · 最早任务仍在运行 · 全部任务入口">
    <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
  </Stage>;
};
Overflow.storyName = "超出展示上限";

/**
 * 三种来源同一列表（change: 2026-10-22-unify-task-activity-rows，任务 3.4）。
 *
 * 生成任务、扩展后台活动与组创作按开始时间从新到旧交错；终态记录在同一停留时长后一起
 * 下滑淡出。这里用 `data-testid` 暴露「推进组创作到终态」的按钮，便于人工复核滑出。
 */
export const MixedSources: Story = () => {
  const capabilities = useMemo<ActivityRowCapabilities>(() => ({
    locateNode: () => undefined,
    resolveTaskDisplay: makeResolveDisplay(),
    group: {
      writable: () => true,
      resolveTitle: (nodeId) => nodeId === "group-running" ? "故事分镜（创作组）" : "人物设定（创作组）",
      action: async () => undefined,
      openConversation: () => undefined
    }
  }), []);
  const controls = useActivityStoreFixture({
    seed: defaultActivitySeed(),
    groups: groupActivitySeed(),
    capabilities
  });
  const [kinds, setKinds] = useState<string[]>([]);
  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        <code>TaskActivityFeed</code> · 任务 / 后台活动 / 组创作同列表交错
      </div>
      <div className="showcase__actions">
        <button
          type="button"
          data-testid="activity-inspect"
          onClick={() => setKinds(controls.store.getSnapshot().rows.map((row: ActivityRow) => row.key))}
        >
          读取统一记录
        </button>
        <button
          type="button"
          data-testid="activity-finish-group"
          onClick={() => controls.store.replaceGroupRuns({
            rows: groupActivitySeed().map((run) => run.active
              ? { ...run, status: "succeeded", label: "已完成", active: false }
              : run),
            error: ""
          })}
        >
          推进组创作到终态
        </button>
      </div>
      <div className="showcase__activity-stage" data-row-keys={kinds.join(",")}>
        <StoryFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
      </div>
    </div>
  );
};
MixedSources.storyName = "三种来源同列表";
