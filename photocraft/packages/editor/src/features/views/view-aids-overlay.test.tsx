/** @vitest-environment jsdom */
// 只验证叠加层的几何与刻度输出（纯 SVG，不采集像素、不截图）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewAidsOverlay, gridSubdivisions, rulerTicks } from "./view-aids-overlay.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

function render(element: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root!.render(element); });
  return host;
}

const base = { guides: { vertical: [30], horizontal: [20] }, origin: { x: 10, y: 12 }, zoom: 1, width: 120, height: 90 };

describe("网格细分与标尺刻度", () => {
  it("按偏好把网格单元等分，非法细分退回不细分", () => {
    expect(gridSubdivisions(20, 1)).toEqual([]);
    expect(gridSubdivisions(20, 4)).toEqual([5, 10, 15]);
    expect(gridSubdivisions(20, 0)).toEqual([]);
    expect(gridSubdivisions(20, 17)).toEqual([]);
    expect(gridSubdivisions(20, undefined)).toEqual([]);
    expect(gridSubdivisions(0, 4)).toEqual([]);
  });

  it("标尺步长在屏幕上不小于 60px，并且零点跟着标尺原点走", () => {
    // zoom 1：raw = 60 → 取 100 这一档？不，1/2/5/10 里 100 是最小的 ≥60，所以步长 100。
    expect(rulerTicks(500, 1)).toEqual([0, 100, 200, 300, 400, 500]);
    // 缩到 0.5 倍：源像素跨度翻倍 → 步长 200。
    expect(rulerTicks(500, 0.5)).toEqual([0, 200, 400]);
    // 原点移到 30：刻度从 0 开始按步长排，0 落在源坐标 30 上。
    const ticks = rulerTicks(500, 1, 30);
    expect(ticks.slice(0, 3)).toEqual([0, 100, 200]);
    expect(ticks.at(-1)).toBeLessThanOrEqual(470);
    // 未布局/非法输入不产生刻度，界面显示空标尺而不是 NaN。
    expect(rulerTicks(0, 1)).toEqual([]);
    expect(rulerTicks(500, 0)).toEqual([]);
    expect(rulerTicks(500, Number.NaN)).toEqual([]);
  });
});

describe("视图辅助叠加层", () => {
  it("旋转后参考线按两端点投影，不再是水平/垂直线段", () => {
    const host = render(<ViewAidsOverlay {...base} aids={{ guides: true }} rotation={90} />);
    const line = host.querySelector('[data-guide="vertical-0"]')!;
    // 90° 下源竖线在屏幕上成了水平线：两端 y 相同、x 不同（允许浮点误差）。
    const attr = (name: string) => Number(line.getAttribute(name));
    expect(attr("y1")).toBeCloseTo(attr("y2"), 6);
    expect(Math.abs(attr("x1") - attr("x2"))).toBeGreaterThan(1);
    expect(host.querySelector("[data-view-aids-overlay]")!.getAttribute("data-rotation")).toBe("90");
  });

  it("网格细分与标尺单位都出现在输出里", () => {
    const host = render(<ViewAidsOverlay {...base} aids={{ grid: true, gridStep: [20, 20], gridSubdivisions: 4, rulers: true }}
      rulerOrigin={[30, 10]} formatLength={(px) => `${px} px`} />);
    expect(host.querySelector("[data-grid-subdivisions]")!.getAttribute("data-grid-subdivisions")).toBe("4");
    expect(host.querySelector("[data-rulers]")!.getAttribute("data-ruler-origin")).toBe("30,10");
    const labels = [...host.querySelectorAll("text")].map((node) => node.textContent);
    expect(labels.length).toBeGreaterThan(1);
    // 刻度文字走内核的单位换算，不是叠加层自己四舍五入。
    expect(labels.every((label) => label?.endsWith(" px"))).toBe(true);
  });

  it("关闭辅助时不画对应图层", () => {
    const host = render(<ViewAidsOverlay {...base} aids={{ grid: false, guides: false, rulers: false }} />);
    expect(host.querySelector("[data-guide='vertical-0']")).toBeNull();
    expect(host.querySelector("[data-rulers]")).toBeNull();
    expect(host.querySelector("rect")).toBeNull();
  });
});

describe("标尺条拖出新参考线（U70）", () => {
  const withRulers = { ...base, aids: { rulers: true } };

  it("上边标尺按下交出一条竖线意图，左边交出横线", () => {
    const calls: Array<[boolean, number]> = [];
    const host = render(<ViewAidsOverlay {...withRulers} onRulerDown={(vertical, pointerId) => { calls.push([vertical, pointerId]); return true; }} />);
    const top = host.querySelector('[data-ruler-strip="horizontal"]')!;
    const left = host.querySelector('[data-ruler-strip="vertical"]')!;
    // 角落（< 24 / < 20）留给原点拖动，不新建参考线。
    top.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 8 }));
    left.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 8, clientY: 5 }));
    expect(calls).toEqual([]);
    top.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 8 }));
    left.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 8, clientY: 60 }));
    expect(calls.map(([vertical]) => vertical)).toEqual([true, false]);
  });

  it("没有接管方时标尺条保持纯展示，不吞画布指针", () => {
    const host = render(<ViewAidsOverlay {...withRulers} />);
    const top = host.querySelector('[data-ruler-strip="horizontal"]') as SVGElement;
    expect(top.style.pointerEvents).toBe("");
    expect(top.getAttribute("cursor")).toBeNull();
  });

  it("标尺上的按下不再冒泡成画布落笔，即使接管方拒绝（锁定）", () => {
    // 覆盖层在画布容器内部，事件会冒泡到画布的 onPointerDown。标尺不是文档区域：
    // 点在标尺上永远不该落笔，锁定时更不能因为「没接管成功」就漏成一次绘画。
    const refused = vi.fn(() => false);
    // React 把监听挂在根容器上，所以「是否冒泡到画布」要用 React 属性验证，
    // 而不是在 DOM 上再挂一个原生监听（那个总会在根容器上触发）。
    const bubble = vi.fn();
    const host = render(<div onPointerDown={bubble}><ViewAidsOverlay {...withRulers} onRulerDown={refused} /></div>);
    const top = host.querySelector('[data-ruler-strip="horizontal"]')!;
    top.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 8 }));
    expect(refused).toHaveBeenCalledOnce();
    expect(bubble).not.toHaveBeenCalled();
  });
});
