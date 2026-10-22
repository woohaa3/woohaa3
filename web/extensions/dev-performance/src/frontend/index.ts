/**
 * 开发性能面板
 * （fix: Tauri 下 FPS/DC 应显示在顶部栏，而不是右下角工具栏）。
 *
 * 读数位置随运行宿主变化，但采集器与渲染只有一份：
 * - **Tauri**：进入窗口横栏右侧（`canvas.topbar-status`）。横栏是窗口装饰，概览与节点聚焦编辑时
 *   都常驻，所以 FPS/DC 在整个工作流里都看得到；
 * - **浏览器**：留在右下角工具栏的原同步状态位置（`canvas.toolbar-status`），与同步详情共用气泡。
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
    if (document.querySelector('meta[name="woohaa-development"]')?.getAttribute("content") !== "true") return;
    const read = () => {
      const instance = ctx.canvasRuntime.runtime();
      const counters = instance?.getFrameCounters?.();
      return instance && counters ? { instance, ...counters } : null;
    };
    const Panel = (props: Omit<ComponentProps<typeof PerformancePanel>, "read">) =>
      createElement(PerformancePanel, { ...props, read });
    if (isDesktopHost()) {
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
