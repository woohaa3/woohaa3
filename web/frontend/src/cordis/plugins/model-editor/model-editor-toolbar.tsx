/**
 * 模型编辑右侧工具栏
 * （change: add-model-editor-gizmo-shot-capture，任务 2.3 / design D2/D6；
 *  change: adopt-radix-lucide-canvas-ui 任务 7.1：通用 button/toggle/icon 迁移到生产
 *  Button/SegmentedControl/IconButton，保留 shot rig controller 与 Bevy gizmo ownership）。
 *
 * 模型聚焦编辑期间常驻画布右侧的非模态工具栏：
 * - 互斥工具模式（模型 / 镜头）；
 * - 镜头列表、添加、选择、删除与 pose 文本（方位角、固定仰角 45°、距离）；
 * - 「截图」动作。选中镜头的取景就是主画面，不再另开角落预览。
 *
 * 纯展示：所有状态来自 `ModelEditorSession`，动作回调由宿主注入；不直接读写 canonical
 * 状态，也不创建第二个 canvas。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MODEL_CAMERA_ASPECTS,
  type ModelCamera,
  type ModelCameraAspect,
  type ModelCameraFocusOffset
} from "@woohaa3/contracts";
import type { ModelEditorSession, ModelCameraPose } from "../../../extension-api/model-workspace-session.js";
import { Button, IconButton } from "../../../shared/ui/Button.js";
import { SegmentedControl } from "../../../shared/ui/SegmentedControl.js";
import { Tooltip } from "../../../shared/ui/Tooltip.js";
import { CloseIcon } from "../../../shared/ui/icons.js";
import { CameraRegion } from "./camera-region.js";

export type ModelEditorToolbarProps = {
  session: ModelEditorSession;
  /** Selecting a camera/tool releases any object gizmo in the shared workspace. */
  onActivateCamera?: () => void;
  /** 当前会话是否可写；false 时禁用所有持久化动作。 */
  writable: boolean;
  /** 模型内容是否可用（renderer ready + 合法 Scene IR）；false 时禁用 gizmo/镜头动作。 */
  rendererReady?: boolean;
  /**
   * 历史只读浏览（change: 对齐 xyflow-bevy 历史只读浏览）。
   * 为 true 时禁用镜头 CRUD、焦点字段、重命名/重置与截图；只保留查看。
   */
  readOnly?: boolean;
  /** 右侧实际占用宽度回调（供 content rect 投影）。 */
  onWidthChange?: (width: number) => void;
  /** 添加一个镜头（默认 auto-fit pose 由宿主按当前模型 AABB 计算）。 */
  onAddCamera: () => void;
  cameraCollectionMutable?: boolean;
  /** 截图当前选中镜头。 */
  onCapture: () => void;
  /** 重试失败截图。 */
  onRetryCapture?: () => void;
  /** 重置镜头使用的默认自动取景距离（由宿主按当前模型 AABB 计算）。 */
  defaultDistance?: number;
  /** 当前画布 id（供镜头 MCP 指引带出操作对象）。 */
  canvasId?: string;
  /** 节点 id（供镜头生成捕获目标）。 */
  nodeIdOverride?: string;
  /**
   * 通用 authoring 生成入口渲染闭包（change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.4）。
   *
   * 由宿主从 `authoring.generate` slot 解析并绑定目标身份；外部工具指引按需展开。
   */
  renderGenerate?: (() => import("react").ReactNode) | undefined;
  /** 复制文本的注入点（缺省用系统 clipboard）；返回 false 表示复制失败。 */
  copyText?: (value: string) => Promise<boolean | void>;
};

const CAMERA_TOOL_OPTIONS: ReadonlyArray<{ value: "orbit" | "elevation" | "distance" | "focus"; label: string }> = [
  { value: "orbit", label: "轨道" },
  { value: "elevation", label: "仰角" },
  { value: "distance", label: "距离" },
  { value: "focus", label: "注视点" }
];

export function ModelEditorToolbar(props: ModelEditorToolbarProps) {
  const state = useSyncExternalStore(props.session.subscribe, props.session.getState, props.session.getState);
  if (!state.nodeId) return null;

  const cameras = props.session.cameras();
  const selected = props.session.selectedCamera();
  const pose = selected ? props.session.effectivePose(selected) : null;
  const readOnly = props.readOnly === true;
  const disabled = readOnly || !props.writable || props.rendererReady === false;
  const busy = props.session.captureBusy;

  const cameraControls = (<>
        <div className="model-editor__cameras-header">
          <span className="model-editor__cameras-title">镜头</span>
          <Tooltip content={disabled ? "只读会话无法添加镜头" : "添加镜头"}>
            <Button
              className="model-editor__add"
              tone="neutral"
              size="sm"
              disabled={disabled || props.cameraCollectionMutable === false}
              onClick={props.onAddCamera}
            >
              添加镜头
            </Button>
          </Tooltip>
        </div>

        {cameras.length === 0 ? (
          <p className="model-editor__empty" role="status">
            还没有镜头。点击「添加镜头」创建一个默认自动取景的镜头。
          </p>
        ) : (
          <ul className="model-editor__camera-list">
            {cameras.map((camera: ModelCamera) => (
              <li
                key={camera.id}
                className={`model-editor__camera${state.selectedCameraId === camera.id ? " is-selected" : ""}`}
                data-camera-id={camera.id}
              >
                <button
                  type="button"
                  className="model-editor__camera-select"
                  aria-pressed={state.selectedCameraId === camera.id}
                  onClick={() => { props.onActivateCamera?.(); props.session.selectCamera(camera.id); }}
                >
                  <span className="model-editor__camera-name">{camera.name}</span>
                </button>
                <Tooltip content={`删除 ${camera.name}`}>
                  <IconButton
                    className="model-editor__camera-remove"
                    label={`删除 ${camera.name}`}
                    size="sm"
                    tone="danger"
                    disabled={disabled || props.cameraCollectionMutable === false}
                    onClick={() => props.session.removeCamera(camera.id)}
                  >
                    <CloseIcon />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}

        {selected && pose ? (
          <div className="model-editor__pose" data-model-editor-pose="true">
            <span>方位 {(pose.azimuth * 180 / Math.PI).toFixed(0)}°</span>
            <span>仰角 {(pose.elevation * 180 / Math.PI).toFixed(0)}°</span>
            <span>距离 {pose.distance.toFixed(2)}</span>
          </div>
        ) : null}

        {selected && pose ? (
          <div className="model-editor__pose-fields" data-model-editor-pose-fields="true">
            <SegmentedControl
              className="model-editor__tools"
              label="镜头工具"
              value={state.cameraTool}
              onValueChange={(value) => { props.onActivateCamera?.(); props.session.setCameraTool(value as "orbit" | "elevation" | "distance" | "focus"); }}
              optionClassName="model-editor__tool"
              options={CAMERA_TOOL_OPTIONS.map((option) => ({
                ...option,
                disabled: disabled || (option.value === "focus" && props.session.getState().toolMode !== "camera")
              }))}
            />
            <PoseFields session={props.session} disabled={disabled} pose={pose} />
            <label className="model-editor__aspect">
              <span>画幅</span>
              <select
                value={pose.aspect}
                disabled={disabled}
                aria-label="镜头画幅"
                onChange={(event) => props.session.commitAspect(event.target.value as ModelCameraAspect)}
              >
                {MODEL_CAMERA_ASPECTS.map((aspect) => (
                  <option key={aspect} value={aspect}>
                    {aspect}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {selected ? (
          <div className="model-editor__camera-actions">
            <label className="model-editor__rename">
              <span>名称</span>
              <input
                type="text"
                defaultValue={selected.name}
                disabled={disabled}
                aria-label="镜头名称"
                onBlur={(event) => props.session.renameSelectedCamera(event.target.value)}
              />
            </label>
            <Button
              className="model-editor__reset"
              tone="neutral"
              size="sm"
              disabled={disabled}
              onClick={() =>
                props.session.resetSelectedCamera({
                  azimuth: 0,
                  distance: props.defaultDistance ?? selected.distance
                })
              }
            >
              重置镜头
            </Button>
          </div>
        ) : null}

        {selected ? (
          <div className="model-editor__focus" data-model-editor-focus="true">
            <span className="model-editor__focus-title">注视点偏移</span>
            <FocusOffsetFields session={props.session} disabled={disabled} camera={selected} />
          </div>
        ) : null}

        {selected ? (
          <div className="model-editor__capture">
            <Button
              className="model-editor__capture-button"
              tone="primary"
              size="sm"
              loading={busy}
              disabled={disabled}
              onClick={state.capturePhase === "failed" && props.onRetryCapture ? props.onRetryCapture : props.onCapture}
            >
              {busy ? "处理中…" : "截图"}
            </Button>
            {state.captureError ? (
              <p className="model-editor__error" role="alert">
                {state.captureError}
              </p>
            ) : null}
          </div>
        ) : null}

  </>);
  const generationRegion = (<CameraRegion
          nodeId={state.nodeId}
          canvasId={props.canvasId}
          cameras={cameras}
          selectedCameraId={state.selectedCameraId}
          copyText={props.copyText}
          renderGenerate={props.renderGenerate}
        />);

  return (
    <div
      className="model-editor"
      role="region"
      aria-label="模型编辑工具"
      data-node-id={state.nodeId}
      data-read-only={readOnly ? "true" : undefined}
      ref={(element) => {
        if (element && props.onWidthChange) props.onWidthChange(element.getBoundingClientRect().width);
      }}
      // 工具栏自身消费 pointer/wheel：不驱动画布相机/视口。
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {readOnly ? (
        <p className="model-editor__read-only" role="note">
          历史浏览中：镜头与截图已禁用，仅可查看。
        </p>
      ) : null}

      <div className="model-editor__body" data-model-editor-tool="camera">
        {cameraControls}
        {generationRegion}
      </div>
    </div>
  );
}

/**
 * 方位角 / 仰角 / 距离 受控数值字段
 * （change: fix-model-focus-navigation-and-camera-parity，task 5.3；
 *  change: add-shot-camera-elevation-control 增加仰角）。
 *
 * 与场景 orbit/elevation/distance 工具等价：输入有净变化时通过 `commitAzimuth` /
 * `commitElevation` / `commitDistance` 走同一 `beginPose/updatePose/endPose` 提交一次完整
 * `modelCameras` patch。Escape 取消不改值。
 */
function PoseFields(props: {
  session: ModelEditorSession;
  /** Selecting a camera/tool releases any object gizmo in the shared workspace. */
  onActivateCamera?: () => void;
  disabled: boolean;
  pose: ModelCameraPose;
}) {
  const { pose } = props;
  const [azimuthDeg, setAzimuthDeg] = useState(formatAzimuthDeg(pose.azimuth));
  const [elevationDeg, setElevationDeg] = useState(formatAzimuthDeg(pose.elevation));
  const [distance, setDistance] = useState(pose.distance.toFixed(2));
  useEffect(() => {
    setAzimuthDeg(formatAzimuthDeg(pose.azimuth));
    setElevationDeg(formatAzimuthDeg(pose.elevation));
    setDistance(pose.distance.toFixed(2));
  }, [pose.azimuth, pose.elevation, pose.distance]);

  const commitAzimuth = () => {
    const parsed = Number(azimuthDeg);
    if (!Number.isFinite(parsed)) {
      setAzimuthDeg(formatAzimuthDeg(pose.azimuth));
      return;
    }
    props.session.commitAzimuth((parsed * Math.PI) / 180);
  };
  const commitElevation = () => {
    const parsed = Number(elevationDeg);
    if (!Number.isFinite(parsed)) {
      setElevationDeg(formatAzimuthDeg(pose.elevation));
      return;
    }
    props.session.commitElevation((parsed * Math.PI) / 180);
  };
  const commitDistance = () => {
    const parsed = Number(distance);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDistance(pose.distance.toFixed(2));
      return;
    }
    props.session.commitDistance(parsed);
  };

  return (
    <div className="model-editor__pose-inputs" role="group" aria-label="镜头方位、仰角与距离">
      <label className="model-editor__pose-axis">
        <span>方位 °</span>
        <input
          type="number"
          step={1}
          disabled={props.disabled}
          value={azimuthDeg}
          aria-label="镜头方位角"
          onChange={(event) => setAzimuthDeg(event.target.value)}
          onBlur={commitAzimuth}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAzimuth();
            if (event.key === "Escape") setAzimuthDeg(formatAzimuthDeg(pose.azimuth));
          }}
        />
      </label>
      <label className="model-editor__pose-axis">
        <span>仰角 °</span>
        <input
          type="number"
          step={1}
          min={-90}
          max={90}
          disabled={props.disabled}
          value={elevationDeg}
          aria-label="镜头仰角"
          onChange={(event) => setElevationDeg(event.target.value)}
          onBlur={commitElevation}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitElevation();
            if (event.key === "Escape") setElevationDeg(formatAzimuthDeg(pose.elevation));
          }}
        />
      </label>
      <label className="model-editor__pose-axis">
        <span>距离</span>
        <input
          type="number"
          step={0.1}
          min={0}
          disabled={props.disabled}
          value={distance}
          aria-label="镜头距离"
          onChange={(event) => setDistance(event.target.value)}
          onBlur={commitDistance}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDistance();
            if (event.key === "Escape") setDistance(pose.distance.toFixed(2));
          }}
        />
      </label>
    </div>
  );
}

/** 弧度 → 稳定度数文本（去尾零）。 */
function formatAzimuthDeg(azimuth: number): string {
  const degrees = (azimuth * 180) / Math.PI;
  return Number.parseFloat(degrees.toFixed(1)).toString();
}

/**
 * 注视点偏移数值字段（change: 模型编辑 gizmo 焦点）。
 *
 * 与焦点 gizmo 写入等价：输入有净变化时走 `endFocus` 提交一次 `modelCameras` patch。
 * 受控于 session 的 `effectiveFocus`（含拖动 preview）。Escape 取消不改值。
 */
function FocusOffsetFields(props: {
  session: ModelEditorSession;
  /** Selecting a camera/tool releases any object gizmo in the shared workspace. */
  onActivateCamera?: () => void;
  disabled: boolean;
  camera: ModelCamera;
}) {
  const effective = props.session.effectiveFocus(props.camera);
  // 本地草稿：拖动 gizmo 时 session preview 会变化，这里同步到 input 值。
  const [draft, setDraft] = useState<ModelCameraFocusOffset>(effective);
  useEffect(() => {
    setDraft(effective);
    // 基本类型依赖：仅在有效偏移真正变化时同步，避免无意义渲染循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective.x, effective.y, effective.z]);

  const commitAxis = (axis: "x" | "y" | "z", value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...draft, [axis]: value };
    if (!props.session.beginFocus()) return;
    props.session.updateFocus(next);
    props.session.endFocus();
  };

  return (
    <div className="model-editor__focus-fields" role="group" aria-label="注视点偏移">
      {(["x", "y", "z"] as const).map((axis) => (
        <label key={axis} className="model-editor__focus-axis">
          <span>{axis.toUpperCase()}</span>
          <input
            type="number"
            step={0.1}
            disabled={props.disabled}
            value={Number.isFinite(draft[axis]) ? draft[axis] : 0}
            aria-label={`注视点 ${axis}`}
            onChange={(event) => setDraft({ ...draft, [axis]: Number(event.target.value) })}
            onBlur={(event) => commitAxis(axis, Number(event.target.value))}
          />
        </label>
      ))}
    </div>
  );
}
