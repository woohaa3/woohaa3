/**
 * Media Preview / Dialog builtins Plugin
 * （change: adopt-frontend-cordis-plugin-runtime，design D5/D11）。
 *
 * 首个迁移切片：把 `media-preview` 与 `alert` 的 definition/renderer 注册从模块导入副作用
 * 改为 Plugin effect。所有注册返回 disposer，由 Plugin scope 统一撤销；双击节点只发
 * 类型化事件，Host 通过 Dialog Service 打开。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { MEDIA_PREVIEW_DIALOG_ID, mediaPreviewDefinition, resolveAudioPreview } from "./media-preview.js";
import { TEXT_PREVIEW_DIALOG_ID, textPreviewDefinition } from "./text-preview.js";
import { ALERT_DIALOG_ID, alertDefinition } from "../../services/dialogs/alert-dialog.js";
import { createMediaPreviewRenderer, createTextPreviewRenderer, createAlertRenderer } from "./builtin-renderers.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { definePlugin } from "../../plugin.js";
import "./text-preview.css";

export const MEDIA_PREVIEW_PLUGIN_ID = "media-preview";

type PreviewEvent = { assetId: string; nodeId: string; title: string };
// 保留 payload 形状文档（实际类型由 event catalog 提供）。
export type { PreviewEvent };

export const mediaPreviewExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    const dialogs = ctx.dialogs;

    const disposePreview = dialogs.registerDialog(MEDIA_PREVIEW_DIALOG_ID, {
      definition: mediaPreviewDefinition,
      renderer: createMediaPreviewRenderer()
    });
    const disposeAlert = dialogs.registerDialog(ALERT_DIALOG_ID, {
      definition: alertDefinition,
      renderer: createAlertRenderer(dialogs)
    });
    const disposeText = dialogs.registerDialog(TEXT_PREVIEW_DIALOG_ID, {
      definition: textPreviewDefinition,
      renderer: createTextPreviewRenderer()
    });

    const disposeAudioAction = ctx.slots.register("canvas.node-action", {
      id: "audio-preview", owner: MEDIA_PREVIEW_PLUGIN_ID, order: -1, available: () => true,
      describe: ({ nodeId, nodeType }) => nodeType !== "audio" ? null : {
        label: "试听", tone: "neutral", enabled: resolveAudioPreview(woohaa3CanvasStore.getState().canvas, nodeId) !== null,
        reason: "音频尚未就绪或缺少可读取的输出"
      },
      activate: ({ nodeId, menu }) => {
        if (menu) return;
        const canvas = woohaa3CanvasStore.getState().canvas;
        const resolved = resolveAudioPreview(canvas, nodeId);
        if (resolved) dialogs.open({ dialogId: MEDIA_PREVIEW_DIALOG_ID,
          payload: { nodeId, assetId: resolved.assetId, title: resolved.title, kind: "audio", canvasId: canvas!.id } });
      }
    });

    // 双击图片节点 → 打开 singleton 媒体预览（只带资产身份；payload 校验在 Service）。
    const offPreview = ctx.on("ui.media-preview.open-requested", (payload) => {
      dialogs.open({ dialogId: MEDIA_PREVIEW_DIALOG_ID, payload });
    });
    const offTextPreview = ctx.on("ui.text-preview.open-requested", (payload) => {
      dialogs.open({ dialogId: TEXT_PREVIEW_DIALOG_ID, payload });
    });

    return () => {
      disposeAudioAction();
      offPreview();
      offTextPreview();
      disposeText();
      disposeAlert();
      disposePreview();
    };
  },
  { name: MEDIA_PREVIEW_PLUGIN_ID, inject: ["dialogs", "slots"] }
);
