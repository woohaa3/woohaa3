/**
 * TaskActivityFeed 渲染与媒体守卫（change: 2026-09-29-add-canvas-task-activity-feed，任务 4.1）。
 *
 * 用 `react-dom/server` 静态渲染生产组件，断言：
 * - active/终态卡片文案、进度、错误；
 * - 媒体预览只经 resolveMediaUrl，且音频 hover 不自动创建播放控件；
 * - 折叠入口的可访问名称与未读徽标。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BackgroundActivityJob, CanvasTaskActivity } from "@woohaa3/contracts";
import { TaskActivityStore } from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";

function storeWith(records: CanvasTaskActivity[], cursor = 1): TaskActivityStore {
  const store = new TaskActivityStore();
  for (const record of records) store.applyServerRecord(record, cursor);
  return store;
}

function record(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return {
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 0,
    ...patch
  };
}

const media = (storageKey: string) => `https://cdn.test/${storageKey}`;

describe("TaskActivityFeed（任务 3.2 / 3.4 / 4.1）", () => {
  it("无记录时显示可访问的折叠入口", () => {
    const store = storeWith([]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).toContain("task-activity-feed__entry");
    expect(markup).toContain('aria-label="任务活动"');
    store.dispose();
  });

  it("active 任务同时显示阶段、实际百分比，保持单行", () => {
    // 面板与画布节点共用「按种类的经过时间估算」：这里让记录刚开始 10s，估算 22%，
    // 上报 42% 更高，因此显示上报值（change: 2026-10-31-unify-node-and-activity-progress）。
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const store = storeWith([
      record({
        taskKey: "t1", runId: "r1", nodeId: "n1", state: "running", modelType: "image",
        modelKey: "gpt-image-2", progress: 0.42, createdAt: startedAt, updatedAt: startedAt
      })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).toContain("gpt-image-2");
    expect(markup).toContain("运行中");
    expect(markup).toContain("运行中 · 42%");
    expect(markup).not.toContain("task-activity-feed__progress");
    store.dispose();
  });

  it("没有上报进度时按经过时间估算，与节点进度环同一个数字", () => {
    // 图片节点估算时长 45s：开始 22.5s 前 ≈ 50%。
    const startedAt = new Date(Date.now() - 22_500).toISOString();
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "running", modelType: "image", createdAt: startedAt, updatedAt: startedAt })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).toMatch(/运行中 · (49|50|51)%/);
    store.dispose();
  });

  it("失败任务使用状态圆点，错误详情默认隐藏", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "failed", error: { name: "ProviderError", message: "上游失败" } })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).toContain("失败");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("<summary");
    expect(markup).not.toContain("上游失败");
    store.dispose();
  });

  it("标题替代定位图标，终态项保留关闭按钮", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "succeeded" })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).toContain('<button type="button" class="task-activity-feed__primary"');
    expect(markup).not.toContain('task-activity-feed__locate');
    expect(markup).toContain('aria-label="关闭该记录"');
    // 不再渲染整块「定位节点」文本按钮。
    expect(markup).not.toContain(">定位节点<");
    store.dispose();
  });

  it("成功音频项不自动创建播放控件（播放控件留在弹窗）", () => {
    const store = storeWith([
      record({
        taskKey: "t1",
        runId: "r1",
        nodeId: "n1",
        state: "succeeded",
        result: { mediaKind: "audio", storageKey: "sha256-abc", durationSeconds: 12 }
      })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).not.toContain('aria-label="播放音频"');
    expect(markup).not.toContain("<audio");
    store.dispose();
  });

  it("成功视频不占用行内空间，预览延迟到悬停", () => {
    const store = storeWith([
      record({
        taskKey: "t1",
        runId: "r1",
        nodeId: "n1",
        state: "succeeded",
        result: { mediaKind: "video", storageKey: "sha256-vid", durationSeconds: 5, poster: { storageKey: "sha256-poster" } }
      })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(markup).not.toContain("https://cdn.test/sha256-poster");
    store.dispose();
  });

  it("关闭/收起图标来自 Lucide facade（任务 5.1/5.2）", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "succeeded" }),
      record({ taskKey: "t2", runId: "r2", nodeId: "n2", state: "succeeded", result: { mediaKind: "audio", storageKey: "sha256-a", durationSeconds: 9 } })
    ]);
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    // Button/IconButton 统一 class 前缀。
    expect(markup).toContain('aria-label="关闭该记录"');
    expect(markup).not.toContain('aria-label="播放音频"');
    // 图标是 Lucide svg（aria-hidden，不承担 accessible name）。
    const svgCount = (markup.match(/class="lucide/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(3);
    store.dispose();
  });

  it("滚动列表展示全部记录，关闭只移除对应记录", () => {
    const store = storeWith(Array.from({ length: 12 }, (_, index) => record({
      taskKey: `t${index}`,
      runId: `r${index}`,
      nodeId: `n${index}`,
      modelKey: `model-${index}`,
      state: "succeeded",
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`
    })));
    const renderFeed = () => renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    const markup = renderFeed();
    expect(markup).toContain("ui-scroll-area");
    expect(markup).toContain('aria-label="任务活动列表"');
    // Collapsible trigger 暴露 aria-expanded。
    expect(markup).toContain('aria-expanded="true"');
    const titles = (html: string) => [...html.matchAll(/class="task-activity-feed__primary"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(titles(markup)).toEqual(Array.from({ length: 12 }, (_, index) => `model-${11 - index}`));
    expect(store.getSnapshot().items).toHaveLength(12);
    expect(markup).not.toContain("条记录 · 进行中优先显示");
    store.dismiss("t11");
    expect(titles(renderFeed())).toEqual(Array.from({ length: 11 }, (_, index) => `model-${10 - index}`));
    store.dispose();
  });

  it("运行和终态任务按提交时间排序，状态不插队", () => {
    const records = Array.from({ length: 12 }, (_, index) => record({
      taskKey: `t${index}`, runId: `r${index}`, nodeId: `n${index}`,
      modelKey: `model-${index}`, state: index === 0 ? "running" : "succeeded",
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`
    }));
    const store = storeWith(records);
    const before = store.getSnapshot().items.map((item) => item.taskKey);
    const markup = renderToStaticMarkup(<TaskActivityFeed store={store} resolveMediaUrl={media} />);
    const titles = [...markup.matchAll(/class="task-activity-feed__primary"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(titles).toHaveLength(12);
    expect(titles[0]).toBe("model-11");
    expect(titles[11]).toBe("model-0");
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(before);
    store.dispose();
  });
});

describe("TaskActivityFeed 后台活动", () => {
  const job = (patch: Partial<BackgroundActivityJob> = {}): BackgroundActivityJob => ({
    id: "shot-reference:c1:film:clip-1",
    canvasId: "c1",
    kind: "shot-reference-recording",
    title: "片场 · 镜头 1",
    status: "running",
    progress: 0.4,
    nodeId: "film",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch
  });

  it("超过六条录制活动仍全部呈现，后续重试不被截断", () => {
    const store = new TaskActivityStore();
    for (let i = 0; i < 9; i++) {
      store.applyJob(job({
        id: `attempt-${i}`, title: `录制尝试 ${i}`,
        status: i === 8 ? "running" : "failed",
        updatedAt: `2026-01-01T00:00:0${i}Z`
      }));
    }
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    for (let i = 0; i < 9; i++) expect(markup).toContain(`录制尝试 ${i}`);
    expect(markup.indexOf("录制尝试 8")).toBeLessThan(markup.indexOf("录制尝试 7"));
    store.dispose();
  });

  it("录制与生成按开始时间交错，进度更新不改变排序", () => {
    const store = storeWith([
      record({ taskKey: "t1", runId: "r1", nodeId: "n1", modelKey: "生成-旧", createdAt: "2026-01-01T00:00:01Z" }),
      record({ taskKey: "t2", runId: "r2", nodeId: "n2", modelKey: "生成-新", createdAt: "2026-01-01T00:00:03Z", state: "succeeded" })
    ]);
    // 宿主装配会注入节点定位；有定位能力的后台活动行渲染为按钮（与生产一致）。
    store.configure({ locateNode: () => undefined });
    store.applyJob(job({ title: "中间录制", updatedAt: "2026-01-01T00:00:02Z" }));
    store.applyJob(job({ title: "中间录制", progress: 0.9, updatedAt: "2026-01-01T00:00:09Z" }));
    const markup = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    const titles = [...markup.matchAll(/class="task-activity-feed__primary"[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
    expect(titles).toEqual(["生成-新", "录制镜头参考 · 中间录制", "生成-旧"]);
    store.dispose();
  });

  it("后台活动显示种类、状态与进度，终态可关闭", () => {
    const store = new TaskActivityStore();
    store.applyJob(job());
    const running = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(running).toContain("录制镜头参考 · 片场 · 镜头 1");
    expect(running).toContain("录制中 · 40%");
    expect(running).not.toContain("关闭该记录");

    store.applyJob(job({ status: "succeeded", progress: 1, updatedAt: "2026-01-01T00:00:02Z" }));
    const done = renderToStaticMarkup(
      <TaskActivityFeed store={store} resolveMediaUrl={media} />
    );
    expect(done).toContain("已录制");
    expect(done).toContain("关闭该记录");
    store.dispose();
  });
});
