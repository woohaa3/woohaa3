import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { readWorldCamera } from "../../services/world-camera-ui.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";
import { worldCaptureDynamicFrameCount, worldCaptureFrameTime } from "@woohaa3/contracts";
import { encodeWorldCameraVideo } from "./world-camera-video-recorder.js";
import type { PageCapturePendingEntry } from "../../contract/remote.js";
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
            if (item.kind === "dynamic" && item.dynamicKey) {
              await recordDynamic(item);
              continue;
            }
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
      /**
       * 动态镜头：宿主只登记待取景，页面逐帧渲染（固定该导演区采样时间）并经 WebCodecs 编码成
       * MP4 后回传。渲染、编码、容器封装都在前端完成，不依赖原生 model-renderer。
       */
      const recordDynamic = async (item: PageCapturePendingEntry): Promise<void> => {
        const runtime = ctx.canvasRuntime;
        const key = item.dynamicKey!;
        const fps = item.fps ?? key.fps;
        try {
          const frames = async function* (): AsyncGenerator<Uint8Array> {
            const total = worldCaptureDynamicFrameCount(key);
            for (let index = 0; index < total; index += 1) {
              if (disposed) return;
              const time = worldCaptureFrameTime(key, index);
              if (item.animationNodeId) {
                runtime.setCaptureAnimationTimes?.(new Map([[item.animationNodeId, time]]));
              }
              await nextFrames();
              const frame = await runtime.captureWorldCameraRaw?.({
                cameraId: item.cameraId,
                width: item.width,
                height: item.height
              });
              if (!frame?.ok) throw new Error(frame?.code ?? "capture-unavailable");
              yield frame.rgba;
            }
          };
          const encoded = await encodeWorldCameraVideo({
            width: item.width,
            height: item.height,
            fps,
            frames: frames()
          });
          if (!encoded.ok) {
            console.warn(`[world-cameras] 动态镜头编码失败 camera=${item.cameraId} code=${encoded.code} ${encoded.message}`);
            return;
          }
          const committed = await ctx.canvasRemote.commitPageVideoCapture({
            cameraId: item.cameraId,
            key,
            mp4: encoded.mp4,
            width: encoded.width,
            height: encoded.height
          });
          if (!committed.ok) {
            console.warn(`[world-cameras] 动态镜头提交失败 camera=${item.cameraId} code=${committed.code} ${committed.error}`);
          }
        } catch (error) {
          console.warn(`[world-cameras] 动态镜头录制失败 camera=${item.cameraId} ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          runtime.setCaptureAnimationTimes?.(null);
        }
      };

      const nextFrames = (): Promise<void> => new Promise((resolve) => {
        if (typeof requestAnimationFrame !== "function") { setTimeout(resolve, 32); return; }
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

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
    ctx.effect(() => {
      // 卡片状态：只读拉取宿主取景状态（动态镜头为 preview/ready/stale/failed）。
      let disposed = false;
      let pending = false;
      const pull = async (): Promise<void> => {
        if (disposed || pending) return;
        pending = true;
        try {
          const result = await ctx.canvasRemote.listWorldCaptureStatuses();
          if (!disposed && result.ok) worldCameraShotStore.set(result.statuses);
        } catch {
          // 状态拉取失败保留上一帧呈现，不影响画布渲染。
        } finally {
          pending = false;
        }
      };
      const timer = setInterval(() => void pull(), 1000);
      const offScene = ctx.canvasRuntime.subscribeScene?.(() => void pull());
      void pull();
      return () => {
        disposed = true;
        clearInterval(timer);
        offScene?.();
        worldCameraShotStore.clear();
      };
    }, "world-cameras-shot-status");
    ctx.effect(() => () => {
      removeAction(); remove(); worldCameraEditorStore.close();
    }, "world-cameras-overlay");
  }, { name: WORLD_CAMERAS_PLUGIN_ID, inject: ["slots", "canvasRemote", "canvasEdit", "canvasRuntime", "canvasSession"] });
}
