/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CanvasAssetRail } from "./canvas-asset-rail.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function render() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<CanvasAssetRail />));
  return host;
}

function buttonByLabel(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label
  );
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found as HTMLButtonElement;
}

describe("画布左侧资源轨", () => {
  it("默认展开，六个条目都在，默认选中的是图层", () => {
    const host = render();
    const items = host.querySelectorAll(".canvas-asset-rail__item");
    expect(items).toHaveLength(6);
    expect(host.querySelector(".canvas-asset-rail__item.is-selected")?.textContent).toContain("图层");
    // 选中项的内容区给出说明，而不是空白
    expect(host.querySelector(".canvas-asset-rail__panel")?.textContent).toContain("图层");
  });

  it("示例条目写明了是示例 —— 不能让人以为画布上真有这三张卡", () => {
    const host = render();
    expect(host.textContent).toContain("以上为示例条目");
  });

  it("点另一个条目会切换选中，再点一次收起内容区", () => {
    const host = render();
    const products = buttonByLabel(host, "产品");
    expect(products.getAttribute("aria-pressed")).toBe("false");

    act(() => products.click());
    expect(products.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".canvas-asset-rail__panel")?.textContent).toContain("产品库尚未接入画布");

    act(() => products.click());
    expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();
  });

  it("还没接通的来源带 SOON 角标，点开给的是说明而不是静默失败", () => {
    const host = render();
    const soon = [...host.querySelectorAll(".canvas-asset-rail__soon")].map((node) => node.textContent);
    expect(soon).toEqual(["SOON", "SOON"]);

    // 角标是装饰，不能进可访问名称（否则读成「DriveSOON」）
    act(() => buttonByLabel(host, "Drive（尚未开放）").click());
    expect(host.querySelector(".canvas-asset-rail__panel")?.textContent).toContain("尚未开放");
  });

  it("收起后只剩图标列：文案与内容区都不渲染，展开能回到原样", () => {
    const host = render();
    const toggle = buttonByLabel(host, "收起资源轨");

    act(() => toggle.click());
    expect(host.querySelector(".canvas-asset-rail.is-collapsed")).not.toBeNull();
    expect(host.querySelectorAll(".canvas-asset-rail__label")).toHaveLength(0);
    expect(host.querySelector(".canvas-asset-rail__panel")).toBeNull();

    act(() => buttonByLabel(host, "展开资源轨").click());
    expect(host.querySelectorAll(".canvas-asset-rail__label")).toHaveLength(6);
  });

  it("hidden 时整条轨不渲染（聚焦 / 文档工作区里不该出现）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    act(() => root.render(<CanvasAssetRail hidden />));
    expect(host.querySelector(".canvas-asset-rail")).toBeNull();
  });
});
