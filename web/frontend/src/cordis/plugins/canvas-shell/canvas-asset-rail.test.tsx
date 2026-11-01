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

function render(props: { hidden?: boolean } = {}) {
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

  it("是一条栏，不是浮动卡片：只有一层，没有右侧内容面板", () => {
    const host = render();
    // 参考稿就是一条图标列。多出来的内容面板是"更合理"的自我发挥，已按参考稿删掉。
    expect(host.querySelectorAll(".canvas-asset-rail")).toHaveLength(1);
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
    expect(soon).toEqual(["SOON", "SOON"]);

    // 否则读屏会念成「DriveSOON」
    expect(buttonByLabel(host, "Drive（尚未开放）")).toBeTruthy();
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
});
