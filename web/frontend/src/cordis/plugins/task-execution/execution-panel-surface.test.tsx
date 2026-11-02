/**
 * 执行面板懒加载骨架的外壳
 * （回归：选中图片节点时面板先在页面顶部闪现，加载完才落到底部）。
 *
 * 骨架必须与真实面板落在同一表面，否则会先在文档流左上角出现一次，再跳到贴底 dock。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanelPending, resolveExecutionPanelSurface } from "./execution-panel-surface.js";

describe("执行面板呈现表面", () => {
  it("compact 骨架在底部 dock 内，而不是文档流里的裸骨架", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionPanelPending, { nodeId: "img-1", presentation: "compact" })
    );
    // `node-execution-bar-dock` 是贴底常驻条的修饰类；定位仍由 `layoutDockedPanel` 写在行内。
    // 首次渲染默认收成一条（`data-collapsed="true"`），点开后才是完整面板；
    // 首帧先 `visibility:hidden`，量完画布区域再显示（避免闪在左上角）。
    expect(html).toMatch(/^<div class="node-execution-dock node-execution-bar-dock" data-node-id="img-1" data-presentation="compact" data-collapsed="true" style="visibility:hidden">/);
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
