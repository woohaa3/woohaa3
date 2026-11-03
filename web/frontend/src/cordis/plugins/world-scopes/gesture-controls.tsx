/**
 * 场景区 / 2D 组的可见手势入口（T07 scope gestures）。
 *
 * 电脑用修饰键更快，但 Pad 必须有等价可见入口：本 overlay 提供“跟随 / 搬场景 /
 * 仅调整范围”、两种删除、场景撤销/重做，以及 2D 组的“整理成员 / 框住成员”。
 * 所有写操作仍交给权威场景接口或页面 journal；控件只发请求，不自己计算权限。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  resolveNodeDisplayName,
  worldToCanvasPoint,
  worldToRendererPosition,
  type SceneAreaData,
  type ServerCanvas,
  type WorkflowGroupData
} from "@woohaa3/contracts";
import { Button, SegmentedControl } from "@woohaa3/ui/primitives";
import { SelectInput } from "@woohaa3/ui/forms";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore, type CanvasEditService } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  currentSceneAreaGestures,
  installSceneAreaGestures,
  sceneAreaGestureStore,
  sceneAreaModeStore,
  type SceneAreaDragMode
} from "./gestures.js";
import {
  bindGroupActions,
  createGroupActions,
  readGroupLayout,
  type GroupActionController
} from "./group-actions.js";

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

const sectionTitleStyle: CSSProperties = { fontSize: 12, color: "var(--app-web-text-muted, #849188)" };
const hintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.45, color: "var(--app-web-text-muted, #849188)" };
const rowStyle: CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" };

const modeLabels: Array<{ mode: SceneAreaDragMode; label: string; hint: string }> = [
  { mode: "auto", label: "跟随", hint: "自动：拖动区域边缘只调整范围；区域内空白仍可框选" },
  { mode: "move", label: "搬场景", hint: "搬场景：在区域内任意位置拖动，搬动范围与完整包含的可写模型、区内镜头" },
  { mode: "resize", label: "仅调范围", hint: "在区域内拖动只调整范围，不移动任何模型或镜头" }
];

function GestureStatus() {
  const snapshot = useSyncExternalStore(sceneAreaGestureStore.subscribe, sceneAreaGestureStore.getSnapshot, sceneAreaGestureStore.getSnapshot);
  if (snapshot.phase === "idle") return null;
  const intent = snapshot.intent;
  const label = intent === "resize" ? "仅调整范围"
    : intent === "delete-area" ? "删除场景区"
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

function SceneAreaControls({ area, nodeId, edit }: { area: SceneAreaData; nodeId: string; edit: CanvasEditService }) {
  const mode = useSyncExternalStore(sceneAreaModeStore.subscribe, sceneAreaModeStore.getSnapshot, sceneAreaModeStore.getSnapshot);
  // The scene-area receipt is adopted into the page journal; the panel must show and
  // drive that same global timeline rather than a private scene stack.
  const history = useSyncExternalStore(edit.subscribe, edit.getSnapshot, edit.getSnapshot);
  const [confirmContents, setConfirmContents] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setConfirmContents(false); setError(null); }, [nodeId]);
  const gestures = currentSceneAreaGestures();
  const runDelete = async (withContents: boolean) => {
    const port = currentSceneAreaGestures();
    if (!port) return;
    setBusy(withContents ? "contents" : "area");
    setError(null);
    const result = await port.deleteArea(nodeId, withContents);
    setBusy(null);
    setConfirmContents(false);
    if (!result.ok) setError(result.message);
  };
  const runHistory = async (direction: "undo" | "redo") => {
    setBusy(direction);
    setError(null);
    const result = direction === "undo" ? await edit.undo() : await edit.redo();
    setBusy(null);
    if (!result.ok) setError(result.reason);
  };
  const width = (area.bounds.max.u - area.bounds.min.u).toFixed(2);
  const height = (area.bounds.max.v - area.bounds.min.v).toFixed(2);
  return (
    <div style={panelStyle} data-world-scope-controls="scene-area">
      <div style={rowStyle}>
        <strong>场景区</strong>
        <span style={sectionTitleStyle}>{width} × {height} m</span>
      </div>
      <SegmentedControl
        label="场景区拖动模式"
        value={mode}
        options={modeLabels.map(item => ({ value: item.mode, label: item.label, title: item.hint }))}
        onValueChange={value => sceneAreaModeStore.set(value as SceneAreaDragMode)}
      />
      <div style={hintStyle}>{modeLabels.find(item => item.mode === mode)?.hint}</div>
      <div style={hintStyle}>电脑可按住 Alt 在区域内拖动，临时只调整范围。</div>
      <div role="group" aria-label="画布撤销与重做" style={rowStyle}>
        <Button size="sm" disabled={!history.canUndo || busy !== null} loading={busy === "undo"}
          title={history.undoLabel ? `撤销：${history.undoLabel}` : "没有可撤销的操作"}
          onClick={() => void runHistory("undo")}>撤销{history.undoLabel ? `（${history.undoLabel}）` : ""}</Button>
        <Button size="sm" disabled={!history.canRedo || busy !== null} loading={busy === "redo"}
          title={history.redoLabel ? `重做：${history.redoLabel}` : "没有可重做的操作"}
          onClick={() => void runHistory("redo")}>重做</Button>
      </div>
      <div style={{ ...hintStyle, color: "var(--app-status-danger, #bb5464)" }}>默认删除只移除地面范围，保留模型、镜头与已生成素材。</div>
      <div style={rowStyle}>
        <Button size="sm" disabled={busy !== null || !gestures} loading={busy === "area"}
          onClick={() => void runDelete(false)}>删除区（保留内容）</Button>
        {confirmContents ? (
          <Button size="sm" tone="danger" disabled={busy !== null} loading={busy === "contents"}
            onClick={() => void runDelete(true)}>确认删除范围内可写对象</Button>
        ) : (
          <Button size="sm" tone="danger" disabled={busy !== null}
            onClick={() => setConfirmContents(true)}>连同内容删除…</Button>
        )}
      </div>
      <div style={hintStyle}>连同内容删除只移除完整包含的可写模型与定位点在区内的可写镜头；部分参考、素材和任务保留，仍受运行占用约束。</div>
      {error ? <div style={{ ...hintStyle, color: "var(--app-status-danger, #bb5464)" }}>{error}</div> : null}
    </div>
  );
}

function displayName(canvas: ServerCanvas | null | undefined, nodeId: string): string {
  const node = canvas?.document.nodes.find(item => item.id === nodeId);
  if (!node) return `已移除对象 ${nodeId}`;
  const data = canvas?.nodeData[nodeId];
  return resolveNodeDisplayName({
    type: node.type,
    explicitName: data?.title,
    prompt: data?.prompt
  }).displayName;
}

function GroupControls({ group, nodeId, actions, canvas }: {
  group: WorkflowGroupData;
  nodeId: string;
  actions: GroupActionController | null;
  canvas: ServerCanvas | null | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string>("");
  useEffect(() => { setError(null); setCandidate(""); }, [nodeId]);
  const candidates = useMemo(() => (canvas?.document.nodes ?? []).flatMap(node => {
    if (node.id === nodeId || group.memberNodeIds.includes(node.id)) return [];
    if (node.type === "workflow-group-2d" || node.type === "scene-area") return [];
    if (canvas?.nodeData[node.id]?.sharedWorldInstance !== undefined) return [];
    return [{ value: node.id, label: displayName(canvas, node.id) }];
  }), [canvas, group.memberNodeIds, nodeId]);
  useEffect(() => {
    if (candidate && !candidates.some(option => option.value === candidate)) setCandidate("");
  }, [candidate, candidates]);
  const run = async (kind: "tidy" | "fit" | "add" | "remove", memberId?: string) => {
    if (!actions) return;
    setBusy(kind);
    setError(null);
    const result = kind === "tidy" ? await actions.tidy(nodeId)
      : kind === "fit" ? await actions.fit(nodeId)
        : kind === "add" ? await actions.addMembers(nodeId, candidate ? [candidate] : [])
          : await actions.removeMember(nodeId, memberId ?? "");
    setBusy(null);
    if (!result.ok) setError(result.reason);
    else if (kind === "add") setCandidate("");
  };
  return (
    <div style={panelStyle} data-world-scope-controls="workflow-group-2d">
      <div style={rowStyle}>
        <strong>2D 组</strong>
        <span style={sectionTitleStyle}>成员 {group.memberNodeIds.length}</span>
      </div>
      <div style={hintStyle}>拖动组卡片会连同成员一起移动；成员整理与框定只改卡片布局，不改变模型世界变换或镜头取景。</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
        {group.memberNodeIds.length === 0 ? <li style={hintStyle}>尚未包含成员</li> : null}
        {group.memberNodeIds.map(memberId => (
          <li key={memberId} style={{ ...rowStyle, justifyContent: "space-between" }}>
            <span title={memberId}>{displayName(canvas, memberId)}</span>
            <Button size="sm" tone="ghost" disabled={busy !== null || !actions}
              onClick={() => void run("remove", memberId)}>移除</Button>
          </li>
        ))}
      </ul>
      <div style={{ display: "grid", gap: 6 }}>
        <SelectInput
          label="添加到 2D 组"
          value={candidate}
          options={[{ value: "", label: candidates.length ? "选择画布节点…" : "没有可添加的卡片" }, ...candidates]}
          disabled={busy !== null || !actions || candidates.length === 0}
          onValueChange={setCandidate}
        />
        <Button size="sm" disabled={busy !== null || !actions || !candidate} loading={busy === "add"}
          onClick={() => void run("add")}>添加成员</Button>
      </div>
      <div style={rowStyle}>
        <Button size="sm" disabled={busy !== null || !actions} loading={busy === "tidy"}
          onClick={() => void run("tidy")}>整理成员</Button>
        <Button size="sm" disabled={busy !== null || !actions} loading={busy === "fit"}
          onClick={() => void run("fit")}>框住成员</Button>
      </div>
      <div style={hintStyle}>成员关系可加入统一撤销；场景区与无卡片的共享世界模型不属于 2D 组成员。</div>
      {error ? <div style={{ ...hintStyle, color: "var(--app-status-danger, #bb5464)" }}>{error}</div> : null}
    </div>
  );
}

export function WorldScopeGestureControls({ actions, edit }: { actions: GroupActionController | null; edit: CanvasEditService }) {
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const canvas = useSyncExternalStore(woohaa3CanvasStore.subscribe, () => workingCanvasOf(woohaa3CanvasStore.getState()), () => null);
  const nodeId = selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  const data = nodeId ? canvas?.nodeData[nodeId] : undefined;
  const area = useMemo(() => decodeSceneAreaData(data?.sceneArea), [data?.sceneArea]);
  const group = useMemo(() => decodeWorkflowGroupData(data?.workflowGroup2d), [data?.workflowGroup2d]);
  const layout = useMemo(() => group.ok && nodeId ? readGroupLayout(canvas, nodeId) : null, [canvas, group.ok, nodeId]);
  if (!nodeId) return null;
  if (area.ok) return <SceneAreaControls area={area.value} nodeId={nodeId} edit={edit} />;
  if (group.ok && layout?.ok) return <GroupControls group={group.value} nodeId={nodeId} actions={actions} canvas={canvas} />;
  return null;
}

/**
 * Discoverable move handle for a selected scene area.
 *
 * Scene areas are ground outlines, not cards, so there is no permanent card title to
 * grab. This projecting chip gives mouse and Pad users the same default “搬场景” entry
 * without switching modes, while interior blank pointerdowns keep the existing marquee.
 */
export function SceneAreaDragHandle({ ctx }: { ctx: Context }) {
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const canvas = useSyncExternalStore(woohaa3CanvasStore.subscribe, () => workingCanvasOf(woohaa3CanvasStore.getState()), () => null);
  const [, setTick] = useState(0);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodeId = selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  const data = nodeId ? canvas?.nodeData[nodeId] : undefined;
  const area = useMemo(() => decodeSceneAreaData(data?.sceneArea), [data?.sceneArea]);
  useEffect(() => {
    const controller = ctx.canvasRuntime.controller();
    const unsubscribe = controller?.subscribeViewport?.(() => setTick(value => value + 1));
    // Pan/zoom commits may not notify every intermediate frame; keep the chip pinned
    // without subscribing to or reading the canvas document on every pointer move.
    const id = setInterval(() => setTick(value => value + 1), 400);
    return () => {
      unsubscribe?.();
      clearInterval(id);
    };
  }, [ctx]);
  useEffect(() => { setError(null); }, [nodeId]);
  if (!nodeId || !area.ok) return null;
  const controller = ctx.canvasRuntime.controller();
  if (!controller) return null;
  const { bounds } = area.value;
  const corners = [
    { u: bounds.min.u, v: bounds.min.v },
    { u: bounds.min.u, v: bounds.max.v },
    { u: bounds.max.u, v: bounds.min.v },
    { u: bounds.max.u, v: bounds.max.v }
  ].map(corner => {
    const renderer = worldToRendererPosition({ u: corner.u, v: corner.v, h: 0 });
    const point = worldToCanvasPoint([renderer[0], renderer[1], renderer[2]]);
    const client = controller.worldToClient({ x: point.x, y: point.y });
    return { x: client.x, y: client.y };
  });
  const top = corners.reduce((best, corner) => (corner.y < best.y ? corner : best), corners[0]!);
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const port = currentSceneAreaGestures();
    if (!port) return;
    const started = port.begin({ point: { x: event.clientX, y: event.clientY }, areaNodeId: nodeId, card: true, mode: "move" });
    if (!started) return;
    dragRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    currentSceneAreaGestures()?.update({ x: event.clientX, y: event.clientY });
    event.preventDefault();
  };
  const finish = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.preventDefault();
    const result = await currentSceneAreaGestures()?.end();
    if (result && !result.ok) setError(result.message);
  };
  return (
    <button
      type="button"
      aria-label="搬场景"
      title="拖动搬动场景区及其完整包含的模型与区内镜头"
      data-world-scope-drag-handle="scene-area"
      style={{
        position: "fixed",
        left: top.x,
        top: top.y - 34,
        transform: "translateX(-50%)",
        pointerEvents: "auto",
        cursor: "grab",
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid var(--app-web-border-strong, #7f9389)",
        background: "var(--app-web-panel, #fff)",
        color: "var(--app-web-text-primary, #30443a)",
        fontFamily: "\"Noto Sans SC\", \"Noto Sans\", system-ui, sans-serif",
        fontSize: 12,
        lineHeight: 1.2,
        boxShadow: "0 4px 12px var(--app-web-shadow, #2d423933)"
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={event => { void finish(event); }}
      onPointerCancel={event => { dragRef.current = null; currentSceneAreaGestures()?.cancel(); event.preventDefault(); }}
    >
      搬场景{error ? ` · ${error}` : ""}
    </button>
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
        <SceneAreaDragHandle ctx={ctx} />
        <div style={{ position: "absolute", top: 72, left: "50%", transform: "translateX(-50%)", pointerEvents: "auto" }}>
          <WorldScopeGestureControls actions={actions} edit={ctx.canvasEdit} />
        </div>
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
