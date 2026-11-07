/**
 * 全景查看 Plugin。
 *
 * 图片节点的操作横条上出现「查看全景」，点开后用球面查看器环视这张图
 * （等距柱状 2:1，例如「生成全景图」的产物）。
 *
 * 只做本地查看：不写 nodeData / Y.Doc，不进导航聚焦，也不动 Bevy 主画布。
 * 横条图标集是协议里的封闭枚举，这里不加图标（`icon` 可选），因此不碰协议层。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { definePlugin } from "../../plugin.js";
import { resolveImageFocusTarget } from "../../focus/image-focus-target.js";
import { downloadFilename, saveDownload } from "../../services/file-download.js";
import { IMPORT_SERVICE, type ImportService } from "../service-keys.js";
import { PanoramaOverlay, type PanoramaActions } from "./panorama-overlay.js";
import { panoramaStore } from "./panorama-store.js";

export const PANORAMA_VIEWER_PLUGIN_ID = "panorama-viewer";

export function panoramaViewerExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const getCanvas = () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;

      const nodeTitle = (nodeId: string, fallback: string): string => {
        const data = getCanvas()?.nodeData[nodeId] as { title?: unknown } | undefined;
        return typeof data?.title === "string" && data.title.trim() ? data.title.trim() : fallback;
      };

      const actions: PanoramaActions = {
        // 截图 → 走和「本地上传」同一条导入链路，落成画布上的一个新图片节点。
        async saveScreenshot(blob, baseName, sourceNodeId) {
          const importService = ctx.get(IMPORT_SERVICE) as ImportService | undefined;
          if (!importService) return { ok: false, error: "当前环境不能保存到画布" };
          const file = new File([blob], `${baseName}-screenshot.png`, { type: "image/png" });
          const result = await importService.importBatch({
            files: [file],
            anchor: { world: null },
            source: "picker",
            selectedNodeIds: [sourceNodeId]
          });
          return result.ok ? { ok: true } : { ok: false, error: "保存到画布失败" };
        },
        async download(url, baseName) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`下载失败 (${response.status})`);
          const blob = await response.blob();
          saveDownload(blob, downloadFilename(baseName, blob.type || "image/png"));
        }
      };

      // 排在「去P图」(21) 之后。查看不写入，所以不看 `writable`。
      const removeAction = ctx.slots.register("canvas.node-action", {
        id: "image-panorama-view",
        owner: PANORAMA_VIEWER_PLUGIN_ID,
        order: 22,
        describe: ({ nodeId }) => {
          if (!resolveImageFocusTarget(getCanvas(), nodeId)) return null;
          return { label: "查看全景", enabled: true };
        },
        activate: ({ nodeId }) => {
          const target = resolveImageFocusTarget(getCanvas(), nodeId);
          if (target) panoramaStore.open(nodeId, target.url, nodeTitle(nodeId, target.asset.title));
        }
      });

      const removeOverlay = ctx.slots.register("canvas.overlay", {
        id: "panorama-view",
        owner: PANORAMA_VIEWER_PLUGIN_ID,
        priority: 40,
        render: () => <PanoramaOverlay store={panoramaStore} actions={actions} />
      });

      // 查看中的节点被删除 / 切换画布：关掉，避免浮层停在一个不存在的目标上。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => {
        const { nodeId } = panoramaStore.getSnapshot();
        if (nodeId && !resolveImageFocusTarget(getCanvas(), nodeId)) panoramaStore.close();
      });

      ctx.effect(() => () => {
        unsubscribeCanvas();
        removeAction();
        removeOverlay();
        panoramaStore.close();
      }, "panorama-viewer-lifecycle");
    },
    { name: PANORAMA_VIEWER_PLUGIN_ID, inject: ["slots"] }
  );
}
