/**
 * 视频编辑 dialog 的预览 + 时间轴 + 标注工具
 * （change: 2026-09-28-split-frontend-god-plugins，task 5；从 video-edit-dialog.tsx 拆出）。
 *
 * 纯展示与事件转发：播放控制、时间轴 slider、编辑块拖动/删除、标注工具与色板。
 */
import type { Dispatch, MutableRefObject, SetStateAction, PointerEvent as ReactPointerEvent } from "react";
import {
  VIDEO_EDIT_ALLOWED_COLORS,
  VIDEO_EDIT_ALLOWED_STROKE_WIDTHS,
  isVideoEditRange,
  type VideoEditIntent
} from "@woohaa3/contracts";
import { formatVideoTime } from "./video-geometry.js";
import {
  Button,
  IconButton,
  MuteIcon,
  PenIcon,
  PauseIcon,
  PlayIcon,
  RedoIcon,
  RectangleIcon,
  UndoIcon,
  VolumeIcon
} from "../../../shared/ui/index.js";
import type { TimelineDragMode, Tool } from "./video-edit-helpers.js";
import type { VideoDialogPayload } from "./types.js";

export type TimelineViewProps = {
  payload: VideoDialogPayload;
  playerRef: MutableRefObject<HTMLDivElement | null>;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  timelineRef: MutableRefObject<HTMLDivElement | null>;
  syncState: () => void;
  startDrawing: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  moveDrawing: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  stopDrawing: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  ready: boolean;
  playing: boolean;
  busyNow: boolean;
  duration: number;
  playheadTime: number;
  setScrubTime: Dispatch<SetStateAction<number | null>>;
  seekPlayback: (time: number) => void;
  ordered: readonly VideoEditIntent[];
  activeIntentId: string | undefined;
  startTimelineDrag: (event: ReactPointerEvent<HTMLElement>, intent: VideoEditIntent, mode: TimelineDragMode) => void;
  removeIntent: (id: string) => void;
  addIntent: (asRange: boolean) => void;
  videoMuted: boolean;
  activeIntent: VideoEditIntent | undefined;
  tool: Tool;
  selectTool: (next: Tool) => void;
  color: string;
  setColor: (item: string) => void;
  strokeWidth: number;
  setStrokeWidth: (item: number) => void;
  redoStacks: Record<string, import("@woohaa3/contracts").VideoEditAnnotationShape[]>;
  undo: () => void;
  redo: () => void;
  updateActive: (patch: Partial<VideoEditIntent>) => void;
  setRedoStacks: Dispatch<SetStateAction<Record<string, import("@woohaa3/contracts").VideoEditAnnotationShape[]>>>;
};

export function TimelineView({
  payload,
  playerRef,
  videoRef,
  canvasRef,
  timelineRef,
  syncState,
  startDrawing,
  moveDrawing,
  stopDrawing,
  setError,
  ready,
  playing,
  busyNow,
  duration,
  playheadTime,
  setScrubTime,
  seekPlayback,
  ordered,
  activeIntentId,
  startTimelineDrag,
  removeIntent,
  addIntent,
  videoMuted,
  activeIntent,
  tool,
  selectTool,
  color,
  setColor,
  strokeWidth,
  setStrokeWidth,
  redoStacks,
  undo,
  redo,
  updateActive,
  setRedoStacks
}: TimelineViewProps) {
  return (
    <section className="video-edit-dialog__preview">
      <div ref={playerRef} className="video-edit-dialog__player">
        <video
          ref={videoRef}
          className="video-edit-dialog__video"
          src={payload.videoUrl}
          poster={payload.posterUrl}
          preload="auto"
          playsInline
          onLoadedMetadata={syncState}
          onLoadedData={syncState}
          onCanPlay={syncState}
          onDurationChange={syncState}
          onTimeUpdate={syncState}
          onSeeked={syncState}
          onPlay={syncState}
          onPause={syncState}
          onError={() => setError("视频加载失败，无法编辑")}
        />
        <canvas
          ref={canvasRef}
          className="video-edit-dialog__canvas"
          aria-label="视频标注画布"
          onPointerDown={startDrawing}
          onPointerMove={moveDrawing}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
        />
      </div>
      <div className="video-edit-dialog__player-controls" aria-label="视频播放控制">
        <IconButton
          label={playing ? "暂停" : "播放"}
          size="sm"
          disabled={!ready || busyNow}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.paused) void video.play().catch(() => setError("视频播放失败"));
            else video.pause();
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <span>{formatVideoTime(playheadTime)} / {formatVideoTime(duration)}</span>
        <IconButton
          label={videoMuted ? "取消静音" : "静音"}
          size="sm"
          disabled={!ready || busyNow}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            syncState();
          }}
        >
          {videoMuted ? <MuteIcon /> : <VolumeIcon />}
        </IconButton>
      </div>

      <div className="video-edit-dialog__timeline">
        <div className="video-edit-dialog__timeline-head">
          <span>当前 {formatVideoTime(playheadTime)}</span>
          <div className="video-edit-dialog__timeline-add">
            <Button size="sm" disabled={!ready || busyNow} onClick={() => addIntent(false)}>添加时间点</Button>
            <Button size="sm" tone="primary" disabled={!ready || busyNow} onClick={() => addIntent(true)}>添加区间</Button>
          </div>
        </div>
        <div ref={timelineRef} className="video-edit-dialog__track">
          <input
            type="range"
            className="video-edit-dialog__timeline-slider"
            aria-label="视频编辑时间轴"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={Math.min(playheadTime, Math.max(duration, 0.01))}
            disabled={!ready || busyNow}
            onChange={(event) => seekPlayback(Number(event.target.value))}
            onPointerUp={() => setScrubTime(null)}
          />
          <span className="video-edit-dialog__playhead" style={{ left: `${duration > 0 ? (playheadTime / duration) * 100 : 0}%` }} />
          {ordered.map((intent) => {
            const range = isVideoEditRange(intent);
            const left = duration > 0 ? (intent.startSeconds / duration) * 100 : 0;
            const width = range ? Math.max(1.5, ((intent.endSeconds! - intent.startSeconds) / duration) * 100) : undefined;
            return (
              <div
                key={intent.id}
                tabIndex={0}
                role="button"
                aria-label={`编辑点 ${formatVideoTime(intent.startSeconds)}`}
                className={`video-edit-dialog__block${intent.id === activeIntentId ? " is-active" : ""}${range ? " is-range" : " is-point"}`}
                style={{ left: `${left}%`, ...(width === undefined ? {} : { width: `${width}%` }) }}
                onPointerDown={(event) => startTimelineDrag(event, intent, "move")}
                onKeyDown={(event) => {
                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    event.stopPropagation();
                    removeIntent(intent.id);
                  }
                }}
                title={`${formatVideoTime(intent.startSeconds)}${range ? ` - ${formatVideoTime(intent.endSeconds!)}` : ""}`}
              >
                <span className="video-edit-dialog__block-label">{ordered.indexOf(intent) + 1}</span>
                {range ? <button type="button" className="video-edit-dialog__handle is-start" aria-label="调整编辑区块开始时间" onPointerDown={(event) => startTimelineDrag(event, intent, "resize-start")} /> : null}
                <button type="button" className="video-edit-dialog__handle is-end" aria-label="调整编辑区块结束时间" onPointerDown={(event) => startTimelineDrag(event, intent, "resize-end")} />
              </div>
            );
          })}
        </div>
      </div>

      {activeIntent ? (
        <div className="video-edit-dialog__toolbar" aria-label="视频标注工具">
          <div className="video-edit-dialog__tool-group">
            <IconButton label="画笔" size="sm" pressed={tool === "pen"} disabled={busyNow} onClick={() => selectTool("pen")}>
              <PenIcon />
            </IconButton>
            <IconButton label="方框" size="sm" pressed={tool === "rect"} disabled={busyNow} onClick={() => selectTool("rect")}>
              <RectangleIcon />
            </IconButton>
          </div>
          <div className="video-edit-dialog__swatches">
            {VIDEO_EDIT_ALLOWED_COLORS.map((item) => (
              <button
                type="button"
                key={item}
                aria-label={`颜色 ${item}`}
                className={`video-edit-dialog__swatch${color === item ? " is-active" : ""}`}
                style={{ background: item }}
                disabled={busyNow}
                onClick={() => setColor(item)}
              />
            ))}
          </div>
          <div className="video-edit-dialog__widths">
            {VIDEO_EDIT_ALLOWED_STROKE_WIDTHS.map((item) => (
              <button
                type="button"
                key={item}
                aria-label={`线宽 ${item}`}
                className={`video-edit-dialog__width${strokeWidth === item ? " is-active" : ""}`}
                disabled={busyNow}
                onClick={() => setStrokeWidth(item)}
              >
                <i style={{ height: item + 1 }} />
              </button>
            ))}
          </div>
          <div className="video-edit-dialog__history">
            <IconButton label="撤销" size="sm" disabled={busyNow || activeIntent.annotationShapes.length === 0} onClick={undo}>
              <UndoIcon />
            </IconButton>
            <IconButton label="重做" size="sm" disabled={busyNow || (redoStacks[activeIntent.id] ?? []).length === 0} onClick={redo}>
              <RedoIcon />
            </IconButton>
            <Button
              size="sm"
              disabled={busyNow || activeIntent.annotationShapes.length === 0}
              onClick={() => {
                updateActive({ annotationShapes: [] });
                setRedoStacks((current) => ({ ...current, [activeIntent.id]: [] }));
              }}
            >
              清空标记
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
