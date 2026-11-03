import type { Context, Plugin } from "@deepseek-ai/cordis";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createHighEntropyId, type ServerCanvas, type WorldCameraData, type WorldCameraHistoryEntry } from "@woohaa3/contracts";
import { Button, IconButton, SegmentedControl } from "@woohaa3/ui/primitives";
import { SelectInput, TextInput } from "@woohaa3/ui/forms";
import { ClapperboardIcon, CloseIcon, RefreshIcon, UnlinkIcon } from "@woohaa3/ui/icons";
import {
  WORLD_CAMERA_ASPECT_PRESETS,
  worldCameraAspectPresetId,
  worldCameraBindingOptions,
  worldCameraBoundTarget,
  worldCameraFramingControl,
  worldCameraSettingsEqual,
  worldCameraUiSettingsOf,
  withWorldCameraAspect,
  withWorldCameraBinding,
  withWorldCameraCaptureMode,
  withWorldCameraFraming,
  withWorldCameraProjectionKind,
  type WorldCameraUiSettings
} from "@woohaa3/contracts";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  awaitWorldCameraCanonical,
  loadWorldCameraHistory,
  readWorldCamera,
  submitWorldCameraRestore,
  submitWorldCameraSave,
  worldCameraUiFailureText,
  type WorldCameraUiFailure
} from "../../services/world-camera-ui.js";
import "./world-cameras.css";

export const WORLD_CAMERAS_PLUGIN_ID = "world-cameras";

type CameraPanelProps = {
  ctx: Context;
  canvas: ServerCanvas;
  canvasId: string;
  nodeId: string;
  camera: WorldCameraData;
  writable: boolean;
};

type HistoryState = {
  loading: boolean;
  entries: WorldCameraHistoryEntry[];
  error: WorldCameraUiFailure | null;
};

function projectionLabel(settings: WorldCameraUiSettings): string {
  return settings.projection.kind === "isometric" ? "等距" : "透视";
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}

/**
 * Camera settings have no forward/inverse receipt of their own; the authoritative
 * inverse is another `world-camera-save`. Only a verified save outcome updates the
 * shared version chain. A conflict, cancellation or uncertain receipt returns
 * `ok:false`, so the page journal keeps its cursor in place.
 */
export function adoptCameraTimeline(input: {
  ctx: Context;
  canvasId: string;
  cameraId: string;
  before: WorldCameraData;
  after: WorldCameraData;
  label: string;
  operationId: string;
  version: { current: string };
}): { ok: boolean; reason?: string } {
  const { ctx, canvasId, cameraId, before, after, label, operationId, version } = input;
  const beforeSettings = worldCameraUiSettingsOf(before);
  const afterSettings = worldCameraUiSettingsOf(after);
  const apply = async (settings: WorldCameraUiSettings): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const result = await submitWorldCameraSave(ctx.canvasRemote, {
      canvasId,
      cameraId,
      expectedSettingsVersion: version.current,
      settings,
      operationId: createHighEntropyId("world-camera-timeline")
    });
    if (!result.ok) return { ok: false, reason: result.message };
    if (!worldCameraSettingsEqual(worldCameraUiSettingsOf(result.camera), settings)) {
      return { ok: false, reason: "镜头回执与请求的配置不一致" };
    }
    version.current = result.settingsVersion;
    return { ok: true };
  };
  return ctx.canvasEdit.recordExternal({
    id: `world-camera:${operationId}`,
    label,
    undo: () => apply(beforeSettings),
    redo: () => apply(afterSettings)
  }).ok ? { ok: true } : { ok: false, reason: "无法加入撤销历史" };
}

function CameraSettingsPanel({ ctx, canvas, canvasId, nodeId, camera, writable }: CameraPanelProps) {
  const [draft, setDraft] = useState<WorldCameraUiSettings>(() => worldCameraUiSettingsOf(camera));
  const [optimistic, setOptimistic] = useState<WorldCameraData | null>(null);
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<WorldCameraUiFailure | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [history, setHistory] = useState<HistoryState>({ loading: true, entries: [], error: null });
  const baseVersionRef = useRef(camera.settingsVersion);
  // Shared expected-version chain for the journal callbacks. It advances only after a
  // verified camera save; external changes make the next callback fail closed.
  const timelineVersionRef = useRef({ current: camera.settingsVersion });
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);

  const canonicalCamera = optimistic && camera.settingsVersion !== optimistic.settingsVersion ? optimistic : camera;
  const canonical = worldCameraUiSettingsOf(canonicalCamera);
  const dirty = !worldCameraSettingsEqual(draft, canonical);
  dirtyRef.current = dirty;
  const locked = !writable || saving;
  const framing = worldCameraFramingControl(draft);
  const [framingText, setFramingText] = useState(() => String(framing.value));
  const binding = worldCameraBoundTarget(canvas, draft.boundInstanceId);
  const bindingOptions = worldCameraBindingOptions(canvas, binding.status === "missing" ? binding.instanceId : null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A clean draft follows the canonical projection. A dirty draft keeps the user's
  // gesture and reports the clash instead of silently overwriting it.
  useEffect(() => {
    if (camera.settingsVersion === baseVersionRef.current) {
      setOptimistic(null);
      return;
    }
    if (!optimistic) timelineVersionRef.current = { current: camera.settingsVersion };
    // Our own committed write is waiting for the canonical projection. Do not treat
    // the still-old projection as an external edit.
    if (optimistic && camera.settingsVersion !== optimistic.settingsVersion) return;
    if (dirtyRef.current) {
      setExternalChange(true);
      return;
    }
    baseVersionRef.current = camera.settingsVersion;
    setOptimistic(null);
    setDraft(worldCameraUiSettingsOf(camera));
    setExternalChange(false);
  }, [camera.settingsVersion, optimistic]);

  useEffect(() => {
    setFramingText(String(framing.value));
  }, [framing.kind, framing.value]);

  useEffect(() => {
    const controller = new AbortController();
    setHistory({ loading: true, entries: [], error: null });
    void loadWorldCameraHistory(ctx.canvasRemote, { canvasId, cameraId: camera.cameraId, limit: 8 }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setHistory(result.ok
          ? { loading: false, entries: result.entries, error: null }
          : { loading: false, entries: [], error: result });
      })
      .catch((thrown) => {
        if (controller.signal.aborted) return;
        setHistory({
          loading: false,
          entries: [],
          error: { ok: false, code: "not-ready", message: thrown instanceof Error ? thrown.message : "无法读取镜头历史" }
        });
      });
    return () => controller.abort();
  }, [ctx, canvasId, camera.cameraId, historyEpoch]);

  function update(next: WorldCameraUiSettings): void {
    setDraft(next);
    setError(null);
    setNotice(null);
  }

  function loadLatest(): void {
    baseVersionRef.current = camera.settingsVersion;
    setOptimistic(null);
    setDraft(worldCameraUiSettingsOf(camera));
    setExternalChange(false);
    setError(null);
    setNotice("已载入画布上的当前镜头配置");
  }

  function commitFraming(): void {
    const parsed = Number(framingText);
    if (!Number.isFinite(parsed)) {
      setFramingText(String(framing.value));
      return;
    }
    const next = withWorldCameraFraming(draft, parsed);
    update(next);
    setFramingText(String(worldCameraFramingControl(next).value));
  }

  async function save(): Promise<void> {
    if (locked || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const beforeCamera = camera;
    const operationId = createHighEntropyId("world-camera-save");
    try {
      const result = await submitWorldCameraSave(ctx.canvasRemote, {
        canvasId,
        cameraId: camera.cameraId,
        expectedSettingsVersion: baseVersionRef.current,
        settings: draft,
        operationId
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result);
        return;
      }
      baseVersionRef.current = result.settingsVersion;
      timelineVersionRef.current = { current: result.settingsVersion };
      setOptimistic(result.camera);
      setDraft(worldCameraUiSettingsOf(result.camera));
      setExternalChange(false);
      const adopted = adoptCameraTimeline({
        ctx,
        canvasId,
        cameraId: camera.cameraId,
        before: beforeCamera,
        after: result.camera,
        label: "调整镜头设置",
        operationId,
        version: timelineVersionRef.current
      });
      setNotice(adopted.ok
        ? (result.duplicate ? "该镜头配置已经保存" : "镜头设置已保存")
        : "镜头设置已保存，但未能加入撤销历史");
      setSaving(false);
      const converged = await awaitWorldCameraCanonical({
        readCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()),
        canvasId,
        nodeId,
        cameraId: camera.cameraId,
        settingsVersion: result.settingsVersion,
        revision: result.revision
      });
      if (mountedRef.current && !converged) setNotice("保存已提交，等待画布同步后生效");
    } catch (thrown) {
      if (mountedRef.current) {
        setError({ ok: false, code: "not-ready", message: thrown instanceof Error ? thrown.message : "镜头保存失败" });
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function restore(entry: WorldCameraHistoryEntry): Promise<void> {
    if (locked) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const beforeCamera = camera;
    const operationId = createHighEntropyId("world-camera-restore");
    try {
      const result = await submitWorldCameraRestore(ctx.canvasRemote, {
        canvasId,
        cameraId: camera.cameraId,
        completionKey: entry.completionKey,
        expectedSettingsVersion: camera.settingsVersion
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result);
        return;
      }
      baseVersionRef.current = result.settingsVersion;
      timelineVersionRef.current = { current: result.settingsVersion };
      setOptimistic(result.camera);
      setDraft(worldCameraUiSettingsOf(result.camera));
      setExternalChange(false);
      const adopted = adoptCameraTimeline({
        ctx,
        canvasId,
        cameraId: camera.cameraId,
        before: beforeCamera,
        after: result.camera,
        label: "恢复镜头历史",
        operationId,
        version: timelineVersionRef.current
      });
      setNotice(adopted.ok ? "已恢复镜头历史" : "已恢复镜头历史，但未能加入撤销历史");
      setSaving(false);
      const converged = await awaitWorldCameraCanonical({
        readCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()),
        canvasId,
        nodeId,
        cameraId: camera.cameraId,
        settingsVersion: result.settingsVersion,
        revision: result.revision
      });
      if (mountedRef.current && !converged) setNotice("恢复已提交，等待画布同步后生效");
    } catch (thrown) {
      if (mountedRef.current) {
        setError({ ok: false, code: "not-ready", message: thrown instanceof Error ? thrown.message : "镜头恢复失败" });
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  if (collapsed) {
    return (
      <div className="world-camera-panel world-camera-panel--collapsed">
        <Button
          size="sm"
          icon={<ClapperboardIcon size={16} />}
          onClick={() => setCollapsed(false)}
        >
          镜头设置
        </Button>
      </div>
    );
  }

  return (
    <aside className="world-camera-panel" aria-label="镜头设置">
      <header className="world-camera-panel__header">
        <span className="world-camera-panel__icon" aria-hidden="true"><ClapperboardIcon size={16} /></span>
        <div className="world-camera-panel__heading">
          <span className="world-camera-panel__eyebrow">镜头</span>
          <strong>{projectionLabel(draft)} · {worldCameraAspectPresetId(draft) === "custom" ? "自定义画幅" : worldCameraAspectPresetId(draft)}</strong>
        </div>
        <IconButton label="收起镜头设置" onClick={() => setCollapsed(true)}><CloseIcon size={16} /></IconButton>
      </header>

      {!writable ? <p className="world-camera-panel__warning" role="status">当前画布不可写，只能查看镜头配置。</p> : null}
      {externalChange ? (
        <div className="world-camera-panel__warning" role="alert">
          <span>画布上的镜头配置已更新，当前修改基于旧版本。保存可能冲突。</span>
          <Button size="sm" onClick={loadLatest}>载入最新</Button>
        </div>
      ) : null}

      <section className="world-camera-panel__section">
        <h3>投影</h3>
        <SegmentedControl
          label="投影方式"
          value={draft.projection.kind}
          onValueChange={(value) => update(withWorldCameraProjectionKind(draft, value as "isometric" | "perspective"))}
          options={[
            { value: "isometric", label: "等距", disabled: locked },
            { value: "perspective", label: "透视", disabled: locked }
          ]}
        />
        <p className="world-camera-panel__hint">
          {draft.projection.kind === "isometric"
            ? "等距使用固定对角观察方向，不是简单关闭透视。"
            : "透视保留当前镜头朝向，并由垂直视野决定构图。"}
        </p>
      </section>

      <section className="world-camera-panel__section">
        <h3>画幅</h3>
        <SegmentedControl
          label="画幅"
          value={worldCameraAspectPresetId(draft)}
          onValueChange={(value) => update(withWorldCameraAspect(draft, value))}
          options={WORLD_CAMERA_ASPECT_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
            disabled: locked
          }))}
        />
        <p className="world-camera-panel__hint">画幅只影响取景与输出，不改变镜头卡片的画布位置或尺寸。</p>
      </section>

      <section className="world-camera-panel__section">
        <h3>构图</h3>
        <label className="world-camera-panel__field">
          <span>{framing.label}</span>
          <span className="world-camera-panel__number">
            <TextInput
              type="number"
              value={framingText}
              min={framing.min}
              max={framing.max}
              step={framing.step}
              disabled={locked}
              aria-label={framing.label}
              onChange={(event) => setFramingText(event.target.value)}
              onBlur={commitFraming}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span aria-hidden="true">{framing.unit}</span>
          </span>
        </label>
        <p className="world-camera-panel__hint">镜头位置与朝向由创建姿态和后续创作调整；本面板不修改模型高度。</p>
      </section>

      <section className="world-camera-panel__section">
        <h3>输出方向</h3>
        <SegmentedControl
          label="输出方向"
          value={draft.captureMode.kind}
          onValueChange={(value) => update(withWorldCameraCaptureMode(draft, value as "static" | "dynamic"))}
          options={[
            { value: "static", label: "静态", disabled: locked },
            { value: "dynamic", label: "动态", disabled: locked }
          ]}
        />
      </section>

      <section className="world-camera-panel__section">
        <h3>入镜模型</h3>
        <SelectInput
          label="绑定模型"
          value={draft.boundInstanceId ?? ""}
          options={bindingOptions}
          disabled={locked}
          onValueChange={(value) => update(withWorldCameraBinding(draft, value === "" ? null : value))}
        />
        <p className="world-camera-panel__hint">
          {binding.status === "unbound"
            ? "未绑定：按当前构图拍摄共享世界中可见的对象，可以跨场景区。"
            : binding.status === "bound"
              ? `仅 ${binding.label} 入镜；场景区范围不裁切取景。`
              : "绑定目标已失效。"}
        </p>
        {binding.status === "missing" ? (
          <div className="world-camera-panel__warning" role="alert">
            <span>绑定的模型已不存在或不可用。保存会保留该绑定，不会静默改为拍摄全世界。</span>
            <Button size="sm" icon={<UnlinkIcon size={14} />} disabled={locked} onClick={() => update(withWorldCameraBinding(draft, null))}>
              解除绑定
            </Button>
          </div>
        ) : null}
        {binding.status === "bound" ? (
          <Button size="sm" icon={<UnlinkIcon size={14} />} disabled={locked} onClick={() => update(withWorldCameraBinding(draft, null))}>
            解除绑定
          </Button>
        ) : null}
      </section>

      <section className="world-camera-panel__section">
        <h3>取景预览</h3>
        <div className="world-camera-panel__capture" role="status">
          <strong>取景待接入</strong>
          <span>真实 capture producer 尚未完成，这里不显示或伪造预览图。保存只更新镜头参数；画面刷新由后续取景链路负责。</span>
        </div>
      </section>

      <section className="world-camera-panel__section">
        <div className="world-camera-panel__section-heading">
          <h3>镜头历史</h3>
          <IconButton
            size="sm"
            label="刷新镜头历史"
            disabled={saving}
            onClick={() => setHistoryEpoch((value) => value + 1)}
          ><RefreshIcon size={14} /></IconButton>
        </div>
        {history.loading ? <p className="world-camera-panel__hint">正在读取镜头历史…</p> : null}
        {!history.loading && history.error ? (
          <p className="world-camera-panel__error" role="alert">{worldCameraUiFailureText(history.error)}</p>
        ) : null}
        {!history.loading && !history.error && history.entries.length === 0 ? (
          <p className="world-camera-panel__hint">暂无助手镜头历史。完成镜头修改时才会生成版本；保存本面板设置不会新增历史。</p>
        ) : null}
        {dirty && history.entries.length > 0 ? (
          <p className="world-camera-panel__hint">恢复历史会替换当前未保存的修改。</p>
        ) : null}
        {history.entries.map((entry) => (
          <div className="world-camera-panel__history-row" key={entry.completionKey}>
            <span>
              <strong>{entry.snapshot.camera.projection.kind === "isometric" ? "等距" : "透视"} · {entry.snapshot.camera.aspect.width}:{entry.snapshot.camera.aspect.height}</strong>
              <small>{formatHistoryTime(entry.createdAt)}</small>
            </span>
            <Button size="sm" disabled={locked} onClick={() => void restore(entry)}>恢复</Button>
          </div>
        ))}
      </section>

      {error ? (
        <div className="world-camera-panel__error" role="alert">
          <span>{worldCameraUiFailureText(error)}</span>
          {error.conflicts?.length ? (
            <ul className="world-camera-panel__conflicts">
              {error.conflicts.map((conflict) => (
                <li key={`${conflict.target.kind}:${conflict.runId}:${conflict.epoch}`}>
                  {conflict.target.kind === "instance"
                    ? `模型 ${conflict.target.instanceId}`
                    : `镜头 ${conflict.target.cameraId}`} · 运行 {conflict.runId} · epoch {conflict.epoch}
                </li>
              ))}
            </ul>
          ) : null}
          {error.code === "version-conflict" ? <Button size="sm" onClick={loadLatest}>载入最新</Button> : null}
        </div>
      ) : null}
      {notice ? <p className="world-camera-panel__notice" role="status">{notice}</p> : null}

      <footer className="world-camera-panel__footer">
        <Button
          tone="primary"
          loading={saving}
          disabled={locked || !dirty}
          onClick={() => void save()}
        >
          保存镜头
        </Button>
        <Button tone="ghost" disabled={saving} onClick={loadLatest}>载入最新</Button>
      </footer>
    </aside>
  );
}

export function WorldCameraOverlay({ ctx, canvasId, writable }: { ctx: Context; canvasId?: string; writable: boolean }) {
  const canvas = useSyncExternalStore(
    woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()),
    () => null
  );
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const nodeId = selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  if (!canvas || !nodeId || (canvasId && canvas.id !== canvasId)) return null;
  const camera = readWorldCamera(canvas, nodeId);
  if (!camera) return null;
  return (
    <CameraSettingsPanel
      key={`${canvas.id}:${nodeId}`}
      ctx={ctx}
      canvas={canvas}
      canvasId={canvas.id}
      nodeId={nodeId}
      camera={camera}
      writable={writable}
    />
  );
}

export function worldCamerasExtension(options: { canvasId?: string } = {}): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const remove = ctx.slots.register("canvas.overlay", {
      id: WORLD_CAMERAS_PLUGIN_ID,
      owner: WORLD_CAMERAS_PLUGIN_ID,
      priority: 24,
      render: (props) => <WorldCameraOverlay ctx={ctx} canvasId={options.canvasId} writable={props.writable} />
    });
    ctx.effect(() => remove, "world-cameras-overlay");
  }, { name: WORLD_CAMERAS_PLUGIN_ID, inject: ["slots", "canvasRemote", "canvasEdit"] });
}
