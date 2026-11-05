/**
 * 历史预览加载/失败/重试测试（change: 2026-10-09-improve-canvas-workflow，任务 6.2）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
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

  it("模型缩略图由页面渲染器生成并显示", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const create = vi.fn(() => "blob:model"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const render = vi.fn(async () => ({ ok: true as const, blob: new Blob(["png"], { type: "image/png" }) }));
    await act(async () => {
      root.render(<HistoryPreview
        preview={{ kind: "model", entry: { canvasId: "c", nodeId: "n", entryId: "e" } }}
        renderModelThumbnail={render}
      />);
    });
    await vi.waitFor(() => {
      expect(render).toHaveBeenCalledWith({ canvasId: "c", nodeId: "n", entryId: "e" });
    }, { timeout: 5000 });
    await vi.waitFor(() => {
      expect(container.querySelector("img")?.src).toBe("blob:model");
    }, { timeout: 5000 });
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledWith("blob:model");
    vi.unstubAllGlobals();
  });

  it("没有页面渲染器时模型预览进入受控失败态而不是破图", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<HistoryPreview preview={{ kind: "model", entry: { canvasId: "c", nodeId: "n", entryId: "e" } }} />);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    }, { timeout: 5000 });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("页面渲染尚未就绪");
    await act(async () => root.unmount());
  });

  it("视频海报失败同样受控", () => {
    const { container } = mount({ kind: "video", href: "/api/v", posterHref: "/api/poster", durationSeconds: 5 });
    const media = container.querySelector("img")!;
    act(() => {
      media.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
  });

  it("没有海报的视频版本用受控视频地址取首帧", () => {
    const { container } = mount({ kind: "video", href: "/api/v", posterHref: null, durationSeconds: 5 });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-state="failed"]')).toBeNull();
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/api/v#t=0.1");
    expect(video.autoplay).toBe(false);
    expect(video.muted).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    act(() => {
      video.dispatchEvent(new Event("loadeddata"));
    });
    expect(container.querySelector('[data-state="ready"]')).not.toBeNull();
  });

  it("视频首帧加载失败保留条目并可重试", () => {
    const { container } = mount({ kind: "video", href: "/api/broken", posterHref: null, durationSeconds: 5 });
    act(() => {
      container.querySelector("video")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.textContent).toContain("暂时无法加载预览");
    act(() => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(container.querySelector('[data-state="failed"]')).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("音频不自动播放", () => {
    const { container } = mount({ kind: "audio", href: "/api/a", durationSeconds: 10 });
    expect(container.querySelector("audio")).toBeNull();
    expect(container.textContent).toContain("音频");
  });
});

it("视频详情使用真实媒体地址，显式播放，失败可重试且卸载释放", async () => {
  const { vi } = await import("vitest");
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const f = mount({ kind: "video", href: "/api/movie", posterHref: "/api/poster", durationSeconds: 5 }, { thumbnail: false });
  const video = f.container.querySelector("video")!;
  expect(video.getAttribute("src")).toBe("/api/movie");
  expect(video.controls).toBe(true); expect(video.autoplay).toBe(false);
  act(() => video.dispatchEvent(new Event("error")));
  expect(f.container.textContent).toContain("暂时无法加载视频预览");
  expect(video.getAttribute("src")).toBeNull(); expect(pause).toHaveBeenCalled();
  act(() => f.container.querySelector<HTMLButtonElement>("button")!.click());
  expect(f.container.querySelector("video")?.getAttribute("src")).toBe("/api/movie");
  act(() => f.root.unmount());
  expect(pause.mock.calls.length).toBeGreaterThan(1);
  load.mockRestore(); pause.mockRestore();
});
