/**
 * 模型编辑会话状态
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 2.3 / 3.4 / design D1/D2/D6）。
 *
 * 持有模型聚焦编辑期间的**浏览器本地**状态：工具模式（模型 / 镜头）、当前选中镜头、
 * 瞬时镜头 pose preview、截图 capture 生命周期与预览 URL。它**不**写 ServerCanvas /
 * CanvasCommand / Y.Doc；canonical 镜头列表来自 `nodeData.modelCameras`，由宿主读写。
 *
 * 与 `parameterPreviewStore` 的分工：模型 placement preview 仍走既有 store；镜头 pose
 * preview 走本会话（镜头不是 placement）。截图 preview 的 Blob/object URL 只属于 session，
 * 退出/替换/dispose 时立即撤销，绝不进入渲染场景或 nodeData。
 */
import {
  applyModelCameraMutation,
  clampCameraElevation,
  createDefaultModelCamera,
  decodeModelCameras,
  modelCameraElevation,
  setModelCameraAspect,
  modelCameraFocusOffset,
  renameModelCamera,
  resetModelCamera,
  type ModelCamera,
  type ModelCameraAspect,
  type ModelCameraFocusOffset
} from "@woohaa3/contracts";

export type ModelEditorToolMode = "model" | "camera";

/**
 * 显式镜头工具（change: fix-model-focus-navigation-and-camera-parity，task 4.4/design D6；
 * change: add-shot-camera-elevation-control）。
 *
 * - `orbit`：主按钮横向拖动调整选中拍摄镜头 azimuth；
 * - `elevation`：主按钮纵向拖动调整 elevation（-90°..+90° 竖直半圆）；
 * - `distance`：主按钮纵向拖动调整 distance；
 * - `focus`：只操作注视点三轴 gizmo。
 *
 * 与场景 gizmo 共用同一 preview/commit pipeline；均不改变主观察相机。
 */
export type ModelCameraTool = "orbit" | "elevation" | "distance" | "focus";

/** 镜头有效 pose：方位、仰角、距离与画幅（change: add-shot-camera-elevation-control）。 */
export type ModelCameraPose = { azimuth: number; elevation: number; distance: number; aspect: ModelCameraAspect };

/** 焦点手势 preview（change: 模型编辑 gizmo 焦点）：相对 AABB 中心的注视点偏移。 */
export type ModelFocusPreview = ModelCameraFocusOffset;

export type CapturePhase = "idle" | "rendering" | "uploading" | "submitting" | "failed";

export type ModelEditorSessionState = {
  /** 当前编辑的 canonical 模型节点；退出聚焦时为 null。 */
  nodeId: string | null;
  /** 互斥工具模式（design D6）。 */
  toolMode: ModelEditorToolMode;
  /** 当前选中的显式镜头工具（task 4.4）。 */
  cameraTool: ModelCameraTool;
  /** 当前选中镜头 id；无选中为 null。 */
  selectedCameraId: string | null;
  /** 镜头 pose 瞬时 preview（拖动中）；无 preview 为 null。 */
  posePreview: ModelCameraPose | null;
  /** 镜头焦点偏移瞬时 preview（拖动中）；无 preview 为 null。 */
  focusPreview: ModelFocusPreview | null;
  /** 截图预览 URL（session-only；退出时撤销）。 */
  previewUrl: string | null;
  /** 截图阶段。 */
  capturePhase: CapturePhase;
  /** 最近一次截图/上传失败的安全信息。 */
  captureError: string | null;
};

const INITIAL: ModelEditorSessionState = {
  nodeId: null,
  toolMode: "camera",
  cameraTool: "orbit",
  selectedCameraId: null,
  posePreview: null,
  focusPreview: null,
  previewUrl: null,
  capturePhase: "idle",
  captureError: null
};

export type ModelEditorSessionDeps = {
  /** 读取当前 canonical `modelCameras`（working projection 优先）。 */
  readCameras: (nodeId: string) => readonly ModelCamera[];
  /** 会话是否可写（只读时禁用所有持久化动作）。 */
  isWritable: () => boolean;
  /** 提交一次完整规范化 `modelCameras` patch（会话负责生成的 commandId）。 */
  submitCameras: (nodeId: string, cameras: readonly ModelCamera[]) => boolean;
  /** 撤销一个 object URL（缺省 no-op；测试可注入）。 */
  revokeObjectUrl?: (url: string) => void;
};

export class ModelEditorSession {
  private gestureCamera: string | null = null;
  private state: ModelEditorSessionState = { ...INITIAL };
  private readonly listeners = new Set<() => void>();
  /**
   * 已提交但尚未出现在 working projection 的镜头列表。
   *
   * Canvas command 的回流是异步的；如果添加镜头后立刻只读 canonical 列表，刚选中的镜头
   * 会短暂消失，进而让本帧 `modelEditor.shot` 为空。这里保留成功提交的列表，直到 working
   * projection 追平，再自动回到权威数据。
   */
  private optimisticCameras: { nodeId: string; value: ModelCamera[] } | null = null;
  /** 截图的 capture 失败只保留到下一次动作；这里只做本地展示。 */
  constructor(private readonly deps: ModelEditorSessionDeps) {}

  getState = (): ModelEditorSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 进入模型编辑（聚焦打开时调用）。默认镜头模式并重置截图状态。 */
  enter(nodeId: string): void {
    this.revokePreview();
    this.optimisticCameras = null;
    this.state = { ...INITIAL, nodeId, toolMode: "camera" };
    // 自动选中第一条镜头（若已有），使场景 gizmo 立即出现。
    const first = this.cameras()[0];
    if (first) this.state.selectedCameraId = first.id;
    this.emit();
  }

  /** 退出编辑：撤销 preview、释放 capture 状态（迟到结果由 generation 丢弃）。 */
  exit(): void {
    this.revokePreview();
    this.optimisticCameras = null;
    this.state = { ...INITIAL };
    this.emit();
  }

  /** 切换工具模式；切到镜头模式且无选中时选中第一条合法镜头。 */
  setToolMode(mode: ModelEditorToolMode): void {
    if (!this.state.nodeId) return;
    const next: ModelEditorSessionState = { ...this.state, toolMode: mode, posePreview: null, focusPreview: null };
    if (mode === "camera" && this.state.selectedCameraId === null) {
      const cameras = this.cameras();
      next.selectedCameraId = cameras[0]?.id ?? null;
    }
    this.state = next;
    this.emit();
  }

  /** 切换显式镜头工具（design D6/task 4.4）。 */
  setCameraTool(tool: ModelCameraTool): void {
    if (!this.state.nodeId) return;
    this.state = { ...this.state, toolMode: "camera", cameraTool: tool, posePreview: null, focusPreview: null };
    this.emit();
  }

  /** 当前 canonical 镜头列表（合法规范化后；缺失/非法返回空）。 */
  cameras(): ModelCamera[] {
    const nodeId = this.state.nodeId;
    if (!nodeId) return [];
    const raw = this.deps.readCameras(nodeId);
    const decoded = decodeModelCameras([...raw]);
    const canonical = decoded.ok ? decoded.value : [];
    const optimistic = this.optimisticCameras;
    if (!optimistic || optimistic.nodeId !== nodeId) return canonical;
    if (sameCameras(canonical, optimistic.value)) {
      this.optimisticCameras = null;
      return canonical;
    }
    return optimistic.value.map((camera) => ({ ...camera }));
  }

  /** 当前选中镜头；无选中/已删除返回 null。 */
  selectedCamera(): ModelCamera | null {
    const id = this.state.selectedCameraId;
    if (!id) return null;
    return this.cameras().find((camera) => camera.id === id) ?? null;
  }

  /** 选中镜头（session-only）。 */
  selectCamera(id: string): void {
    if (!this.state.nodeId) return;
    if (!this.cameras().some((camera) => camera.id === id)) return;
    this.state = { ...this.state, selectedCameraId: id, toolMode: "camera", posePreview: null, focusPreview: null };
    this.emit();
  }

  /**
   * 添加镜头：稳定 ID、默认名称、默认自动取景 pose 与 `16:9` 画幅，立即选中并切到镜头工具。
   * 只在会话可写时持久化；否则只更新本地选择。
   */
  addCamera(input: { azimuth: number; elevation?: number; distance: number; aspect?: ModelCameraAspect; seed?: string }): ModelCamera | null {
    const nodeId = this.state.nodeId;
    if (!nodeId) return null;
    const existing = this.cameras();
    const camera = createDefaultModelCamera({
      existing,
      azimuth: input.azimuth,
      ...(input.elevation === undefined ? {} : { elevation: input.elevation }),
      distance: input.distance,
      ...(input.aspect ? { aspect: input.aspect } : {}),
      nodeId,
      ...(input.seed ? { seed: input.seed } : {})
    });
    const next = applyModelCameraMutation(existing, { kind: "upsert", camera });
    this.state = { ...this.state, selectedCameraId: camera.id, toolMode: "camera", posePreview: null, focusPreview: null };
    this.submitCameras(nodeId, next);
    this.emit();
    return camera;
  }

  /** 删除镜头：从子资源移除；既有截图图片节点不被级联删除。 */
  removeCamera(id: string): void {
    const nodeId = this.state.nodeId;
    if (!nodeId) return;
    const existing = this.cameras();
    const next = applyModelCameraMutation(existing, { kind: "remove", id });
    const selected = this.state.selectedCameraId === id ? (next[0]?.id ?? null) : this.state.selectedCameraId;
    this.state = { ...this.state, selectedCameraId: selected, posePreview: null, focusPreview: null };
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /**
   * 重命名选中镜头（change: 模型编辑 gizmo 焦点）。
   *
   * 名称先裁剪并限长；裁剪后为空时不动。可写时从最新 working 列表重放，避免覆盖其它镜头。
   */
  renameSelectedCamera(name: string): void {
    const nodeId = this.state.nodeId;
    const selected = this.selectedCamera();
    if (!nodeId || !selected) return;
    const next = renameModelCamera(this.cameras(), selected.id, name);
    if (next.find((camera) => camera.id === selected.id)?.name === selected.name) {
      this.emit();
      return;
    }
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /**
   * 重置选中镜头：清空 `focusOffset` 并回到调用方给出的默认 pose，保留画幅
   * （change: 模型编辑 gizmo 焦点 / fix-model-focus-navigation-and-camera-parity D8）。
   */
  resetSelectedCamera(defaults: { azimuth: number; elevation?: number; distance: number }): void {
    const nodeId = this.state.nodeId;
    const selected = this.selectedCamera();
    if (!nodeId || !selected) return;
    const next = resetModelCamera(this.cameras(), selected.id, defaults);
    this.state = { ...this.state, posePreview: null, focusPreview: null };
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /** 开始一次镜头 pose 手势：冻结时只记录 preview（含画幅与仰角），不写规范状态。 */
  beginPose(): void {
    const selected = this.selectedCamera();
    if (!selected || !this.deps.isWritable()) return;
    this.gestureCamera = JSON.stringify(selected);
    this.state = {
      ...this.state,
      posePreview: {
        azimuth: selected.azimuth,
        elevation: modelCameraElevation(selected),
        distance: selected.distance,
        aspect: selected.aspect
      },
      focusPreview: null
    };
    this.emit();
  }

  /** 推进 pose preview（拖动中）。 */
  updatePose(pose: Partial<ModelCameraPose>): void {
    if (!this.state.posePreview) return;
    this.state = { ...this.state, posePreview: { ...this.state.posePreview, ...pose } };
    this.emit();
  }

  /**
   * 结束 pose 手势：有净变化且可写时提交一次完整 `modelCameras` patch（从最新 working
   * 列表重放该 camera 的变更，避免覆盖其它镜头）。保留 `focusOffset`。
   */
  endPose(): void {
    const preview = this.state.posePreview;
    const selected = this.selectedCamera();
    const nodeId = this.state.nodeId;
    this.state = { ...this.state, posePreview: null };
    const valid = this.deps.isWritable() && this.gestureCamera === JSON.stringify(selected);
    this.gestureCamera = null;
    if (!preview || !selected || !nodeId || !valid) {
      this.emit();
      return;
    }
    const elevationChanged = Math.abs(preview.elevation - modelCameraElevation(selected)) > 1e-6;
    const changed =
      Math.abs(preview.azimuth - selected.azimuth) > 1e-6 ||
      elevationChanged ||
      Math.abs(preview.distance - selected.distance) > 1e-6 ||
      preview.aspect !== selected.aspect;
    if (!changed) {
      this.emit();
      return;
    }
    const next = applyModelCameraMutation(this.cameras(), {
      kind: "upsert",
      camera: {
        ...selected,
        azimuth: preview.azimuth,
        elevation: clampCameraElevation(preview.elevation),
        distance: preview.distance,
        aspect: preview.aspect
      }
    });
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /** 当前生效的镜头 pose（preview 优先）。 */
  effectivePose(camera: ModelCamera): ModelCameraPose {
    return (
      this.state.posePreview ?? {
        azimuth: camera.azimuth,
        elevation: modelCameraElevation(camera),
        distance: camera.distance,
        aspect: camera.aspect
      }
    );
  }

  /** 取消一次 pose 手势：丢弃 preview，不提交（design D7/task 4.5）。 */
  cancelPose(): void {
    if (this.state.posePreview === null) return;
    this.state = { ...this.state, posePreview: null };
    this.emit();
  }

  /** 取消一次焦点手势：丢弃 preview，不提交（design D7/task 4.5）。 */
  cancelFocus(): void {
    if (this.state.focusPreview === null) return;
    this.state = { ...this.state, focusPreview: null };
    this.emit();
  }

  /**
   * 直接字段编辑：画幅（design D7/D8）。连续输入只改 preview；这里作为单次提交入口。
   * 与场景工具等价：有净变化且可写时提交一次完整 patch。
   */
  commitAspect(aspect: ModelCameraAspect): void {
    const nodeId = this.state.nodeId;
    const selected = this.selectedCamera();
    if (!nodeId || !selected) return;
    const next = setModelCameraAspect(this.cameras(), selected.id, aspect);
    if (next.find((camera) => camera.id === selected.id)?.aspect === selected.aspect) {
      this.emit();
      return;
    }
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /** 直接字段编辑：方位角（design D7）。以单次 `endPose` 语义提交。 */
  commitAzimuth(azimuth: number): void {
    if (!Number.isFinite(azimuth)) return;
    if (!this.selectedCamera()) return;
    this.beginPose();
    this.updatePose({ azimuth });
    this.endPose();
  }

  /** 直接字段编辑：仰角（change: add-shot-camera-elevation-control）。越界按半圆钳制。 */
  commitElevation(elevation: number): void {
    if (!Number.isFinite(elevation)) return;
    if (!this.selectedCamera()) return;
    this.beginPose();
    this.updatePose({ elevation: clampCameraElevation(elevation) });
    this.endPose();
  }

  /** 直接字段编辑：距离（design D7）。 */
  commitDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    if (!this.selectedCamera()) return;
    this.beginPose();
    this.updatePose({ distance });
    this.endPose();
  }

  // ── 焦点偏移手势（change: 模型编辑 gizmo 焦点） ──────────────────────────

  /**
   * 开始一次焦点手势：冻结选中镜头的有效 focusOffset 为 preview（不改规范状态）。
   * 返回是否成功进入（无选中镜头时为 false）。
   */
  beginFocus(): boolean {
    const selected = this.selectedCamera();
    if (!selected || !this.deps.isWritable()) return false;
    this.gestureCamera = JSON.stringify(selected);
    const offset = modelCameraFocusOffset(selected);
    this.state = { ...this.state, focusPreview: { ...offset }, posePreview: null };
    this.emit();
    return true;
  }

  /** 推进焦点 preview（拖动中）。 */
  updateFocus(offset: ModelCameraFocusOffset): void {
    if (!this.state.focusPreview) return;
    this.state = { ...this.state, focusPreview: { x: offset.x, y: offset.y, z: offset.z } };
    this.emit();
  }

  /**
   * 结束焦点手势：有净变化且可写时提交一次完整 `modelCameras` patch（从最新 working 列表
   * 重放该 camera 的 focusOffset，避免覆盖其它镜头）。
   */
  endFocus(): void {
    const preview = this.state.focusPreview;
    const selected = this.selectedCamera();
    const nodeId = this.state.nodeId;
    this.state = { ...this.state, focusPreview: null };
    const valid = this.deps.isWritable() && this.gestureCamera === JSON.stringify(selected);
    this.gestureCamera = null;
    if (!preview || !selected || !nodeId || !valid) {
      this.emit();
      return;
    }
    const current = modelCameraFocusOffset(selected);
    const changed =
      Math.abs(preview.x - current.x) > 1e-6 ||
      Math.abs(preview.y - current.y) > 1e-6 ||
      Math.abs(preview.z - current.z) > 1e-6;
    if (!changed) {
      this.emit();
      return;
    }
    const next = applyModelCameraMutation(this.cameras(), {
      kind: "upsert",
      camera: { ...selected, focusOffset: { x: preview.x, y: preview.y, z: preview.z } }
    });
    this.submitCameras(nodeId, next);
    this.emit();
  }

  /**
   * 截图前落定当前镜头：把还在预览里的方位、距离和注视点写入 `modelCameras`，
   * 使保存的数据和这一帧画面一致。
   */
  commitForCapture(): void {
    if (this.state.posePreview) this.endPose();
    if (this.state.focusPreview) this.endFocus();
  }

  /** Canonical changes invalidate a frozen gesture; unrelated cameras remain editable. */
  reconcileGesture(): void {
    if (!this.state.posePreview && !this.state.focusPreview) return;
    if (this.deps.isWritable() && this.gestureCamera === JSON.stringify(this.selectedCamera())) return;
    this.gestureCamera = null;
    this.state = { ...this.state, posePreview: null, focusPreview: null };
    this.emit();
  }

  /** 当前生效的镜头 focusOffset（preview 优先）。 */
  effectiveFocus(camera: ModelCamera): ModelCameraFocusOffset {
    if (this.state.focusPreview) return { ...this.state.focusPreview };
    return modelCameraFocusOffset(camera);
  }

  // ── 截图 ────────────────────────────────────────────────────────────────

  setCapturePreview(url: string | null): void {
    if (url === this.state.previewUrl) return;
    this.revokePreview();
    this.state = { ...this.state, previewUrl: url };
    this.emit();
  }

  setCapturePhase(phase: CapturePhase, error: string | null = null): void {
    this.state = { ...this.state, capturePhase: phase, captureError: error };
    this.emit();
  }

  get captureBusy(): boolean {
    return this.state.capturePhase === "rendering" || this.state.capturePhase === "uploading" || this.state.capturePhase === "submitting";
  }

  private revokePreview(): void {
    const url = this.state.previewUrl;
    if (url && this.deps.revokeObjectUrl) this.deps.revokeObjectUrl(url);
    this.state = { ...this.state, previewUrl: null };
  }

  private submitCameras(nodeId: string, cameras: readonly ModelCamera[]): boolean {
    if (!this.deps.isWritable()) return false;
    const value = cameras.map((camera) => ({ ...camera }));
    const submitted = this.deps.submitCameras(nodeId, value);
    if (submitted) this.optimisticCameras = { nodeId, value };
    return submitted;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameCameras(left: readonly ModelCamera[], right: readonly ModelCamera[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
