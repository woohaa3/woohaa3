/**
 * Generic Model Interaction Plugin
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.4 / design D9）。
 *
 * 在 activation 中把 `generic-model@1` 注册进 page-scoped `modelInteractions` Registry。
 * 这是 text/image/audio/普通 video 的内置交互；专用模型（Seedance）由各自 Plugin 注册。
 *
 * 不在 import evaluation 产生全局副作用；disposer 幂等且随 Canvas page scope 释放。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { GenericModelPanel } from "./generic-panel.js";

export const GENERIC_MODEL_PLUGIN_ID = "generic-model-interaction";
export const GENERIC_MODEL_INTERACTION_ID = "generic-model";
export const GENERIC_MODEL_INTERACTION_VERSION = 1;

export function genericModelInteractionExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx) => {
      const dispose = ctx.modelInteractions.register({
        id: GENERIC_MODEL_INTERACTION_ID,
        version: GENERIC_MODEL_INTERACTION_VERSION,
        owner: GENERIC_MODEL_PLUGIN_ID,
        Panel: GenericModelPanel
      });
      ctx.effect(() => () => dispose(), "generic-model-interaction");
    },
    {
      name: GENERIC_MODEL_PLUGIN_ID,
      inject: ["modelInteractions"]
    }
  );
}
