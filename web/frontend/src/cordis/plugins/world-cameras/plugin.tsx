import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { readWorldCamera } from "../../services/world-camera-ui.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { CameraEditor } from "./camera-editor.js";
import "./world-cameras.css";

export { adoptCameraTimeline } from "./camera-timeline.js";
export const WORLD_CAMERAS_PLUGIN_ID = "world-cameras";

export function WorldCameraOverlay({ ctx, canvasId, writable }: { ctx: Context; canvasId?: string; writable: boolean }) {
  const session = useSyncExternalStore(worldCameraEditorStore.subscribe, worldCameraEditorStore.getSnapshot, () => null);
  if (!session || (canvasId && session.canvasId !== canvasId)) return null;
  return <CameraEditor key={`${session.canvasId}:${session.nodeId}`} ctx={ctx} session={session} writable={writable} />;
}

export function worldCamerasExtension(options: { canvasId?: string } = {}): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const removeAction = ctx.slots.register("canvas.node-action", {
      id: "world-camera-edit",
      owner: WORLD_CAMERAS_PLUGIN_ID,
      order: -10,
      describe: ({ nodeId, writable }) => {
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
        const camera = readWorldCamera(canvas, nodeId);
        if (!camera) return null;
        return { label: "编辑", icon: "edit", iconOnly: true, tone: "primary", enabled: writable && !worldCameraEditorStore.getSnapshot() };
      },
      activate: ({ nodeId, writable }) => {
        if (!writable || !ctx.canvasSession.isWritable() || ctx.canvasRuntime.isFocused()) return;
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
        const camera = readWorldCamera(canvas, nodeId);
        if (!canvas || !camera || (options.canvasId && canvas.id !== options.canvasId)) return;
        ctx.canvasRuntime.cancelTransientGesture();
        worldCameraEditorStore.begin(canvas.id, nodeId, camera);
      }
    });
    const remove = ctx.slots.register("canvas.overlay", {
      id: WORLD_CAMERAS_PLUGIN_ID,
      owner: WORLD_CAMERAS_PLUGIN_ID,
      priority: 24,
      render: (props) => <WorldCameraOverlay ctx={ctx} canvasId={options.canvasId} writable={props.writable} />
    });
    ctx.effect(() => {
      // 页面驱动取景：宿主观察到镜头或视锥体内世界版本变化时登记待取景，页面在同一次
      // 渲染里主动出图并提交，使直连镜头与显式生成的冻结都立刻拿到当前帧，不依赖原生 renderer。
      let running = false;
      let disposed = false;
      const drain = async (): Promise<void> => {
        if (running || disposed) return;
        running = true;
        try {
          const runtime = ctx.canvasRuntime;
          if (!runtime?.captureWorldCamera) return;
          const pending = await ctx.canvasRemote.listPendingPageCaptures();
          if (!pending.ok) return;
          for (const item of pending.captures) {
            if (disposed) return;
            if (options.canvasId && item.canvasId !== options.canvasId) continue;
            if (!(item.width > 0) || !(item.height > 0)) continue;
            const frame = await runtime.captureWorldCamera({ cameraId: item.cameraId, width: item.width, height: item.height });
            if (disposed) return;
            if (!frame.ok) {
              console.warn(`[world-cameras] 页面取景渲染失败 camera=${item.cameraId} code=${frame.code}`);
              continue;
            }
            const committed = await ctx.canvasRemote.commitPageCapture({
              cameraId: item.cameraId, key: item.key, png: frame.png, width: item.width, height: item.height
            });
            if (!committed.ok) {
              console.warn(`[world-cameras] 页面取景提交失败 camera=${item.cameraId} code=${committed.code} ${committed.error}`);
            }
          }
        } catch {
          // 失败留在待取景清单里，下一拍重试。
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void drain(), 400);
      // 场景提交很频繁：合并到一次短延迟，避免每个提交都打一次待取景请求。
      let scheduled: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (scheduled !== null) return;
        scheduled = setTimeout(() => { scheduled = null; void drain(); }, 150);
      };
      const offScene = ctx.canvasRuntime.subscribeScene?.(() => schedule());
      void drain();
      return () => {
        disposed = true;
        clearInterval(timer);
        if (scheduled !== null) clearTimeout(scheduled);
        offScene?.();
      };
    }, "world-cameras-capture-producer");
    ctx.effect(() => () => {
      removeAction(); remove(); worldCameraEditorStore.close();
    }, "world-cameras-overlay");
  }, { name: WORLD_CAMERAS_PLUGIN_ID, inject: ["slots", "canvasRemote", "canvasEdit", "canvasRuntime", "canvasSession"] });
}
