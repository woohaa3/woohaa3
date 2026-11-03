/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CanvasAssetRail } from "./canvas-asset-rail.js";
import type { ImageLibraryItem, ImageLibrarySource } from "./image-library.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function item(id: string, patch: Partial<ImageLibraryItem> = {}): ImageLibraryItem {
  return {
    id,
    title: id,
    url: `/api/media/${id}`,
    origin: "uploaded",
    isFavorite: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    canvasId: "c1",
    ...patch
  };
}

function sourceOf(items: ImageLibraryItem[]): ImageLibrarySource {
  return {
    scopeLabel: "当前画布",
    getItems: () => items,
    subscribe: () => () => undefined,
    setFavorite: () => ({ ok: true }),
    addToCanvas: async () => ({ ok: true })
  };
}

function render(props: { hidden?: boolean; imageSource?: ImageLibrarySource } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<CanvasAssetRail {...props} />));
  return host;
}

function buttonByLabel(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label
  );
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found as HTMLButtonElement;
}

describe("画布左侧资源栏", () => {
  it("六个条目都在，默认选中的是图层", () => {
    const host = render();
    const items = host.querySelectorAll(".canvas-asset-rail__item");
    expect(items).toHaveLength(6);
    expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent).toContain("图层");
  });

  it("是一条栏，不是浮动卡片：默认只有一层，没有内容面板", () => {
    const host = render({ imageSource: sourceOf([item("a")]) });
    expect(host.querySelectorAll(".canvas-asset-rail")).toHaveLength(1);
    // 默认选中的是「图层」，它没有面板；只有「图片」才有
    expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
  });

  it("点另一个条目会切换选中，再点一次取消选中", () => {
    const host = render();
    const products = buttonByLabel(host, "产品");
    expect(products.getAttribute("aria-pressed")).toBe("false");

    act(() => products.click());
    expect(products.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent).toContain("产品");

    act(() => products.click());
    expect(host.querySelector(".canvas-asset-rail__item.is-selected")).toBeNull();
  });

  it("还没接通的来源带 SOON 角标，且角标不进可访问名称", () => {
    const host = render();
    const soon = [...host.querySelectorAll(".canvas-asset-rail__soon")].map((node) => node.textContent);
    // 只剩 Drive：Pinterest 已经能用（点一下弹出桌面壳的独立窗口），不再是「尚未开放」
    expect(soon).toEqual(["SOON"]);

    // 否则读屏会念成「DriveSOON」
    expect(buttonByLabel(host, "Drive（尚未开放）")).toBeTruthy();
    // 浏览器里没有桌面壳，Pinterest 是「仅桌面端可用」而不是「尚未开放」，没有 SOON 角标
    expect(buttonByLabel(host, "Pinterest（仅桌面端可用）")).toBeTruthy();
  });

  describe("Pinterest 条目（动作：弹出独立窗口）", () => {
    type Globals = typeof globalThis & { __WOOHAA_DESKTOP__?: unknown };
    const installDesktop = () => {
      (globalThis as Globals).__WOOHAA_DESKTOP__ = { token: "t-1", protocol: "woohaa-window-v1", platform: "windows" };
    };
    afterEach(() => {
      delete (globalThis as Globals).__WOOHAA_DESKTOP__;
      vi.unstubAllGlobals();
    });

    it("不再展开面板，也不进入选中态、不让画布多让一档", () => {
      installDesktop();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { state: "opened", created: true } }))));
      const host = render();
      const entry = buttonByLabel(host, "Pinterest");
      act(() => entry.click());

      expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
      expect(host.querySelector(".canvas-asset-rail.has-panel")).toBeNull();
      // 动作条目不是开关：不能带 aria-pressed，否则读屏会念成「已按下」
      expect(entry.hasAttribute("aria-pressed")).toBe(false);
      expect(entry.classList.contains("is-selected")).toBe(false);
    });

    it("点一下向桌面壳发「打开」，请求里只有动作，没有地址和尺寸", async () => {
      installDesktop();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { state: "opened", created: true } })));
      vi.stubGlobal("fetch", fetchMock);
      const host = render();
      await act(async () => buttonByLabel(host, "Pinterest").click());

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://woohaa-native.localhost/pinterest");
      expect(JSON.parse(init.body as string)).toEqual({ action: "open" });
      expect((init.headers as Record<string, string>)["X-Woohaa-Token"]).toBe("t-1");
    });

    it("点 Pinterest 不会改变原来选中的条目", async () => {
      installDesktop();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { state: "opened", created: true } }))));
      const host = render();
      const selectedBefore = host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent;
      await act(async () => buttonByLabel(host, "Pinterest").click());
      expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent).toBe(selectedBefore);
    });

    it("打开失败要说出来，而不是点了没反应", async () => {
      installDesktop();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "窗口创建失败" }))));
      const host = render();
      await act(async () => buttonByLabel(host, "Pinterest").click());
      expect(host.querySelector(".canvas-asset-rail__failure")?.textContent).toContain("窗口创建失败");
    });

    it("浏览器里没有桌面壳：条目禁用并说明原因，不发请求", () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const host = render();
      const entry = buttonByLabel(host, "Pinterest（仅桌面端可用）");
      expect(entry.disabled).toBe(true);
      act(() => entry.click());
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("收起后只剩图标列，展开能回到原样", () => {
    const host = render();
    act(() => buttonByLabel(host, "收起资源轨").click());
    expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();
    expect(host.querySelectorAll(".canvas-asset-rail__label")).toHaveLength(0);

    act(() => buttonByLabel(host, "展开资源轨").click());
    expect(host.querySelectorAll(".canvas-asset-rail__label")).toHaveLength(6);
  });

  it("hidden 时整条栏不渲染（聚焦 / 文档工作区里不该出现）", () => {
    const host = render({ hidden: true });
    expect(host.querySelector(".canvas-asset-rail")).toBeNull();
  });

  describe("图片面板", () => {
    it("选中「图片」且有数据源时才出现，并让画布多让出一档", () => {
      const host = render({ imageSource: sourceOf([item("a")]) });
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-asset-rail__panel")).not.toBeNull();
      expect(host.querySelector(".canvas-asset-rail.has-panel")).not.toBeNull();

      // 再点一次取消选中，面板收走
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
      expect(host.querySelector(".canvas-asset-rail.has-panel")).toBeNull();
    });

    it("没传数据源时「图片」条目只有选中态，不渲染面板", () => {
      const host = render();
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent).toContain("图片");
      expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
    });

    it("收起栏时面板一起收起，展开后回来", () => {
      const host = render({ imageSource: sourceOf([item("a")]) });
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-asset-rail__panel")).not.toBeNull();

      // 收起是纯视觉的：面板还挂着，只是跟着栏挪到 64px（见 CSS 的 `.is-collapsed` 一档），
      // 展开后原样回来。所以这里断言的是「栏收起了」，不是「面板卸载了」。
      act(() => buttonByLabel(host, "收起资源轨").click());
      expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();
      expect(host.querySelector(".canvas-asset-rail.is-collapsed.has-panel")).not.toBeNull();
      expect(host.querySelector(".canvas-asset-rail__panel")).not.toBeNull();

      act(() => buttonByLabel(host, "展开资源轨").click());
      expect(host.querySelector(".canvas-asset-rail.is-collapsed")).toBeNull();
      expect(host.querySelector(".canvas-asset-rail__panel")).not.toBeNull();
    });

    it("收起态下点「图片」直接出面板，不先把栏展开", () => {
      const host = render({ imageSource: sourceOf([item("a")]) });
      act(() => buttonByLabel(host, "收起资源轨").click());
      expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();

      act(() => buttonByLabel(host, "图片").click());
      // 栏保持收起，面板紧贴窄栏右缘出来 —— 早先在收起态点它只会多一个高亮
      expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();
      expect(host.querySelector(".canvas-asset-rail.has-panel")).not.toBeNull();
      expect(host.querySelector(".canvas-asset-rail__panel")).not.toBeNull();
      // 收起态条目只渲染图标、不渲染文字，所以按 aria-label 认它
      expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.getAttribute("aria-label")).toBe("图片");
    });

    it("收起态下点「图片」两次，面板收走", () => {
      const host = render({ imageSource: sourceOf([item("a")]) });
      act(() => buttonByLabel(host, "收起资源轨").click());
      act(() => buttonByLabel(host, "图片").click());
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
      expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();
    });

    it("按来源分组并显示数量，「没有更多了」收尾", () => {
      const host = render({
        imageSource: sourceOf([
          item("u1"),
          item("u2"),
          item("g1", { origin: "generated" })
        ])
      });
      act(() => buttonByLabel(host, "图片").click());
      const headings = [...host.querySelectorAll(".canvas-image-panel__heading")].map((n) => n.textContent);
      expect(headings).toEqual(["画布上传 · 2", "画布生成 · 1"]);
      expect(host.querySelectorAll(".canvas-image-panel__tile")).toHaveLength(3);
      expect(host.querySelector(".canvas-image-panel__end")?.textContent).toBe("没有更多了");
    });

    it("来源 chip 筛选、再点取消；没有外部来源时不出现「外部导入」chip", () => {
      const host = render({
        imageSource: sourceOf([item("u1"), item("g1", { origin: "generated" })])
      });
      act(() => buttonByLabel(host, "图片").click());
      expect(host.textContent).not.toContain("外部导入");

      act(() => buttonByLabel(host, "画布生成").click());
      expect(host.querySelectorAll(".canvas-image-panel__tile")).toHaveLength(1);
      expect(buttonByLabel(host, "画布生成").getAttribute("aria-pressed")).toBe("true");

      act(() => buttonByLabel(host, "画布生成").click());
      expect(host.querySelectorAll(".canvas-image-panel__tile")).toHaveLength(2);
    });

    it("收藏 tab 只显示收藏的图，没有时给空态", () => {
      const host = render({
        imageSource: sourceOf([item("u1"), item("u2", { isFavorite: true })])
      });
      act(() => buttonByLabel(host, "图片").click());
      act(() => buttonByLabel(host, "收藏的图片").click());
      expect(host.querySelectorAll(".canvas-image-panel__tile")).toHaveLength(1);

      const empty = render({ imageSource: sourceOf([item("only")]) });
      act(() => buttonByLabel(empty, "图片").click());
      act(() => buttonByLabel(empty, "收藏的图片").click());
      expect(empty.querySelector(".canvas-image-panel__empty")?.textContent).toBe("还没有收藏的图片");
    });

    it("画布里没有图片时给空态，并如实标出范围", () => {
      const host = render({ imageSource: sourceOf([]) });
      act(() => buttonByLabel(host, "图片").click());
      expect(host.querySelector(".canvas-image-panel__empty")?.textContent).toBe("这张画布里还没有图片");
      expect(host.querySelector(".canvas-image-panel__scope")?.textContent).toContain("当前画布");
    });
  });
});
