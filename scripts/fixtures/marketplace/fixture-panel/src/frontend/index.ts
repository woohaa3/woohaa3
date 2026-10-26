/**
 * 纯前端 fixture：在画布工具栏状态位贡献一个小字，用于验证「安装后已打开页面不刷新即可装配」。
 */
import { createElement } from "react";
import { defineExtensionPlugin, type Context, type ExtensionFrontendDescriptor, type SlotsService } from "@woohaa3/frontend/extension-api";
import { metadata } from "./metadata.js";

export const FIXTURE_PANEL_TEXT = "fixture-panel 已装配";

export const descriptor: ExtensionFrontendDescriptor = {
  ...metadata,
  plugin: () =>
    defineExtensionPlugin<Context & { slots: SlotsService }>((ctx) => {
      ctx.effect(() =>
        ctx.slots.register("canvas.toolbar-status", {
          id: "fixture-panel.status",
          owner: metadata.extensionId,
          order: 900,
          render: () => createElement("span", { "data-testid": "fixture-panel-status" }, FIXTURE_PANEL_TEXT)
        })
      );
    })
};
