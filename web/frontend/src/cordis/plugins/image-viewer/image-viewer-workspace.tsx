/**
 * 宿主默认图片聚焦查看器（工作区呈现）
 * （change: default-image-focus-viewer）。
 *
 * 只在没有其他图片编辑器扩展声明 `canvas.focus-workspace`（kind=image）时挂载：提供原地
 * 取景查看（缩放/平移/适应窗口/100%），真实画面仍由 Bevy 主画布按图片聚焦投影显示。
 * 不加载编辑内核、不创建作品版本。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useService } from "../../react.js";
import { classifyWheelEvent, INITIAL_WHEEL_SOURCE } from "../canvas-shell/input/wheel-gesture.js";
import { FocusHeader } from "../../focus/header.js";
import { useFocusLayout } from "../../focus/workspace.js";
import { Button } from "@woohaa3/ui/primitives";
import type { ImageViewerSession } from "./session.js";
import "./image-viewer.css";

const VIEWER_HELP = "滚轮缩放；拖动平移；Esc 返回画布";
const VIEWER_HINT = "滚轮缩放 / 拖动平移 / Esc 返回";

export function ImageViewerWorkspace({ getSession, nodeId }: {
  getSession: () => ImageViewerSession | null;
  nodeId: string;
}) {
  const session = getSession();
  // 会话实例即订阅身份：进入另一个节点会换实例，必须重订阅（否则本地取景/加载状态不再回流）。
  const subscribeSession = useCallback(
    (listener: () => void) => getSession()?.subscribe(listener) ?? (() => undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只需要在换会话时重建订阅
    [session]
  );
  const revision = useSyncExternalStore(
    subscribeSession,
    () => getSession()?.revisionState() ?? 0,
    () => 0
  );
  void revision;
  const canvasNavigation = useService("canvasNavigation");
  const presentation = useSyncExternalStore(canvasNavigation.subscribe, canvasNavigation.getSnapshot, canvasNavigation.getSnapshot);
  const historyOpen = presentation.panel?.type === "node-history" && presentation.panel.nodeId === nodeId;
  const runtime = useService("canvasRuntime");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const wheelSource = useRef(INITIAL_WHEEL_SOURCE);
  // 底部控件就是公共 footer 本身：不再追加 `player` 占位。
  // footer 恒为 FOCUS_FOOTER_BASE(44)，控件占满它（见 image-viewer.css）；再加 player 会多留一条空带。
  useFocusLayout(useMemo(() => ({ panel: historyOpen }), [historyOpen]));

  // 历史 drawer / 窗口尺寸改变 → 内容矩形改变 → 重新适应窗口（进入动画中重排终点）。
  // 挂载时先对齐一次：插件建立会话可能早于公共布局写入 contentRect，那时按表面尺寸算出的
  // 适应值会把底部控制条与顶部栏的区域也算进画面（表现为图片顶到屏幕底边、控制条压住画面）。
  useEffect(() => {
    if (!session) return undefined;
    session.setRect();
    return runtime.subscribeFocusContentRect(() => session.setRect());
  }, [session, runtime]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !session) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = stage.getBoundingClientRect();
      const classified = classifyWheelEvent(
        {
          deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          clientX: event.clientX - bounds.left - bounds.width / 2,
          clientY: event.clientY - bounds.top - bounds.height / 2,
          timeStamp: event.timeStamp
        },
        wheelSource.current
      );
      wheelSource.current = classified.control;
      const gesture = classified.wheel;
      if (!gesture) return;
      if (gesture.kind === "pan") session.panBy(-gesture.dx, -gesture.dy);
      else session.zoomAround(gesture.factor);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [session]);

  if (!session) return null;
  const state = session.state();
  const meta = state.width > 0 ? `${Math.round(state.width)}×${Math.round(state.height)} · ${Math.round(state.viewport.zoom * 100)}%` : "";
  return (
    <>
      <FocusHeader fallbackTitle="图片" help={VIEWER_HELP} hint={VIEWER_HINT} />
      <div className="image-viewer" data-image-viewer="true">
        <div
          ref={stageRef}
          className="image-viewer__stage"
          data-image-viewer-stage="true"
          aria-label="图片画面"
          tabIndex={0}
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
          {state.loading ? (
            <span className="image-viewer__loading" role="status">
              <span className="image-viewer__loading-ring" aria-hidden="true" />
              图片加载中…
            </span>
          ) : null}
        </div>
        <div className="image-viewer__controls" data-focus-canvas-chrome="true">
          <span className="image-viewer__meta">{meta}</span>
          <span className="image-viewer__buttons">
            <Button size="sm" onClick={() => session.zoomAround(1 / 1.2)} aria-label="缩小">−</Button>
            <Button size="sm" onClick={() => session.fitWindow()}>适应窗口</Button>
            <Button size="sm" onClick={() => session.actualSize()}>100%</Button>
            <Button size="sm" onClick={() => session.zoomAround(1.2)} aria-label="放大">+</Button>
          </span>
        </div>
        {state.error ? <div className="image-viewer__error" role="alert">{state.error}</div> : null}
      </div>
    </>
  );
}
