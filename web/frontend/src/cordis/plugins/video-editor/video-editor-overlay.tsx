/**
 * 视频聚焦工作区 overlay（video-editor 完整工作区 renderer）
 * （change: 2026-10-10-add-video-node-focus-workspace；
 *   change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3/D4）。
 *
 * 经 `canvas.focus-workspace`（kind=video）挂载为完整界面：公共顶部栏（返回/历史/标题）、
 * 中央内容手势面、底部播放/截帧控制、右侧截帧检查器（与历史互斥）。截帧工具开关是本 editor
 * 的局部状态，经 `useFocusLayout` 以布局快照上报，公共层不拥有 toolsOpen。
 *
 * 真实解码画面由 Bevy 主画布显示（同一 Camera2d），overlay 不复制背景、不创建第二个 renderer。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useService } from "../../react.js";
import { classifyWheelEvent, INITIAL_WHEEL_SOURCE } from "../canvas-shell/input/wheel-gesture.js";
import {
  CaptureButtons,
  CaptureFooterActions,
  CaptureFrameList,
  CapturePlaybackControls,
  useCaptureSession,
  type CaptureSession
} from "../video-capture/capture-shell.js";
import type { CapturedFrameEntry, FrameAddReceipt } from "../video-capture/types.js";
import type { VideoFocusSession } from "./session.js";
import type { VideoFocusTarget } from "./targets.js";
import { Button } from "../../../shared/ui/Button.js";
import { FocusHeader } from "../../focus/header.js";
import { useFocusLayout } from "../../focus/workspace.js";
import "./video-editor.css";

const VIDEO_HELP = "空格播放/暂停；拖动进度条定位；滚轮缩放/平移";
const VIDEO_HINT = "空格播放 / 滚轮缩放 / 拖动平移";
/** 播放器占位高度（窄屏三行控制更高）。 */
const playerHeight = (width: number): number => (width < 480 ? 160 : 96);

export function VideoEditorWorkspace({
  getSession,
  getTarget,
  writable,
  onAddFrames
}: {
  getSession: () => VideoFocusSession | null;
  getTarget: () => VideoFocusTarget | null;
  writable: boolean;
  onAddFrames: (input: {
    instanceId: string;
    targetNodeId: string;
    frames: readonly CapturedFrameEntry[];
    signal?: AbortSignal;
  }) => Promise<readonly FrameAddReceipt[]>;
}) {
  // 截帧工具开关：editor 局部状态，唯一 owner 在此；header 按钮与布局配置共用同一状态。
  const [toolsOpen, setToolsOpen] = useState(true);
  const canvasNavigation = useService("canvasNavigation");
  const navigation = useSyncExternalStore(canvasNavigation.subscribe, canvasNavigation.getSnapshot, canvasNavigation.getSnapshot);
  const historyOpen = navigation.mode.type === "node-focus"
    && navigation.panel?.type === "node-history" && navigation.panel.nodeId === navigation.mode.nodeId;
  return (
    <>
      <FocusHeader
        fallbackTitle="视频"
        help={VIDEO_HELP}
        hint={VIDEO_HINT}
        actions={
          <Button size="sm" aria-pressed={toolsOpen} onClick={() => {
            if (historyOpen) void canvasNavigation.requestCloseNodeHistory();
            else setToolsOpen((value) => !value);
          }}>截帧工具</Button>
        }
      />
      <VideoEditorOverlay
        getSession={getSession}
        getTarget={getTarget}
        writable={writable}
        toolsOpen={toolsOpen}
        onAddFrames={onAddFrames}
      />
    </>
  );
}

export function VideoEditorOverlay({
  getSession,
  getTarget,
  writable,
  toolsOpen,
  onAddFrames
}: {
  getSession: () => VideoFocusSession | null;
  getTarget: () => VideoFocusTarget | null;
  writable: boolean;
  toolsOpen: boolean;
  onAddFrames: (input: {
    instanceId: string;
    targetNodeId: string;
    frames: readonly CapturedFrameEntry[];
    signal?: AbortSignal;
  }) => Promise<readonly FrameAddReceipt[]>;
}) {
  const session = getSession();
  const revision = useSyncExternalStore(
    (listener) => session?.subscribe(listener) ?? (() => undefined),
    () => session?.revisionState() ?? 0,
    () => 0
  );
  void revision;
  const canvasNavigation = useService("canvasNavigation");
  const presentation = useSyncExternalStore(canvasNavigation.subscribe, canvasNavigation.getSnapshot, canvasNavigation.getSnapshot);
  const historyOpen = presentation.panel?.type === "node-history" && presentation.panel.nodeId === session?.nodeId;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const wheelSource = useRef(INITIAL_WHEEL_SOURCE);
  // 布局配置：播放器占位的窄屏策略由公共几何统一处理；检查面板由本 editor 的 toolsOpen 控制。
  useFocusLayout(useMemo(() => ({ player: playerHeight, panel: toolsOpen }), [toolsOpen]));

  const source = useMemo(
    () =>
      session
        ? {
            state: () => session.state(),
            subscribe: session.subscribe,
            play: () => session.play(),
            pause: () => session.pause(),
            seek: (time: number) => session.seek(time),
            setMuted: (muted: boolean) => session.setMuted(muted),
            capture: () => session.capture()
          }
        : null,
    [session]
  );
  const capture = useCaptureSession({
    source,
    instanceId: session ? `video-editor-${session.nodeId}` : "video-editor",
    targetNodeId: session?.nodeId ?? "",
    onAddFrames
  });
  const busyNow = capture.busyNow;

  // 内容区滚轮缩放/平移；不驱动普通画布。Space 播放/暂停由画布键盘路由（canvas-shell）
  // 与聚焦 stage 的 React onKeyDown 处理，避免插件新增 document 级监听（UI 审计）。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = stage.getBoundingClientRect();
      const classified = classifyWheelEvent(
        { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, clientX: event.clientX - bounds.left, clientY: event.clientY - bounds.top, timeStamp: event.timeStamp },
        wheelSource.current
      );
      wheelSource.current = classified.control;
      const gesture = classified.wheel;
      if (!gesture) return;
      const target = getSession();
      if (!target) return;
      if (gesture.kind === "pan") target.panBy(-gesture.dx, -gesture.dy);
      else target.zoomAround(gesture.factor, { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
    };
  }, [getSession, writable]);

  if (!session) return null;
  const target = getTarget();
  const history = session.isHistory();
  const readOnly = !writable || history;
  const state = capture.videoState;
  const meta = `${Math.round(state.width)}×${Math.round(state.height)} · ${Math.round(session.viewportState().zoom * 100)}%`;

  return (
    <div className="video-focus-workspace" data-video-focus-workspace="true" data-video-focus-history={history ? "true" : undefined}>
      <div
        ref={stageRef}
        className="video-focus-workspace__stage"
        data-video-focus-stage="true"
        aria-label="视频画面"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.code !== "Space") return;
          event.preventDefault();
          void capture.togglePlayback();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0 && event.button !== 1) return;
          panRef.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!panRef.current) return;
          const dx = event.clientX - panRef.current.x;
          const dy = event.clientY - panRef.current.y;
          panRef.current = { x: event.clientX, y: event.clientY };
          void dx; void dy;
          // 拖动平移：CSS px 直接映射到取景平移。
          session.panBy(dx, dy);
        }}
        onPointerUp={(event) => {
          panRef.current = null;
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
        }}
        onPointerCancel={() => { panRef.current = null; }}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {session.state().loading ? (
          <span className="video-focus-workspace__loading" role="status">
            <span className="video-focus-workspace__loading-ring" aria-hidden="true" />
            视频加载中…
          </span>
        ) : null}
      </div>

      <div className="video-focus-workspace__player" data-focus-canvas-chrome="true">
        <div className="video-focus-workspace__playback"><CapturePlaybackControls session={capture} /></div>
        <span className="video-focus-workspace__controls">
          <Button size="sm" onClick={() => session.zoomAround(1 / 1.2, { x: 0, y: 0 })} aria-label="缩小">−</Button>
          <Button size="sm" onClick={() => session.fitWindow()}>适应窗口</Button>
          <Button size="sm" onClick={() => session.zoomAround(1.2, { x: 0, y: 0 })} aria-label="放大">+</Button>
        </span>
        <CaptureButtons session={capture} />
      </div>

      {!historyOpen ? (
        <div className="video-focus-workspace__inspector" data-focus-canvas-chrome="true">
          {readOnly ? <span className="video-focus-workspace__readonly" role="status">{history ? "历史版本预览（只读）" : "只读会话：可本地截取，不能添加"}</span> : null}
          <CaptureFrameList session={capture} />
          <div className="video-focus-workspace__actions">
            <CaptureFooterActions session={capture} />
          </div>
        </div>
      ) : null}

      {capture.error ? <div className="video-focus-workspace__error" role="alert">{capture.error}</div> : null}
      <span className="video-focus-workspace__meta" data-focus-canvas-chrome="true">{meta}</span>
      {busyNow ? <span className="video-focus-workspace__busy" role="status">处理中…</span> : null}
      {target ? null : null}
    </div>
  );
}

/** 保留类型导出，避免未使用告警。 */
export type VideoEditorCaptureSession = CaptureSession;
