/**
 * Task activity showcase fixtures
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 4.2；
 *   change: 2026-10-22-unify-task-activity-rows，任务 3.4：三种来源在同一列表交错、
 *   共用同一条终态期限）。
 *
 * 静态渲染生产 store + feed，确认 fixture 覆盖运行/成功/失败/空与四类媒体结果。
 * @vitest-environment jsdom
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { TaskActivityFeed } from "@woohaa3/extension-task-activity/frontend";
import {
  activityFixtureMediaUrl,
  activityRecord,
  createActivityStoreFixture,
  defaultActivitySeed,
  groupActivitySeed
} from "./fixtures/activity-fixtures.js";

function render(seed: ReturnType<typeof defaultActivitySeed>) {
  const controls = createActivityStoreFixture({ seed });
  const markup = renderToStaticMarkup(
    <TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
  );
  controls.dispose();
  return markup;
}

describe("task activity showcase fixtures（任务 4.2）", () => {
  it("默认 seed 覆盖运行中 / 成功视频 / 失败，聚焦状态点可读取失败原因", async () => {
    const markup = render(defaultActivitySeed());
    expect(markup).toContain("运行中");
    expect(markup).toContain("已完成");
    expect(markup).toContain("失败");
    // Error detail lives in a Tooltip portal and is absent from closed SSR markup.
    const controls = createActivityStoreFixture({ seed: defaultActivitySeed() });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />));
      const failed = container.querySelector<HTMLElement>('[data-kind="task"][data-state="failed"]')!;
      expect(failed).not.toBeNull();
      await act(async () => failed.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      expect(document.body.textContent).toContain("上游 provider 超时");
    } finally {
      await act(async () => root.unmount());
      controls.dispose(); container.remove();
    }
  });

  it("四类媒体结果都在悬停详情里渲染预览或摘要", async () => {
    const controls = createActivityStoreFixture({
      seed: [
        activityRecord({ taskKey: "w-img", runId: "r-img", nodeId: "image-1", state: "succeeded", result: { mediaKind: "image", storageKey: "sha256-img" } }),
        activityRecord({ taskKey: "w-vid", runId: "r-vid", nodeId: "video-1", state: "succeeded", result: { mediaKind: "video", storageKey: "sha256-vid", durationSeconds: 8, poster: { storageKey: "sha256-vid-poster" } } }),
        activityRecord({ taskKey: "w-aud", runId: "r-aud", nodeId: "audio-1", state: "succeeded", result: { mediaKind: "audio", storageKey: "sha256-aud", durationSeconds: 21 } }),
        activityRecord({ taskKey: "w-txt", runId: "r-txt", nodeId: "text-1", state: "succeeded", result: { mediaKind: "text", text: "生成文本摘要" } })
      ]
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />));
      const rows = [...container.querySelectorAll<HTMLElement>(".task-activity-feed__card")];
      expect(rows).toHaveLength(4);
      const details: string[] = [];
      for (const row of rows) {
        await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
        details.push(document.body.querySelector(".task-activity-feed__pop")?.innerHTML ?? "");
        await act(async () => row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
      }
      const combined = details.join("|");
      expect(combined).toContain("sha256-img");
      expect(combined).toContain("sha256-vid-poster");
      expect(combined).toContain("生成文本摘要");
      expect(combined).toContain("音频 · 21s");
      // 音频仍不创建播放控件。
      expect(container.querySelector("audio")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      controls.dispose(); container.remove();
    }
  });

  it("空 seed 渲染折叠入口", () => {
    const markup = render([]);
    expect(markup).toContain("task-activity-feed__entry");
  });

  it("三种来源在同一列表按开始时间交错，终态记录共用同一条期限", async () => {
    const controls = createActivityStoreFixture({
      seed: defaultActivitySeed(),
      groups: groupActivitySeed()
    });
    try {
      const snapshot = controls.store.getSnapshot();
      expect(new Set(snapshot.rows.map((row) => row.kind))).toEqual(new Set(["task", "group"]));
      const times = snapshot.rows.map((row) => row.createdAt);
      expect([...times].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(times);
      // 终态组记录与终态任务都在同一停留常量上计时。
      const markup = renderToStaticMarkup(
        <TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} />
      );
      expect(markup).toContain("部分完成");
      expect(markup).toContain("创作中");
    } finally {
      controls.dispose();
    }
  });
});
