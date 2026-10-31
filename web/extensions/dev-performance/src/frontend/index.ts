/**
 * 性能读数面板
 * （fix: Tauri 下 FPS/DC 应显示在顶部栏，而不是右下角工具栏；
 *   fix: 打包的桌面分发版也要显示 FPS/DC）。
 *
 * 读数位置随运行宿主变化，但采集器与渲染只有一份：
 * - **Tauri**：进入窗口横栏右侧（`canvas.topbar-status`）。横栏是窗口装饰，概览与节点聚焦编辑时
 *   都常驻，所以 FPS/DC 在整个工作流里都看得到；
 * - **浏览器**：留在右下角工具栏的原同步状态位置（`canvas.toolbar-status`），与同步详情共用气泡。
 *
 * 注册门禁按宿主分两种：桌面壳无论开发还是打包发行都注册（发行版按 `--mode desktop` 生产构建，
 * HTML 里没有 `woohaa-development` 标记，但 FPS/DC 是打包版也要看的常驻读数）；浏览器仍只认
 * Vite dev 注入的开发标记，生产与 preview 构建不注册。
 *
 * 二选一由扩展按运行宿主自行判定（`isDesktopHost`），宿主不按扩展 ID 分支，也不会两侧同时渲染。
 */
import { createElement, type ComponentProps } from "react";
import {
  defineExtensionPlugin,
  isDesktopHost,
  type CanvasRuntimeService,
  type Context,
  type ExtensionFrontendDescriptor,
  type SlotsService
} from "@woohaa3/frontend/extension-api";
import { metadata } from "./metadata.js";
import { PerformancePanel } from "./panel.js";
import "./style.css";

export const descriptor: ExtensionFrontendDescriptor = {
  ...metadata,
  plugin: () => defineExtensionPlugin<Context & { slots: SlotsService; canvasRuntime: CanvasRuntimeService }>((ctx) => {
    const desktop = isDesktopHost();
    // `woohaa-development` 只由 Vite dev 的 transformIndexHtml 注入；打包桌面版是生产构建，
    // 不能拿它当唯一门禁，否则发行包里永远没有 FPS/DC。
    const development = document.querySelector('meta[name="woohaa-development"]')?.getAttribute("content") === "true";
    if (!desktop && !development) return;
    const read = () => {
      const instance = ctx.canvasRuntime.runtime();
      const counters = instance?.getFrameCounters?.();
      return instance && counters ? { instance, ...counters } : null;
    };
    const Panel = (props: Omit<ComponentProps<typeof PerformancePanel>, "read">) =>
      createElement(PerformancePanel, { ...props, read });
    if (desktop) {
      // 桌面：读数进入窗口横栏的合并读数（同步/连接状态 + FPS/DC 共用一个气泡）。
      ctx.effect(() => ctx.slots.register("canvas.topbar-status", {
        id: "dev-performance.topbar",
        owner: metadata.extensionId,
        priority: 1000,
        wrapsStatus: true,
        render: Panel
      }), "dev-performance-topbar");
      return;
    }
    ctx.effect(() => ctx.slots.register("canvas.toolbar-status", {
      id: "dev-performance.panel",
      owner: metadata.extensionId,
      priority: 1000,
      wrapsStatus: true,
      render: Panel
    }), "dev-performance-panel");
  }, { name: "dev-performance", inject: ["slots", "canvasRuntime"] })
};
