/**
 * 执行面板懒加载骨架的外壳
 * （回归：选中图片节点时面板先在页面顶部闪现，加载完才落到底部）。
 *
 * 骨架必须与真实面板落在同一表面，否则会先在文档流左上角出现一次，再跳到贴底 dock。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { ExecutionPanelSurface, ExecutionPanelPending, resolveExecutionPanelSurface } from "./execution-panel-surface.js";

describe("执行面板呈现表面", () => {
  it("compact 骨架在底部 dock 内，而不是文档流里的裸骨架", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionPanelPending, { nodeId: "img-1", presentation: "compact" })
    );
    expect(html).toMatch(/^<div class="node-execution-dock" data-node-id="img-1" data-presentation="compact">/);
    expect(html).toContain("authoring-generate-placeholder");
  });

  it("expanded 骨架复用 fullscreen 宿主，不落到底部 dock", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionPanelPending, { nodeId: "img-1", presentation: "expanded" })
    );
    expect(html).toContain('class="fullscreen-panel-host"');
    expect(html).toContain('data-presentation="expanded"');
    expect(html).not.toContain("node-execution-dock");
  });

  it("音频没有展开面；图片/文本/视频保留展开面", () => {
    expect(resolveExecutionPanelSurface("expanded", "audio")).toBe("compact");
    expect(resolveExecutionPanelSurface("expanded", "image")).toBe("expanded");
    expect(resolveExecutionPanelSurface("expanded", "video")).toBe("expanded");
    expect(resolveExecutionPanelSurface("expanded", "text")).toBe("expanded");
    expect(resolveExecutionPanelSurface("compact", "image")).toBe("compact");
  });

  it("节点类型未知（画布尚未就绪）时仍按 expanded 渲染，不丢弃骨架", () => {
    expect(resolveExecutionPanelSurface("expanded", null)).toBe("expanded");
    expect(resolveExecutionPanelSurface(undefined, "image")).toBe("compact");
  });
});


it("reveals a large anchor arriving during locate, then yields to user navigation", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div class="app"><canvas id="bevy-canvas"></canvas><main></main></div>';
  const callbacks = new Set<FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.add(fn); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({left:0,top:0,width:1280,height:800} as DOMRect);
  let frame = () => {};
  let node = {left:200,top:900,width:1800,height:1100};
  let viewport = {x:0,y:0,zoom:1};
  const panViewportTo = vi.fn((next: typeof viewport) => {
    node = {...node,top:node.top+next.y-viewport.y}; viewport = next;
  });
  const runtime = {
    nodeScreenRect: () => node,
    controller: () => ({viewport: () => viewport,panViewportTo}),
    subscribeViewport: () => () => {},
    subscribeFrame: (fn: () => void) => { frame = fn; return () => {}; }
  };
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(createElement(ExecutionPanelSurface, {nodeId:"area",presentation:"compact",runtime:runtime as never,children:"composer"})));
    const dock = document.querySelector<HTMLElement>(".node-execution-dock")!;
    frame(); expect(dock.style.visibility).toBe("hidden");
    expect(panViewportTo).not.toHaveBeenCalled();
    // The asynchronous locate animation brings the giant area into view.
    node = {...node,top:200};
    frame(); frame();
    expect(panViewportTo).toHaveBeenCalledOnce();
    expect(dock.style.visibility).toBe("visible");
    expect(Number.parseFloat(dock.style.maxHeight)).toBeGreaterThanOrEqual(360);
    // A later locate frame may replace its preview; the dock still reserves room.
    node = {...node,top:100}; frame(); frame();
    expect(panViewportTo).toHaveBeenCalledTimes(2);
    document.getElementById("bevy-canvas")!.dispatchEvent(new WheelEvent("wheel", {bubbles:true}));
    node = {...node,top:200}; frame();
    expect(panViewportTo).toHaveBeenCalledTimes(2);
    expect(dock.style.visibility).toBe("hidden");
  } finally {
    await act(async () => root.unmount());
    document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
