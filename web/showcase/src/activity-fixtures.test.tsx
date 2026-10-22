/**
 * Task activity showcase fixtures
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 4.2）。
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
  defaultActivitySeed
} from "./fixtures/activity-fixtures.js";

function render(seed: ReturnType<typeof defaultActivitySeed>) {
  const controls = createActivityStoreFixture({ seed });
  const markup = renderToStaticMarkup(
    <TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} onLocateNode={() => undefined} />
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
      await act(async () => root.render(<TaskActivityFeed store={controls.store} resolveMediaUrl={activityFixtureMediaUrl} onLocateNode={() => undefined} />));
      const failed = container.querySelector<HTMLElement>('[aria-label="失败"]');
      expect(failed).not.toBeNull();
      await act(async () => failed!.focus());
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("上游 provider 超时");
    } finally {
      await act(async () => root.unmount());
      controls.dispose(); container.remove();
    }
  });

  it("四类媒体结果都渲染出预览或摘要", () => {
    const markup = render([
      activityRecord({ taskKey: "w-img", runId: "r-img", nodeId: "image-1", state: "succeeded", result: { mediaKind: "image", storageKey: "sha256-img" } }),
      activityRecord({ taskKey: "w-vid", runId: "r-vid", nodeId: "video-1", state: "succeeded", result: { mediaKind: "video", storageKey: "sha256-vid", durationSeconds: 8, poster: { storageKey: "sha256-vid-poster" } } }),
      activityRecord({ taskKey: "w-aud", runId: "r-aud", nodeId: "audio-1", state: "succeeded", result: { mediaKind: "audio", storageKey: "sha256-aud", durationSeconds: 21 } }),
      activityRecord({ taskKey: "w-txt", runId: "r-txt", nodeId: "text-1", state: "succeeded", result: { mediaKind: "text", text: "生成文本摘要" } })
    ]);
    expect(markup).toContain("sha256-vid-poster");
    expect(markup).toContain("生成文本摘要");
    expect(markup).toContain("播放音频");
  });

  it("空 seed 渲染折叠入口", () => {
    const markup = render([]);
    expect(markup).toContain("task-activity-feed__entry");
  });
});
