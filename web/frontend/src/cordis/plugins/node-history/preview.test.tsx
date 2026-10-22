/**
 * 历史预览加载/失败/重试测试（change: 2026-10-09-improve-canvas-workflow，任务 6.2）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { NodeHistoryPreview } from "@woohaa3/contracts";
import { HistoryPreview } from "./preview.js";

function mount(preview: NodeHistoryPreview, props: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<HistoryPreview preview={preview} {...props} />));
  return { container, root };
}

describe("HistoryPreview 加载与失败", () => {
  it("图片成功加载后进入 ready", () => {
    const { container } = mount({ kind: "image", href: "/api/x" });
    const media = container.querySelector("img")!;
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("loading");
    act(() => {
      media.dispatchEvent(new Event("load"));
    });
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("ready");
  });

  it("图片加载失败显示可读原因与重试，不显示破图", () => {
    const { container } = mount({ kind: "image", href: "/api/broken" });
    const media = container.querySelector("img")!;
    act(() => {
      media.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.textContent).toContain("暂时无法加载预览");
    expect(container.textContent).toContain("重试");
  });

  it("素材失效使用区分文案", () => {
    const { container } = mount({ kind: "image", href: "/api/broken" }, { unavailableReason: "素材已不可用" });
    const media = container.querySelector("img")!;
    act(() => {
      media.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toContain("素材已不可用");
  });

  it("重试触发 onRetry 并回到加载中", () => {
    let retried = 0;
    const { container } = mount({ kind: "image", href: "/api/broken" }, { onRetry: () => { retried += 1; }, retryKey: 0 });
    const media = container.querySelector("img")!;
    act(() => {
      media.dispatchEvent(new Event("error"));
    });
    const retryButton = container.querySelector("button")!;
    act(() => {
      retryButton.click();
    });
    expect(retried).toBe(1);
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
  });

  it("模型缩略图缺失时显示占位而不是破图", () => {
    const { container } = mount({ kind: "model", thumbnailHref: null });
    expect(container.textContent).toContain("模型");
    expect(container.querySelector("img")).toBeNull();
  });

  it("视频海报失败同样受控", () => {
    const { container } = mount({ kind: "video", href: "/api/v", posterHref: "/api/poster", durationSeconds: 5 });
    const media = container.querySelector("video")!;
    act(() => {
      media.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
  });

  it("音频不自动播放", () => {
    const { container } = mount({ kind: "audio", href: "/api/a", durationSeconds: 10 });
    expect(container.querySelector("audio")).toBeNull();
    expect(container.textContent).toContain("音频");
  });
});
