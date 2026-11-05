import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createHighEntropyId, worldCameraUiSettingsOf } from "@woohaa3/contracts";
import { Button, IconButton, DialogSurfaceRoot } from "@woohaa3/ui/primitives";
import { CheckIcon, CloseIcon, RotateIcon, MoveIcon, ElevationIcon, OrbitIcon, LocateIcon, RefreshIcon, EyeIcon, LayoutGridIcon, GameIcon, BackIcon } from "@woohaa3/ui/icons";
import { Dialog } from "@woohaa3/ui/dialogs";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { readWorldCamera, submitWorldCameraSave, worldCameraUiFailureText } from "../../services/world-camera-ui.js";
import { worldCameraEditorStore, type WorldCameraEditSession } from "../../services/world-camera-editor-store.js";
import { adoptCameraTimeline } from "./camera-timeline.js";
import { attachCameraFlightInput, captureCameraPointer, releaseCameraPointer } from "./flight-input.js";
import { defaultOrbitCenter, type CompositionTool } from "./composition-motion.js";
import { CompositionViewport } from "./composition-viewport.js";
import { CameraParameters } from "./camera-parameters.js";
import "./camera-editor.css";

export function CameraEditor({ ctx, session, writable }: { ctx: Context; session: WorldCameraEditSession; writable: boolean }) {
  const [mode, setMode] = useState<"compose" | "fly">("compose");
  const [tool, setTool] = useState<CompositionTool>("turn");
  const [center, setCenter] = useState(() => defaultOrbitCenter(session.draft));
  const [selectingCenter, setSelectingCenter] = useState(false);
  const [more, setMore] = useState(false);
  const [flightPending, setFlightPending] = useState(false);
  const escapeAfterFlight = useRef(0);
  const flightRequest = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedWarning, setSavedWarning] = useState(false);
  const receipt = useRef<{ settingsVersion: string; revision: number } | null>(null);
  const canvas = useSyncExternalStore(woohaa3CanvasStore.subscribe, () => workingCanvasOf(woohaa3CanvasStore.getState()), () => null);
  const current = canvas?.id === session.canvasId ? readWorldCamera(canvas, session.nodeId) : null;
  const conflict = !!current && current.settingsVersion !== session.source.settingsVersion && !receipt.current;
  const unavailable = !writable || !current || conflict;
  const live = useRef({ unavailable });
  live.current = { unavailable };

  function exit() {
    const state = worldCameraEditorStore.getSnapshot();
    if (!state || state.phase !== "editing") return;
    if (worldCameraEditorStore.changed()) worldCameraEditorStore.patch({ phase: "confirm" });
    else worldCameraEditorStore.close();
    releaseCameraPointer();
  }

  const endFlight = () => {
    flightRequest.current++;
    escapeAfterFlight.current = performance.now() + 250;
    setMode("compose"); setFlightPending(false);
  };
  async function startFlight() {
    setMore(false); setSelectingCenter(false); setNotice(null); setFlightPending(true);
    const request = ++flightRequest.current;
    const captured = await captureCameraPointer();
    const current = worldCameraEditorStore.getSnapshot();
    if (request !== flightRequest.current || current?.source !== session.source || current.phase !== "editing") {
      if (captured) releaseCameraPointer();
      return;
    }
    setFlightPending(false);
    if (captured) setMode("fly");
    else setNotice("未能启用自由移动，请重试；也可以用构图工具调整机位。");
  }
  useEffect(() => {
    ctx.canvasRuntime.cancelTransientGesture();
    if (mode !== "fly" || session.phase !== "editing") return;
    return attachCameraFlightInput({ session, onExit: endFlight, onLockChange: () => {} });
  }, [ctx, session.source, session.phase, mode]);
  useEffect(() => () => { flightRequest.current++; releaseCameraPointer(); }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || mode === "fly" || session.phase !== "editing") return;
      if (event.repeat || performance.now() < escapeAfterFlight.current) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (more) setMore(false);
      else if (selectingCenter) setSelectingCenter(false);
      else exit();
    };
    // Menus and number fields consume Escape before the outer editor does.
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mode, more, selectingCenter, session.phase]);

  useEffect(() => {
    if (!unavailable || session.phase !== "editing") return;
    worldCameraEditorStore.patch({ phase: "confirm", error: conflict
      ? "镜头已被其他操作修改。当前调整已保留，请放弃后重新进入编辑。"
      : "镜头已不可编辑。可以放弃本次调整并退出。" });
    releaseCameraPointer();
  }, [unavailable, conflict, session.phase]);

  useEffect(() => {
    const saved = receipt.current;
    if (saved && !savedWarning && canvas?.id === session.canvasId && canvas.revision >= saved.revision
      && current?.settingsVersion === saved.settingsVersion) {
      worldCameraEditorStore.close();
    }
  }, [canvas, current?.settingsVersion, savedWarning]);

  async function save() {
    const state = worldCameraEditorStore.getSnapshot();
    if (!state || state.phase === "saving" || live.current.unavailable || !ctx.canvasSession.isWritable()) return;
    if (!worldCameraEditorStore.changed()) { worldCameraEditorStore.close(); return; }
    setMore(false); releaseCameraPointer();
    worldCameraEditorStore.patch({ phase: "saving", error: null });
    const operationId = createHighEntropyId("world-camera-edit");
    const result = await submitWorldCameraSave(ctx.canvasRemote, {
      canvasId: state.canvasId, cameraId: state.source.cameraId,
      expectedSettingsVersion: state.source.settingsVersion,
      settings: worldCameraUiSettingsOf(state.draft), operationId
    });
    // Record a successful durable write even if this editor was unmounted meanwhile.
    if (result.ok) {
      const adopted = adoptCameraTimeline({ ctx, canvasId: state.canvasId, cameraId: state.source.cameraId,
        before: state.source, after: result.camera, label: "编辑镜头", operationId,
        version: { current: result.settingsVersion } });
      if (worldCameraEditorStore.getSnapshot()?.source !== state.source) return;
      receipt.current = { settingsVersion: result.settingsVersion, revision: result.revision };
      if (!adopted.ok) {
        setSavedWarning(true);
        worldCameraEditorStore.patch({ phase: "confirm", error: "镜头已保存，但未能加入撤销历史。" });
        return;
      }
      const latest = workingCanvasOf(woohaa3CanvasStore.getState());
      if (latest?.id === state.canvasId && latest.revision >= result.revision
        && readWorldCamera(latest, state.nodeId)?.settingsVersion === result.settingsVersion) {
        worldCameraEditorStore.close();
      } else setNotice("镜头已保存，正在等待画布同步…");
    } else if (worldCameraEditorStore.getSnapshot()?.source === state.source) {
      worldCameraEditorStore.patch({ phase: "confirm", error: worldCameraUiFailureText(result) });
    }
  }

  const settings = worldCameraUiSettingsOf(session.draft);
  const editing = session.phase === "editing" && !unavailable;
  const resume = () => {
    if (unavailable) return;
    setMode("compose");
    worldCameraEditorStore.patch({ phase: "editing", error: null });
  };
  const title = canvas?.nodeData[session.nodeId]?.title;
  const toolHints = { turn: "拖拽转向", pan: "拖拽平移", dolly: "上下拖拽推拉", orbit: "拖拽绕中心环绕" };
  return (
    <div className="world-camera-editor" data-camera-editor="true" data-mode={mode}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (more && !(event.target as Element).closest("[data-camera-popover], [data-camera-more-trigger]")) setMore(false);
      }}>
      <CompositionViewport ctx={ctx} session={session} disabled={!editing || mode === "fly" || flightPending}
        tool={tool} center={center} selectingCenter={selectingCenter}
        onCenter={value => { setCenter(value); setSelectingCenter(false); setTool("orbit"); }} onNotice={setNotice} />
      <header className="world-camera-editor__header">
        <strong>{typeof title === "string" && title.trim() ? title : "镜头"}</strong>
        <span>{worldCameraEditorStore.changed() ? "未保存" : "调整中"} · 透视</span>
        <div className="world-camera-editor__header-actions">
          <IconButton label="保存并退出" title="保存并退出" size="sm" tone="primary" disabled={!editing || mode === "fly" || flightPending} onClick={() => void save()}><CheckIcon /></IconButton>
          <IconButton label="关闭" title="关闭" size="sm" disabled={!editing || mode === "fly" || flightPending} onClick={exit}><CloseIcon /></IconButton>
        </div>
      </header>
      <footer className="world-camera-editor__footer">
        {mode === "fly" ? <div className="world-camera-editor__tools world-camera-editor__flight-summary">
          <span>自由移动 · FoV {Math.round(settings.projection.kind === "perspective" ? settings.projection.verticalFovRadians * 180 / Math.PI : 60)}° · {settings.aspect.width}:{settings.aspect.height}</span>
          <Button size="sm" icon={<BackIcon />} onClick={() => { releaseCameraPointer(); endFlight(); }}>结束自由移动</Button>
        </div> : <fieldset className="world-camera-editor__dock" disabled={!editing || flightPending}>
          <div className="world-camera-editor__tool-row">
            <div className="world-camera-editor__tool-group">
              {([["turn", "转向", RotateIcon], ["pan", "平移", MoveIcon], ["dolly", "推拉", ElevationIcon], ["orbit", "环绕", OrbitIcon]] as const).map(([id, label, Icon]) =>
                <IconButton key={id} label={label} title={label} size="sm" pressed={tool === id} tone={tool === id ? "primary" : "ghost"} onClick={() => { setTool(id); setSelectingCenter(false); setNotice(null); }}><Icon /></IconButton>)}
            </div>
            {tool === "orbit" ? <>
              <IconButton label={selectingCenter ? "取消选点" : "选择环绕中心"} title={selectingCenter ? "取消选点" : "选择环绕中心"} size="sm" pressed={selectingCenter} onClick={() => { setSelectingCenter(value => !value); setNotice(null); }}><LocateIcon /></IconButton>
              <IconButton label="重置中心" title="重置中心" size="sm" onClick={() => { setCenter(defaultOrbitCenter(session.draft)); setSelectingCenter(false); setNotice("环绕中心已重置到视线前方"); }}><RefreshIcon /></IconButton>
            </> : null}
            <IconButton label={session.showHelpers ? "查看输出" : "显示辅助线"} title={session.showHelpers ? "查看输出" : "显示辅助线"} size="sm" pressed={!session.showHelpers} onClick={() => worldCameraEditorStore.patch({ showHelpers: !session.showHelpers })}>{session.showHelpers ? <EyeIcon /> : <LayoutGridIcon />}</IconButton>
          </div>
          <div className="world-camera-editor__parameter-row">
            <CameraParameters camera={session.draft} more={more} onMore={() => setMore(value => !value)} />
            <span className="world-camera-editor__separator" />
            <Button size="sm" icon={<GameIcon />} loading={flightPending} onClick={() => void startFlight()}>自由移动</Button>
          </div>
        </fieldset>}
        <div className="world-camera-editor__guide">
          {mode === "fly" ? <>
            <span><kbd>W</kbd> / <kbd>S</kbd> 前进 / 后退</span>
            <span><kbd>A</kbd> / <kbd>D</kbd> 左移 / 右移</span>
            <span><kbd>Z</kbd> / <kbd>X</kbd> 上升 / 下降</span>
            <span>鼠标转向</span><span><kbd>Shift</kbd> 加速</span><span><kbd>Esc</kbd> 返回构图</span>
          </> : <span>{notice ?? (selectingCenter ? "点击模型表面设置环绕中心，镜头不会移动" : `${toolHints[tool]} · Shift + 拖拽平移 · 滚轮推拉 · Esc 退出编辑`)}</span>}
        </div>
      </footer>
      <DialogSurfaceRoot open={session.phase !== "editing"} modal dismissible={false} busy={session.phase === "saving"} onOpenChange={() => {}}>
        <Dialog.Content size="sm" ariaLabel="保存镜头调整" busy={session.phase === "saving"}>
          <Dialog.Header><Dialog.Title>保存镜头调整？</Dialog.Title>
            <Dialog.Description>保存后将更新镜头构图；不保存会恢复进入前的镜头配置。</Dialog.Description>
          </Dialog.Header>
          {session.error || notice ? <Dialog.Body><p className="world-camera-editor__message">{session.error ?? notice}</p></Dialog.Body> : null}
          <Dialog.Footer>
            {savedWarning ? <Button onClick={() => worldCameraEditorStore.close()}>关闭</Button> : <>
              <Button tone="ghost" disabled={session.phase === "saving"} onClick={() => worldCameraEditorStore.close()}>放弃修改</Button>
              <Button disabled={unavailable || session.phase === "saving"} onClick={resume}>继续调整</Button>
              <Button tone="primary" disabled={unavailable || session.phase === "saving"} onClick={() => void save()}>{session.phase === "saving" ? "保存中…" : "保存并退出"}</Button>
            </>}
          </Dialog.Footer>
        </Dialog.Content>
      </DialogSurfaceRoot>
    </div>
  );
}
