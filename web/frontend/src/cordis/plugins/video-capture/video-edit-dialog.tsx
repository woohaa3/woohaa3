/**
 * 视频编辑标记 dialog renderer
 * （change: port-video-editing-dialogs，任务 3.1–3.5；design D5/D6/D7/D10）。
 *
 * 纯 UI：草稿事务（打开即复制 initialIntents，cancel 丢弃全部）。时间轴 seek、新增点/区间、
 * 拖动与起止 resize（钳制 duration、最小 0.05 秒）、每 intent 必填 prompt、选择/删除/稳定排序、
 * 视频内容区域上的 pen/rect 标注（色板、线宽、undo/redo/clear，letterbox 排除的归一化坐标）。
 * 确认时对含 shapes 的 intent 捕获对应帧并合成标记图，把 `intents + previews` 交给 Plugin
 * 稳定化上传；不直接把 Blob/data URL 写入规范状态。busy 时禁止重复确认与隐式关闭。
 *
 * 辅助与视图块拆到同级模块（change: 2026-09-28-split-frontend-god-plugins，task 5）：
 * `video-edit-helpers`（纯函数/常量/类型）、`video-edit-timeline`（预览+时间轴+工具）、
 * `video-edit-intents`（意图列表）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  VIDEO_EDIT_ALLOWED_COLORS,
  VIDEO_EDIT_ALLOWED_STROKE_WIDTHS,
  sortVideoEditIntents,
  type VideoEditAnnotationShape,
  type VideoEditIntent
} from "@woohaa3/contracts";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { Button } from "@woohaa3/ui";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import {
  MIN_RANGE_SECONDS,
  clampRange,
  clampTimelineRange,
  getVideoContentRect,
  toNormalizedPoint
} from "./video-geometry.js";
import {
  copyIntent,
  createIntentId,
  createShapeId,
  isTextEditingTarget,
  toSafePreviewError,
  type TimelineDrag,
  type TimelineDragMode,
  type Tool,
  type VideoEditStorySeed
} from "./video-edit-helpers.js";
import { composeAnnotatedFrame } from "./video-edit-compose.js";
import { useOverlayCanvas, usePlayerSize } from "./video-edit-overlay.js";
import { TimelineView } from "./video-edit-timeline.js";
import { IntentList } from "./video-edit-intents.js";
import type { VideoDialogPayload, VideoEditConfirmAction } from "./types.js";

export type { VideoEditStorySeed } from "./video-edit-helpers.js";

export function createVideoEditRenderer({ onConfirm, story }: { onConfirm: VideoEditConfirmAction; story?: VideoEditStorySeed }) {
  return function VideoEditRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as VideoDialogPayload;
    const initialIntents = story?.intents ?? payload.initialIntents ?? [];
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const timelineRef = useRef<HTMLDivElement | null>(null);
    const timelineDragRef = useRef<TimelineDrag | null>(null);
    const drawingRef = useRef<VideoEditAnnotationShape | null>(null);
    const syncedIntentSeekId = useRef<string | undefined>(undefined);
    const intentsRef = useRef<VideoEditIntent[]>([]);

    const [intents, setIntents] = useState<VideoEditIntent[]>(() => initialIntents.map(copyIntent));
    const [activeIntentId, setActiveIntentId] = useState<string | undefined>(() => {
      const initial = story?.activeIntentId ?? payload.initialIntentId;
      if (initial && initialIntents.some((intent) => intent.id === initial)) return initial;
      return initialIntents[0]?.id;
    });
    const [tool, setTool] = useState<Tool>(story?.tool ?? "pen");
    const [color, setColor] = useState<string>(VIDEO_EDIT_ALLOWED_COLORS[0]!);
    const [strokeWidth, setStrokeWidth] = useState<number>(VIDEO_EDIT_ALLOWED_STROKE_WIDTHS[1]!);
    const [draftShape, setDraftShape] = useState<VideoEditAnnotationShape | null>(null);
    const [redoStacks, setRedoStacks] = useState<Record<string, VideoEditAnnotationShape[]>>({});
    const [busy, setLocalBusy] = useState(story?.busy ?? false);
    const [error, setError] = useState<string | null>(story?.error ?? null);
    const [playerSize] = usePlayerSize(playerRef);
    const [videoState, setVideoState] = useState({
      duration: story?.video?.duration ?? 0,
      currentTime: story?.video?.currentTime ?? 0,
      playing: false,
      muted: false,
      ready: Boolean(story?.video),
      width: story?.video?.width ?? 0,
      height: story?.video?.height ?? 0
    });
    const [scrubTime, setScrubTime] = useState<number | null>(null);

    useEffect(() => {
      intentsRef.current = intents;
    }, [intents]);

    const duration = videoState.duration;
    const ready = videoState.ready && duration > 0 && videoState.width > 0;
    const playing = videoState.playing;
    const activeIntent = intents.find((intent) => intent.id === activeIntentId);
    const ordered = useMemo(() => sortVideoEditIntents(intents), [intents]);
    const playheadTime = scrubTime ?? videoState.currentTime;

    const syncState = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      setVideoState({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        currentTime: video.currentTime,
        playing: !video.paused && !video.ended,
        muted: video.muted,
        ready: video.readyState >= 2,
        width: video.videoWidth,
        height: video.videoHeight
      });
    }, []);

    const contentRect = useMemo(
      () => getVideoContentRect(videoState.width, videoState.height, playerSize.width, playerSize.height),
      [playerSize.height, playerSize.width, videoState.height, videoState.width]
    );

    // --- overlay canvas redraw + player size ----------------------------------
    const overlayShapes = [...(activeIntent?.annotationShapes ?? []), ...(draftShape ? [draftShape] : [])];
    useOverlayCanvas(canvasRef, contentRect, overlayShapes);

    // 选中/重开 intent 时 seek 到其起点。
    useEffect(() => {
      if (!activeIntentId || syncedIntentSeekId.current === activeIntentId) return;
      syncedIntentSeekId.current = activeIntentId;
      const video = videoRef.current;
      const intent = intentsRef.current.find((item) => item.id === activeIntentId);
      if (video && intent) {
        video.currentTime = clampRange(intent.startSeconds, 0, Number.isFinite(video.duration) ? video.duration : intent.startSeconds);
      }
    }, [activeIntentId]);

    const seekPlayback = useCallback(
      (time: number) => {
        const video = videoRef.current;
        if (!video || duration <= 0) return;
        const target = clampTimelineRange({ startSeconds: time, duration }).startSeconds;
        setScrubTime(target);
        video.currentTime = target;
      },
      [duration]
    );

    // --- keyboard: shape undo/redo, intent delete (respect text inputs) ---------
    const undo = useCallback(() => {
      const intent = intentsRef.current.find((item) => item.id === activeIntentId);
      if (!intent || intent.annotationShapes.length === 0) return;
      const latest = intent.annotationShapes[intent.annotationShapes.length - 1]!;
      setIntents((current) => current.map((item) => item.id === activeIntentId ? { ...item, annotationShapes: item.annotationShapes.slice(0, -1) } : item));
      setRedoStacks((current) => ({ ...current, [activeIntentId!]: [...(current[activeIntentId!] ?? []), latest] }));
    }, [activeIntentId]);

    const redo = useCallback(() => {
      const stack = activeIntentId ? redoStacks[activeIntentId] ?? [] : [];
      const latest = stack[stack.length - 1];
      if (!latest || !activeIntentId) return;
      setIntents((current) => current.map((item) => item.id === activeIntentId ? { ...item, annotationShapes: [...item.annotationShapes, latest] } : item));
      setRedoStacks((current) => ({ ...current, [activeIntentId]: (current[activeIntentId] ?? []).slice(0, -1) }));
    }, [activeIntentId, redoStacks]);

    const removeIntent = useCallback((id: string) => {
      const next = intentsRef.current.filter((intent) => intent.id !== id);
      setIntents(next);
      intentsRef.current = next;
      if (activeIntentId === id) setActiveIntentId(next[0]?.id);
      setDraftShape(null);
      setRedoStacks((current) => {
        const copy = { ...current };
        delete copy[id];
        return copy;
      });
    }, [activeIntentId]);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (busy) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          if (isTextEditingTarget(event.target)) return; // 文本编辑保留浏览器文本历史。
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
          return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && activeIntentId) {
          if (isTextEditingTarget(event.target)) return; // 不抢占 textarea。
          event.preventDefault();
          removeIntent(activeIntentId);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [activeIntentId, busy, redo, removeIntent, undo]);

    // --- timeline drag ---------------------------------------------------------
    useEffect(() => {
      const onPointerMove = (event: PointerEvent) => {
        const drag = timelineDragRef.current;
        const track = timelineRef.current;
        if (!drag || !track || duration <= 0) return;
        const rect = track.getBoundingClientRect();
        if (rect.width <= 0) return;
        const delta = ((event.clientX - drag.originX) / rect.width) * duration;
        const originalEnd = drag.originEnd;
        let start = drag.originStart;
        let end = originalEnd;
        if (drag.mode === "move") {
          if (originalEnd === undefined) {
            start = clampRange(drag.originStart + delta, 0, duration);
          } else {
            const span = Math.max(MIN_RANGE_SECONDS, originalEnd - drag.originStart);
            start = clampRange(drag.originStart + delta, 0, Math.max(0, duration - span));
            end = start + span;
          }
        } else if (drag.mode === "resize-start" && originalEnd !== undefined) {
          start = clampRange(drag.originStart + delta, 0, Math.max(0, originalEnd - MIN_RANGE_SECONDS));
        } else if (drag.mode === "resize-end") {
          end = clampRange(Math.max(drag.originStart + MIN_RANGE_SECONDS, (originalEnd ?? drag.originStart) + delta), 0, duration);
        }
        const clamped = clampTimelineRange({ startSeconds: start, endSeconds: end, duration });
        setIntents((current) => current.map((intent) => intent.id === drag.id
          ? { ...intent, startSeconds: clamped.startSeconds, ...(clamped.endSeconds === undefined ? { endSeconds: undefined } : { endSeconds: clamped.endSeconds }) }
          : intent));
        setActiveIntentId(drag.id);
        event.preventDefault();
      };
      const onPointerUp = () => {
        timelineDragRef.current = null;
      };
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      return () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };
    }, [duration]);

    const updateActive = useCallback((patch: Partial<VideoEditIntent>) => {
      if (!activeIntentId) return;
      setIntents((current) => current.map((intent) => intent.id === activeIntentId ? { ...intent, ...patch } : intent));
    }, [activeIntentId]);

    const addIntent = useCallback((asRange: boolean) => {
      const video = videoRef.current;
      if (!ready || !video) return;
      video.pause();
      syncState();
      const start = clampRange(video.currentTime, 0, duration);
      const end = asRange ? clampRange(start + MIN_RANGE_SECONDS, 0, duration) : undefined;
      const id = createIntentId();
      const next: VideoEditIntent = {
        id,
        startSeconds: start,
        ...(end !== undefined ? { endSeconds: end } : {}),
        prompt: "",
        annotationShapes: [],
        frameWidth: videoState.width,
        frameHeight: videoState.height
      };
      const list = sortVideoEditIntents([...intentsRef.current, next]);
      intentsRef.current = list;
      setIntents(list);
      setActiveIntentId(id);
      // 让新 intent 的 seek 同步生效。
      syncedIntentSeekId.current = undefined;
      setError(null);
    }, [duration, ready, syncState, videoState.height, videoState.width]);

    const startTimelineDrag = useCallback((event: ReactPointerEvent<HTMLElement>, intent: VideoEditIntent, mode: TimelineDragMode) => {
      if (busy) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.focus();
      setActiveIntentId(intent.id);
      timelineDragRef.current = { id: intent.id, mode, originX: event.clientX, originStart: intent.startSeconds, originEnd: intent.endSeconds };
    }, [busy]);

    // --- drawing ---------------------------------------------------------------
    const readPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      return toNormalizedPoint(event.clientX, event.clientY, rect, contentRect);
    }, [contentRect]);

    const startDrawing = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!activeIntent || busy) return;
      const point = readPoint(event);
      if (!point) return;
      event.preventDefault();
      const shape: VideoEditAnnotationShape = { id: createShapeId(), tool, color, strokeWidth, points: [point] };
      drawingRef.current = shape;
      setDraftShape(shape);
      event.currentTarget.setPointerCapture(event.pointerId);
    }, [activeIntent, busy, color, readPoint, strokeWidth, tool]);

    const moveDrawing = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      const current = drawingRef.current;
      if (!current) return;
      const point = readPoint(event);
      if (!point) return;
      event.preventDefault();
      const next = current.tool === "pen"
        ? { ...current, points: [...current.points, point] }
        : { ...current, points: [current.points[0]!, point] };
      drawingRef.current = next;
      setDraftShape(next);
    }, [readPoint]);

    const stopDrawing = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      const shape = drawingRef.current;
      drawingRef.current = null;
      setDraftShape(null);
      if (shape) {
        const valid = shape.tool === "pen" ? shape.points.length > 1 : shape.points.length === 2;
        if (valid && activeIntentId) {
          setIntents((current) => current.map((intent) => intent.id === activeIntentId
            ? { ...intent, annotationShapes: [...intent.annotationShapes, shape] }
            : intent));
          setRedoStacks((current) => ({ ...current, [activeIntentId]: [] }));
        }
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }, [activeIntentId]);

    const selectTool = useCallback((next: Tool) => {
      drawingRef.current = null;
      setDraftShape(null);
      setTool(next);
    }, []);

    // --- confirm: capture + compose annotation previews ------------------------
    const confirm = useCallback(async () => {
      if (busy) return;
      const current = intentsRef.current;
      const invalid = current.find((intent) => intent.prompt.trim().length === 0);
      if (invalid) {
        setActiveIntentId(invalid.id);
        setError("请为每个编辑点填写修改提示词");
        return;
      }
      if (current.length === 0) return;
      setLocalBusy(true);
      setBusy(true);
      setError(null);
      const video = videoRef.current;
      const wasPlaying = video ? !video.paused : false;
      const previousTime = video?.currentTime ?? 0;
      let seeking = false;
      try {
        const previews = new Map<string, Blob>();
        const marked = sortVideoEditIntents(current).filter((intent) => intent.annotationShapes.length > 0);
        if (marked.length > 0) {
          if (!ready || !video) throw new Error("视频尚未加载完成");
          video.pause();
          seeking = true;
          for (const intent of marked) {
            await new Promise<void>((resolve) => {
              const onSeeked = () => {
                video.removeEventListener("seeked", onSeeked);
                resolve();
              };
              video.addEventListener("seeked", onSeeked);
              video.currentTime = clampRange(intent.startSeconds, 0, duration);
            });
            previews.set(intent.id, await composeAnnotatedFrame(video, intent));
          }
        }
        const payloadIntents: VideoEditIntent[] = sortVideoEditIntents(current).map((intent) => ({
          ...intent,
          prompt: intent.prompt.trim()
        }));
        const result = await onConfirm({ instanceId: instance.instanceId, intents: payloadIntents, previews });
        if (result.ok) {
          requestClose();
          return;
        }
        setError(result.error);
      } catch (confirmError) {
        setError(toSafePreviewError(confirmError));
      } finally {
        if (video && seeking) {
          // 恢复播放位置/状态（尽力而为，不影响草稿保留）。
          video.currentTime = clampRange(previousTime, 0, duration);
          if (wasPlaying) void video.play().catch(() => undefined);
        }
        setLocalBusy(false);
        setBusy(false);
      }
    }, [busy, duration, onConfirm, ready, requestClose, setBusy]);

    const busyNow = busy;

    return (
      <Dialog.Content
        variant="media"
        size="fullscreen"
        busy={busyNow}
        labelledBy={`${instance.instanceId}-title`}
        describedBy={`${instance.instanceId}-desc`}
        instanceId={instance.instanceId}
        onOverlayClick={busyNow ? undefined : requestClose}
      >
        <DialogHeader onClose={busyNow ? undefined : requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>编辑视频</DialogTitle>
          <p className="dlg__description" id={`${instance.instanceId}-desc`}>
            在时间点标记要修改的内容。
          </p>
        </DialogHeader>
        <DialogBody className="video-edit-dialog__body">
          <TimelineView
            payload={payload}
            playerRef={playerRef}
            videoRef={videoRef}
            canvasRef={canvasRef}
            timelineRef={timelineRef}
            syncState={syncState}
            startDrawing={startDrawing}
            moveDrawing={moveDrawing}
            stopDrawing={stopDrawing}
            setError={setError}
            ready={ready}
            playing={playing}
            busyNow={busyNow}
            duration={duration}
            playheadTime={playheadTime}
            setScrubTime={setScrubTime}
            seekPlayback={seekPlayback}
            ordered={ordered}
            activeIntentId={activeIntentId}
            startTimelineDrag={startTimelineDrag}
            removeIntent={removeIntent}
            addIntent={addIntent}
            videoMuted={videoState.muted}
            activeIntent={activeIntent}
            tool={tool}
            selectTool={selectTool}
            color={color}
            setColor={setColor}
            strokeWidth={strokeWidth}
            setStrokeWidth={setStrokeWidth}
            redoStacks={redoStacks}
            undo={undo}
            redo={redo}
            updateActive={updateActive}
            setRedoStacks={setRedoStacks}
          />
          <IntentList
            ordered={ordered}
            activeIntentId={activeIntentId}
            busyNow={busyNow}
            setActiveIntentId={setActiveIntentId}
            removeIntent={removeIntent}
            activeIntent={activeIntent}
            updateActive={updateActive}
          />
        </DialogBody>
        {error ? <p className="dlg__error" role="alert">{error}</p> : null}
        <DialogFooter>
          <span>共 {intents.length} 个编辑点</span>
          <div className="video-edit-dialog__footer-actions">
            <Button size="sm" disabled={busyNow} onClick={requestClose}>取消</Button>
            <Button size="sm" tone="primary" disabled={intents.length === 0 || busyNow} onClick={() => void confirm()}>确认编辑</Button>
          </div>
        </DialogFooter>
      </Dialog.Content>
    );
  };
}
