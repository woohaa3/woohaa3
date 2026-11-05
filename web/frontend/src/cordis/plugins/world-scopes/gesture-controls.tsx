/**
 * 导演区手势的可见状态入口（T07 scope gestures）。
 *
 * 画布上只保留手势状态提示（提交失败/冲突时出现）；拖动、边缘调整与框选都走画布手势，
 * 撤销/重做使用页面 journal 与全局快捷键。2D 组不弹成员管理面板。
 * 所有写操作仍交给权威场景接口或页面 journal；控件只发请求，不自己计算权限。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useSyncExternalStore, type CSSProperties } from "react";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  installSceneAreaGestures,
  sceneAreaGestureStore
} from "./gestures.js";
import { bindGroupActions, createGroupActions } from "./group-actions.js";

export const WORLD_SCOPE_GESTURE_CONTROLS_PLUGIN_ID = "world-scope-gesture-controls";

const panelStyle: CSSProperties = {
  width: 320,
  padding: 12,
  borderRadius: 12,
  border: "1px solid var(--app-web-border, #e2e8e4)",
  background: "var(--app-web-panel, #fff)",
  color: "var(--app-web-text-primary, #30443a)",
  boxShadow: "0 14px 34px var(--app-web-shadow, #2d423933)",
  fontFamily: "\"Noto Sans SC\", \"Noto Sans\", system-ui, sans-serif",
  fontSize: 13,
  lineHeight: 1.4,
  display: "grid",
  gap: 8
};

const hintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.45, color: "var(--app-web-text-muted, #849188)" };

function GestureStatus() {
  const snapshot = useSyncExternalStore(sceneAreaGestureStore.subscribe, sceneAreaGestureStore.getSnapshot, sceneAreaGestureStore.getSnapshot);
  if (snapshot.phase === "idle") return null;
  const intent = snapshot.intent;
  const label = intent === "resize" ? "仅调整范围"
    : intent === "delete-area" ? "删除导演区"
      : intent === "delete-area-with-contents" ? "连同内容删除"
        : intent === "move" ? "搬场景" : "场景操作";
  const delta = snapshot.delta;
  const reading = delta ? `Δu ${delta.u.toFixed(2)} m · Δv ${delta.v.toFixed(2)} m` : "";
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...panelStyle,
        width: "auto",
        maxWidth: 460,
        padding: "8px 14px",
        borderRadius: 999,
        background: "var(--app-web-panel, #fff)",
        justifyItems: "center",
        textAlign: "center"
      }}
    >
      <strong style={{ fontSize: 13 }}>{label}</strong>
      {snapshot.message ? <span style={{ ...hintStyle, color: "var(--app-status-danger, #bb5464)" }}>{snapshot.message}</span>
        : reading ? <span style={hintStyle}>{reading}</span> : null}
      {snapshot.conflicts.map(conflict => (
        <span key={`${conflict.target.kind}:${conflict.target.kind === "instance" ? conflict.target.instanceId : conflict.target.cameraId}:${conflict.runId}:${conflict.epoch}`} style={{ ...hintStyle, color: "var(--app-status-danger, #bb5464)" }}>
          {conflict.target.kind === "instance" ? `模型 ${conflict.target.instanceId}` : `镜头 ${conflict.target.cameraId}`}
          {" · "}{conflict.runId} / {conflict.epoch}
        </span>
      ))}
    </div>
  );
}

export function installWorldScopeGestureControls(ctx: Context, canvasId: string | undefined): () => void {
  const disposeGestures = installSceneAreaGestures(ctx, canvasId);
  const actions = createGroupActions({
    getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()),
    writable: () => ctx.canvasSession.isWritable(),
    edit: ctx.canvasEdit
  });
  const disposeGroups = bindGroupActions(actions);
  const removeSlot = ctx.slots.register("canvas.overlay", {
    id: WORLD_SCOPE_GESTURE_CONTROLS_PLUGIN_ID,
    owner: WORLD_SCOPE_GESTURE_CONTROLS_PLUGIN_ID,
    priority: 26,
    render: () => (
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)", pointerEvents: "none" }}>
          <GestureStatus />
        </div>
      </div>
    )
  });
  return () => {
    removeSlot();
    disposeGroups();
    disposeGestures();
  };
}

export function worldScopeGestureControlsPlugin(canvasId: string | undefined): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const dispose = installWorldScopeGestureControls(ctx, canvasId);
    ctx.effect(() => dispose, "world-scope-gesture-controls");
  }, {
    name: WORLD_SCOPE_GESTURE_CONTROLS_PLUGIN_ID,
    inject: ["slots", "canvasRuntime", "canvasRemote", "canvasSession", "canvasEdit"]
  });
}
