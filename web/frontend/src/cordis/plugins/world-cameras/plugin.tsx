import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { readWorldCamera } from "../../services/world-camera-ui.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";
import { worldCameraShotContext, worldCaptureDynamicFrameCount, worldCaptureFrameTime } from "@woohaa3/contracts";
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
        return { label: "机位精调", icon: "edit", tone: "primary", enabled: writable && !worldCameraEditorStore.getSnapshot() };
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
      let lastDynamic = "";
      const abort = new AbortController();
      const progress = new Map<string, { key: string; label: string; reason?: string; failed?: boolean; retryAt?: number }>();
      const keyOf = (item: PageCapturePendingEntry) => JSON.stringify([item.attemptId, item.dynamicKey ?? item.key]);
      const eligible = (item: PageCapturePendingEntry) => !disposed
        && (!options.canvasId || item.canvasId === options.canvasId) && item.width > 0 && item.height > 0
        && (progress.get(item.cameraId)?.key !== keyOf(item) || (progress.get(item.cameraId)?.retryAt ?? 0) <= Date.now());
      const update = (item: PageCapturePendingEntry, label: string,
        stage: "rendering" | "encoding" | "uploading" = "rendering", completedFrames?: number, totalFrames?: number) => {
        if (disposed) return;
        progress.set(item.cameraId, { key: keyOf(item), label });
        if (item.attemptId) void ctx.canvasRemote.reportPageCaptureProgress?.({ cameraId: item.cameraId, attemptId: item.attemptId,
          stage, ...(completedFrames !== undefined ? { completedFrames, totalFrames } : {}) }, abort.signal);
      };
      const fail = (item: PageCapturePendingEntry, reason = "capture-unavailable") => {
        if (!disposed) {
          progress.set(item.cameraId, { key: keyOf(item), label: "取景失败 · 重试", reason, failed: true, retryAt: Date.now() + 10_000 });
          if (item.attemptId) void ctx.canvasRemote.reportPageCaptureProgress?.({ cameraId: item.cameraId, attemptId: item.attemptId, stage: "failed", reason }, abort.signal);
        }
      };
      const removeCaptureAction = ctx.slots.register("canvas.node-action", {
        id: "world-camera-capture-progress", owner: WORLD_CAMERAS_PLUGIN_ID, order: -5,
        describe: ({ nodeId, writable }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const camera = readWorldCamera(canvas, nodeId);
          const canonical = camera && worldCameraShotStore.get(camera.cameraId);
          const state = camera && (progress.get(camera.cameraId) ?? (canonical?.phase === "failed"
            ? { label: "取景失败 · 重试", reason: canonical.reason, failed: true } : null));
          if (state) return { label: state.label, enabled: !!state.failed && writable,
            ...(state.failed ? { reason: `取景未完成（${state.reason}），可重试当前版本` } : {}) };
          if (!canvas || !camera || worldCameraShotContext(canvas, camera)?.kind !== "dynamic") return null;
          if (canonical?.phase === "waiting" || canonical?.phase === "capturing") {
            return { label: "正在录制取景", enabled: false };
          }
          return { label: canonical?.video ? "重新录制" : "录制",
            enabled: writable && !worldCameraEditorStore.getSnapshot() };
        },
        activate: ({ nodeId, writable }) => {
          if (!writable || !ctx.canvasSession.isWritable()) return;
          const camera = readWorldCamera(workingCanvasOf(woohaa3CanvasStore.getState()), nodeId);
          const canonical = camera && worldCameraShotStore.get(camera.cameraId);
          if (camera && !worldCameraEditorStore.getSnapshot()
            && (!progress.has(camera.cameraId) || progress.get(camera.cameraId)?.failed)
            && canonical?.phase !== "waiting" && canonical?.phase !== "capturing") {
            progress.set(camera.cameraId, { key: "manual", label: "准备录制取景" });
            void (async () => {
              const retried = await ctx.canvasRemote.retryPageCapture(camera.cameraId, abort.signal);
              if (retried && !disposed) { progress.delete(camera.cameraId); await drain(); }
              else if (!disposed) progress.set(camera.cameraId, { key: "manual", label: "取景失败 · 重试", failed: true, reason: "capture-unavailable" });
            })();
          }
        }
      });
      const captureStatic = async (item: PageCapturePendingEntry): Promise<void> => {
        if (!eligible(item)) return;
        try {
          update(item, "正在取景");
          const frame = await ctx.canvasRuntime.captureWorldCamera!({ cameraId: item.cameraId, width: item.width, height: item.height });
          if (disposed) return;
          if (!frame.ok) { fail(item, frame.code); return; }
          update(item, "正在保存取景", "uploading");
          const committed = await ctx.canvasRemote.commitPageCapture({
            cameraId: item.cameraId, attemptId: item.attemptId, key: item.key, png: frame.png, width: item.width, height: item.height, signal: abort.signal
          });
          if (!committed.ok) fail(item, committed.code); else progress.delete(item.cameraId);
        } catch {
          fail(item);
        }
      };
      const drain = async (): Promise<void> => {
        if (running || disposed) return;
        running = true;
        try {
          const runtime = ctx.canvasRuntime;
          if (!runtime?.captureWorldCamera || runtime.getStatus().phase !== "ready" || !runtime.runtime()?.isReady()) return;
          const pending = await ctx.canvasRemote.listPendingPageCaptures(abort.signal);
          if (!pending.ok) return;
          for (const item of pending.captures) {
            if (item.kind !== "dynamic") await captureStatic(item);
          }
          // One recording at a time owns animation sampling. Rotate failed/long cameras fairly.
          const dynamic = pending.captures.filter(item => item.kind === "dynamic" && item.dynamicKey && eligible(item));
          const previous = dynamic.findIndex(item => item.cameraId === lastDynamic);
          const item = dynamic[(previous + 1) % dynamic.length];
          if (item && !disposed) { lastDynamic = item.cameraId; await recordDynamic(item); }
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
        let renderFailure: string | undefined;
        try {
          const frames = async function* (): AsyncGenerator<Uint8Array> {
            const total = worldCaptureDynamicFrameCount(key);
            for (let index = 0; index < total; index += 1) {
              if (disposed) throw new Error("cancelled");
              update(item, `录制取景 ${index + 1}/${total}`, "rendering", index + 1, total);
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
              if (!frame?.ok) {
                renderFailure = frame?.code ?? "capture-unavailable";
                throw new Error(renderFailure);
              }
              yield frame.rgba;
            }
            update(item, "正在编码取景", "encoding");
          };
          update(item, "准备录制取景");
          const encoded = await encodeWorldCameraVideo({
            width: item.width,
            height: item.height,
            fps,
            frames: frames(), signal: abort.signal
          });
          if (!encoded.ok) {
            fail(item, renderFailure ?? encoded.code);
            return;
          }
          if (disposed) return;
          update(item, "正在保存视频取景", "uploading");
          const committed = await ctx.canvasRemote.commitPageVideoCapture({
            cameraId: item.cameraId,
            attemptId: item.attemptId,
            key,
            mp4: encoded.mp4,
            width: encoded.width,
            height: encoded.height, signal: abort.signal
          });
          if (!committed.ok) fail(item, committed.code); else progress.delete(item.cameraId);
        } catch {
          fail(item);
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
        abort.abort();
        removeCaptureAction();
        progress.clear();
        clearInterval(timer);
        if (scheduled !== null) clearTimeout(scheduled);
        offScene?.();
      };
    }, "world-cameras-capture-producer");
    ctx.effect(() => {
      // 卡片状态：只读拉取宿主取景状态（动态镜头为 preview/ready/stale/failed）。
      let disposed = false;
      let pending = false;
      const abort = new AbortController();
      const pull = async (): Promise<void> => {
        if (disposed || pending) return;
        pending = true;
        try {
          const result = await ctx.canvasRemote.listWorldCaptureStatuses(abort.signal);
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
        abort.abort();
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
