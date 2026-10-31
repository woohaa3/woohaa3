/**
 * 模型聚焦查看 Web 会话
 * （change: add-model-focus-viewing，任务 3.1–3.4；design D1/D5）。
 *
 * 把纯状态机（`@woohaa3/contracts` 的 `model-focus-state`）接到 canvas 交互：双击射线命中
 * canonical 模型进入聚焦、相机输入路由、Escape/失效退出并恢复。**只持有浏览器本地状态**：
 * 不写 ServerCanvas / CanvasCommand / Y.Doc，也不创建第二个 canvas 或模型副本。
 */
import {
  aabbCenterRadius,
  effectiveCanvasNodeSize,
  autoFrameDistance,
  clampPitch,
  normalizeYaw,
  beginGesture,
  beginModelGesture,
  filmSetFitFactor,
  filmSetLayoutBounds,
  filmSetNaturalScale,
  filmSetSceneAabb,
  getGroupLayoutSizes,
  isFilmSetNode,
  getWoohaa3CanvasNodeAbsolutePosition,
  enterFocus,
  exitFocus,
  finishGesture,
  finishModelGesture,
  focusCameraSnapshot,
  focusedNodeId,
  initialFocusState,
  invalidateTarget,
  isFocused,
  keyboardFly,
  modelAnchor,
  groupModelLayout,
  readFilmSetGroupMarker,
  activeFilmSetSceneBindings,
  readFilmSetContentForSession,
  encodeFilmSetPartId,
  quatFromEulerYXZDegrees,
  transformAabb,
  modelLayoutAabbRelative,
  modelWorldAabbRelative,
  moveGesture,
  reframeFocus,
  restoreFocusCamera,
  toProjection,
  wheelZoom,
  zoomFocusByFactor,
  MODEL_FOCUS_FOV,
  MODEL_FOCUS_LOOK_SENSITIVITY_DEG_PER_PX,
  type Aabb,
  type ModelFocusCamera,
  type ModelFocusProjection,
  type ModelFocusState,
  type PlacementDrag,
  type PlacementDraft,
  type ServerCanvas,
  type Vec3
} from "@woohaa3/contracts";

/** 聚焦目标解析输入。 */
export type FocusTargetInput = {
  capabilities?: import("@woohaa3/contracts").NodeCapabilities;
  canvas: ServerCanvas;
  nodeId: string;
  viewport: { x: number; y: number; zoom: number };
  surface: { width: number; height: number };
  /** 该节点的 Scene IR（浏览器执行 modelScript 得到）。 */
  sceneVersion: string;
  ops: readonly unknown[];
  extent: number;
  /** 已派生的模型局部 AABB（prepared resource 提供；缺省时按 ops 计算）。 */
  aabb?: import("@woohaa3/contracts").Aabb | null;
  placement: { offset: { x: number; y: number; z: number }; scale: number; yaw: number } | null;
  /**
   * 该目标是否为 feature 提供的**非 canonical 临时模型快照**（change: add-model-focus-editing，
   * 任务 3.4）。为 `true` 时禁止 placement 编辑（只允许相机查看）。
   */
  nonCanonical?: boolean;
};

export type ModelBounds = { aabb: Aabb; center: Vec3; radius: number; anchor: Vec3 };

function sceneInput(input: FocusTargetInput) {
  const node = input.canvas.document.nodes.find((entry) => entry.id === input.nodeId);
  const isFilmSet = input.capabilities ? !!input.capabilities.scope : isFilmSetNode(node?.type, input.canvas.nodeData?.[input.nodeId]);
  const size = node ? renderedModelNodeSize(node, input.canvas.nodeData?.[input.nodeId], input.capabilities) : null;
  const isGroup = node?.type === "group" && !!readFilmSetGroupMarker(input.canvas.nodeData?.[input.nodeId]);
  const position = node && isGroup ? getWoohaa3CanvasNodeAbsolutePosition(node, new Map(input.canvas.document.nodes.map(entry => [entry.id, entry]))) : null;
  const groupSize = isGroup && node ? getGroupLayoutSizes(input.canvas.document.nodes).get(node.id) : null;
  const groupWidth = groupSize?.width ?? node?.width;
  const groupHeight = groupSize?.height ?? node?.height;
  const groupLayout = isGroup && node && position && groupWidth !== undefined
    ? groupModelLayout({
      sceneVersion: input.sceneVersion,
      ops: input.ops as never,
      extent: input.extent,
      aabb: input.aabb ?? undefined,
      placement: input.placement,
      badgeTopAnchored: true,
      node: { x: position.x, y: position.y, width: groupWidth, height: groupHeight ?? node.height ?? 112 }
    })
    : null;
  return {
    sceneVersion: input.sceneVersion,
    ops: input.ops as never,
    extent: input.extent,
    aabb: input.aabb ?? undefined,
    placement: input.placement,
    filmSetFit: isFilmSet && size ? { width: size.width, height: size.height } : null,
    groupLayout
  };
}

/** 模型世界 AABB（含根锚点）；不可解析时返回 null。 */
export function modelBounds(input: FocusTargetInput): ModelBounds | null {
  const upright = modelWorldAabbRelative(sceneInput(input));
  const layout = modelLayoutAabbRelative(sceneInput(input));

  const node = input.canvas.document.nodes.find((entry) => entry.id === input.nodeId);
  if (!node) return null;
  const isFilmSet = input.capabilities ? !!input.capabilities.scope : isFilmSetNode(node.type, input.canvas.nodeData?.[input.nodeId]);
  const size = renderedModelNodeSize(node, input.canvas.nodeData?.[input.nodeId], input.capabilities);
  const position = getWoohaa3CanvasNodeAbsolutePosition(
    { ...node, data: {} }, new Map(input.canvas.document.nodes.map(entry => [entry.id, { ...entry, data: {} }]))
  );
  const offset = input.placement?.offset ?? { x: 0, y: 0, z: 0 };
  const group = sceneInput(input).groupLayout;
  if (group) {
    const local = groupSceneBounds(input);
    if (!local) {
      // 空片场（无可见绑定、也无地面）在组容器里同样要有可进入的聚焦工作区：以徽标锚点
      // 和节点矩形派生的默认半径取景，与复合资产空片场一致，不退化成「目标不可用」。
      const half = Math.max(1, Math.min(size.width, size.height) / 4);
      const aabb: Aabb = {
        min: [group.anchor[0] - half, group.anchor[1] - half, group.anchor[2] - half],
        max: [group.anchor[0] + half, group.anchor[1] + half, group.anchor[2] + half]
      };
      return { aabb, center: group.anchor, radius: Math.sqrt(3) * half, anchor: group.anchor };
    }
    const aabb = transformAabb({ translation: group.anchor, rotation: quatFromEulerYXZDegrees([0, input.placement?.yaw ?? 0, 0]), scale: [group.unit, group.unit, group.unit] }, local);
    const { center, radius } = aabbCenterRadius(aabb);
    return { aabb, center, radius, anchor: group.anchor };
  }
  const anchor = modelAnchor({
    nodeX: position.x,
    nodeY: position.y,
    nodeWidth: size.width,
    nodeHeight: size.height,
    relativeAabb: layout ?? { min: [0, 0, 0], max: [0, 0, 0] },
    offset,
    centered: isFilmSet
  });
  if (!upright || !layout) {
    if (!isFilmSet) return null;
    // An empty film set still has an editing workspace, anchored to its scope.
    const half = Math.max(1, Math.min(size.width, size.height) / 4);
    const aabb: Aabb = {
      min: [anchor[0] - half, anchor[1] - half, anchor[2] - half],
      max: [anchor[0] + half, anchor[1] + half, anchor[2] + half]
    };
    return { aabb, center: anchor, radius: Math.sqrt(3) * half, anchor };
  }
  const aabb: Aabb = {
    min: [upright.min[0] + anchor[0], upright.min[1] + anchor[1], upright.min[2] + anchor[2]],
    max: [upright.max[0] + anchor[0], upright.max[1] + anchor[1], upright.max[2] + anchor[2]]
  };
  const finite = [...aabb.min, ...aabb.max].every((value) => Number.isFinite(value));
  if (!finite) return null;
  const { center, radius } = aabbCenterRadius(aabb);
  return { aabb, center, radius, anchor };
}

/**
 * 节点在 Bevy 画面中的**实际卡片尺寸**：与 `buildCanvasRenderScene` 一致。
 *
 * 普通模型的旧紧凑尺寸扩展为内嵌预览卡片；复合资产使用规范基准矩形。
 * `modelAnchor` 必须用同一尺寸，否则命中/取景与画面漂移
 * （change: 2026-10-08-make-film-set-model-only 修订）。
 */
export function renderedModelNodeSize(node: {
  type: string;
  width?: number;
  height?: number;
}, _data?: unknown, capabilities?: import("@woohaa3/contracts").NodeCapabilities): { width: number; height: number } {
  return effectiveCanvasNodeSize(node, undefined, capabilities);
}

/**
 * 片场**场景空间**包围盒（场景单位，不含节点矩形适配）
 * （change: 2026-10-23-isolate-film-set-camera-space，design D1/D3）。
 *
 * 场景单位同时约束几何、媒体与镜头；节点矩形只决定呈现倍率。镜头默认取景、数值字段与手势都
 * 从这里的半径/中心派生，不再从节点像素尺寸反推保存值。`placement.scale` 是内容根倍率，属于
 * 场景单位的一部分（与 Rust `model_unit` 一致）。
 */
export function filmSetSceneBounds(input: FocusTargetInput): { aabb: Aabb; center: Vec3; radius: number } | null {
  const scene = filmSetSceneAabb(groupSceneBounds(input) ?? input.aabb ?? null);
  if (!scene) return null;
  const { center, radius } = aabbCenterRadius(scene);
  return { aabb: scene, center, radius };
}

/** Live binding placement is separate from the immutable resource used to fit the badge. */
function groupSceneBounds(input: FocusTargetInput): Aabb | null {
  const marker = readFilmSetGroupMarker(input.canvas.nodeData[input.nodeId]);
  if (!marker) return null;
  const activeBindings = activeFilmSetSceneBindings(marker);
  const visible = new Set(activeBindings.filter(binding => binding.visibility).map(binding => binding.bindingId));
  if (marker.ground) visible.add("film-set-ground");
  const hiddenPrefixes = activeBindings.filter(binding => !binding.visibility).map(binding => encodeFilmSetPartId(binding.bindingId, ""));
  const transform = marker.sceneTransform;
  const ops = (input.ops as import("@woohaa3/contracts").SceneV2Op[]).filter(op => !hiddenPrefixes.some(prefix => op.id.startsWith(prefix))).map(op =>
    op.t === "group" && op.id === "\u0000scene" && transform
      ? { ...op, position: [transform.x, transform.y, transform.z] as [number, number, number], rotation: [0, transform.yaw * 180 / Math.PI, 0] as [number, number, number], scale: [transform.scale, transform.scale, transform.scale] as [number, number, number] }
      : op
  );
  const content = readFilmSetContentForSession(input.canvas, input.nodeId);
  return filmSetLayoutBounds(ops, { ...content, items: content.items.filter(item => visible.has(item.id)) }, input.extent, true);
}

/**
 * 片场场景 → 画布世界的显示倍率（= `model_unit`：自然单位 × 节点矩形容器适配）。
 *
 * 节点矩形适配只在这里出现一次；镜头与内容共用它，构图因此与呈现尺寸无关。
 */
export function filmSetDisplayScale(input: FocusTargetInput): number {
  const group = sceneInput(input).groupLayout;
  if (group) return group.unit;
  const natural = filmSetNaturalScale(input.placement, input.extent);
  const size = renderedModelNodeSize(
    input.canvas.document.nodes.find((entry) => entry.id === input.nodeId) ?? { type: "composite-asset" },
    input.canvas.nodeData?.[input.nodeId]
  );
  const fit = filmSetFitFactor({ ...sceneInput(input), filmSetFit: { width: size.width, height: size.height } }, { width: size.width, height: size.height });
  return natural * fit;
}

/** 片场场景 → 画布世界的显示旋转（仅 placement yaw）。 */
export function filmSetDisplayRotation(input: FocusTargetInput): number {
  const yaw = input.placement?.yaw ?? 0;
  return Number.isFinite(yaw) ? (yaw * Math.PI) / 180 : 0;
}

export type FocusHitResult =
  | { ok: true; nodeId: string; target: Vec3; radius: number }
  | { ok: false; reason: string };

/**
 * 普通画布模型 picking 已迁至 Rust interaction state（`BevyRuntime.queryModelPick`）
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2/5.5）。
 *
 * 旧 TS `hitModelAtScreen`（orthoRay + rayIntersectsAabb）已删除：命中与绘制共用同一 Rust
 * 相机、bounds 与 placement 事实源，避免 f32/f64 与采样漂移。本文件只保留由 Rust 返回 bounds
 * 驱动的纯取景计算（`framingDistance`）与目标解析。
 */

/** 由目标包围球与当前 aspect 计算自动取景距离（与 Rust 取景一致）。 */
export function framingDistance(radius: number, surface: { width: number; height: number }): number {
  const aspect = surface.height > 0 ? surface.width / surface.height : 1;
  return autoFrameDistance(radius, MODEL_FOCUS_FOV, aspect);
}

/**
 * 当前聚焦目标（change: add-model-focus-editing，任务 2.1/3.4）。
 *
 * 返回命中的 canonical/working 目标与其实时 bounds/placement；缺失时返回 `null`
 * （目标失效或为非 canonical 临时快照 → 禁用编辑）。
 */
export function focusedTarget(
  targets: readonly FocusTargetInput[],
  nodeId: string
): FocusTargetInput | null {
  return targets.find((target) => target.nodeId === nodeId) ?? null;
}

/** 聚焦会话：状态机 + 输入适配；不依赖 DOM。 */
export class ModelFocusSession {
  private state: ModelFocusState = initialFocusState();
  private pointerId: number | null = null;
  /** 右侧抽屉实际占用宽度（本地 content rect）；0 表示无遮挡。 */
  private contentRectRight = 0;
  private contentRectLeft = 0;
  private contentRectTop = 0;
  private contentRectBottom = 0;
  /** 最近一次取景使用的 surface 高度（用于 content rect → 世界偏移）。 */
  private contentSurfaceHeight = 1;

  get active(): boolean {
    return isFocused(this.state);
  }

  get nodeId(): string | null {
    return focusedNodeId(this.state);
  }

  projection(): ModelFocusProjection | null {
    const projection = toProjection(this.state);
    if (!projection) return projection;
    // 把聚焦目标向相机右侧平移半个遮挡宽度对应的世界距离：模型因此落在未遮挡左区中心。
    const right = Math.cos(projection.yaw);
    const rightZ = -Math.sin(projection.yaw);
    const worldPerPixel = (2 * projection.distance * Math.tan(projection.fov / 2)) / Math.max(1, this.contentSurfaceHeight);
    const offset = ((this.contentRectRight - this.contentRectLeft) / 2) * worldPerPixel;
    const vertical = ((this.contentRectTop - this.contentRectBottom) / 2) * worldPerPixel;
    const up = [Math.sin(projection.yaw) * Math.sin(projection.pitch), Math.cos(projection.pitch), Math.cos(projection.yaw) * Math.sin(projection.pitch)];
    return {
      ...projection,
      target: [
        projection.target[0] + right * offset + up[0]! * vertical,
        projection.target[1] + up[1]! * vertical,
        projection.target[2] + rightZ * offset + up[2]! * vertical
      ]
    };
  }

  /**
   * 更新右侧遮挡宽度（CSS content rect）。
   * 返回是否变化；只影响本地取景，不修改 canonical 模型或 placement。
   */
  setContentRect(rect: { right: number; left?: number; top?: number; bottom?: number; surfaceHeight?: number }): boolean {
    const right = Number.isFinite(rect.right) ? Math.max(0, rect.right) : 0;
    const surfaceHeight = Number.isFinite(rect.surfaceHeight) ? Math.max(1, rect.surfaceHeight as number) : this.contentSurfaceHeight;
    const left = Math.max(0, rect.left ?? 0);
    const top = Math.max(0, rect.top ?? 0);
    const bottom = Math.max(0, rect.bottom ?? 0);
    if (right === this.contentRectRight && left === this.contentRectLeft && top === this.contentRectTop && bottom === this.contentRectBottom && surfaceHeight === this.contentSurfaceHeight) return false;
    this.contentRectLeft = left;
    this.contentRectTop = top;
    this.contentRectBottom = bottom;
    this.contentRectRight = right;
    this.contentSurfaceHeight = surfaceHeight;
    return true;
  }

  framingDistance(radius: number, surface: { width: number; height: number }): number {
    const width = Math.max(1, surface.width - this.contentRectLeft - this.contentRectRight);
    const height = Math.max(1, surface.height - this.contentRectTop - this.contentRectBottom);
    return framingDistance(radius, { width, height }) * surface.height / height;
  }

  enter(input: { nodeId: string; target: Vec3; radius: number; distance: number; saved: unknown }): boolean {
    this.state = enterFocus(this.state, {
      nodeId: input.nodeId,
      target: input.target,
      radius: input.radius,
      distance: input.distance,
      savedProjection2d: input.saved
    });
    return isFocused(this.state);
  }

  /**
   * 重新取景（change: fix-model-focus-navigation-and-camera-parity，design D4）。
   *
   * 无快照副作用：只更新目标/半径与可选 distance，取消活动 gesture；`savedProjection2d`
   * 与进入快照不变。返回是否有净变化。
   */
  reframe(input: { nodeId?: string; target: Vec3; radius: number; distance?: number }): boolean {
    const before = this.state;
    this.state = reframeFocus(this.state, input);
    return before !== this.state;
  }

  /** 保存当前聚焦相机（owner 切换为 history 时）；未聚焦返回 null。 */
  cameraSnapshot(): ModelFocusCamera | null {
    const snapshot = focusCameraSnapshot(this.state);
    return snapshot ? { ...snapshot, target: [...snapshot.target] } : null;
  }

  /** 恢复此前保存的聚焦相机（history -> direct）；返回是否有变化。 */
  restoreCamera(camera: ModelFocusCamera): boolean {
    const before = this.state;
    this.state = restoreFocusCamera(this.state, camera);
    return before !== this.state;
  }

  /** 退出并返回进入快照（供宿主恢复 2D viewport/Camera3d）。 */
  exit(): { restored: unknown } {
    const { state, restored } = exitFocus(this.state);
    this.state = state;
    this.pointerId = null;
    return { restored };
  }

  /** 目标失效（权威投影移除目标 / 模型快照失效）→ 自动退出；返回是否退出。 */
  syncValidTargets(validNodeIds: ReadonlySet<string>): boolean {
    const before = this.state;
    this.state = invalidateTarget(this.state, validNodeIds);
    if (before !== this.state) {
      this.pointerId = null;
      return true;
    }
    return false;
  }

  beginPointer(button: number, pointerId: number, x: number, y: number): boolean {
    if (!isFocused(this.state)) return false;
    const kind = button === 2 ? "look" : button === 1 ? "pan" : "none";
    if (kind === "none") return false;
    this.pointerId = pointerId;
    this.state = beginGesture(this.state, { kind, pointerId, x, y });
    return true;
  }

  /** 双指滑动旋转观察相机；与右键拖动共用灵敏度与角度边界。 */
  rotateBy(dx: number, dy: number): boolean {
    if (this.state.phase !== "focused" || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const step = (MODEL_FOCUS_LOOK_SENSITIVITY_DEG_PER_PX * Math.PI) / 180;
    const camera = this.state.camera;
    const yaw = normalizeYaw(camera.yaw - dx * step);
    const pitch = clampPitch(camera.pitch - dy * step);
    if (yaw === camera.yaw && pitch === camera.pitch) return false;
    this.state = { ...this.state, camera: { ...camera, yaw, pitch } };
    return true;
  }

  /**
   * 开始模型 placement 手势（change: add-model-focus-editing，任务 2.1/2.2/2.3）。
   *
   * `drag` 由调用方在 ray/AABB 命中后经 `beginPlacementDrag` 构造；为 `null` 时不改变状态，
   * 调用方可回落到相机手势。模型手势优先级最高（可覆盖已存在的相机手势）。
   */
  beginModelPointer(pointerId: number, drag: PlacementDrag | null): boolean {
    if (!isFocused(this.state) || !drag) return false;
    this.pointerId = pointerId;
    this.state = beginModelGesture(this.state, { pointerId, drag });
    return true;
  }

  /** 当前 model placement 手势的瞬时 preview；非 model 手势返回 null。 */
  modelPreview(): PlacementDraft | null {
    if (this.state.phase !== "focused") return null;
    return this.state.modelPreview ?? null;
  }

  /**
   * 指针移动。`surface` 仅在 model 手势时需要（ray-plane 求交与 offset 逆换算）；
   * 相机手势忽略它。placement offset 使用固定 64 单位，不读取 viewport zoom
   * （change: make-shot-framing-zoom-invariant，任务 4.1）。
   */
  movePointer(
    pointerId: number,
    x: number,
    y: number,
    surfaceHeight: number,
    surface?: { width: number; height: number }
  ): boolean {
    const before = this.state;
    const modelInput =
      this.state.phase === "focused" && surface
        ? { surface, camera: this.state.camera }
        : undefined;
    this.state = moveGesture(this.state, pointerId, x, y, surfaceHeight, modelInput);
    return before !== this.state;
  }

  endPointer(pointerId?: number): void {
    this.state = finishGesture(this.state, pointerId);
    if (pointerId === undefined || this.pointerId === pointerId) this.pointerId = null;
  }

  /**
   * 结束 model 手势并返回 `{ origin, preview }`（供完成点单次提交判定）；非 model 手势返回 null。
   */
  endModelPointer(pointerId: number): { origin: PlacementDraft; preview: PlacementDraft } | null {
    const result = finishModelGesture(this.state, pointerId);
    this.state = result.state;
    if (pointerId === this.pointerId) this.pointerId = null;
    if (!result.origin || !result.preview) return null;
    return { origin: result.origin, preview: result.preview };
  }

  wheel(deltaY: number, options: { rightDown: boolean }): boolean {
    const before = this.state;
    this.state = wheelZoom(this.state, deltaY, options);
    return before !== this.state;
  }

  fly(
    held: { forward: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean },
    modifiers: { fast: boolean; slow: boolean },
    deltaSeconds: number
  ): boolean {
    if (!isFocused(this.state)) return false;
    const before = this.state;
    this.state = keyboardFly(
      this.state,
      {
        forward: (held.forward ? 1 : 0) - (held.back ? 1 : 0),
        right: (held.right ? 1 : 0) - (held.left ? 1 : 0),
        up: (held.up ? 1 : 0) - (held.down ? 1 : 0)
      },
      modifiers,
      deltaSeconds
    );
    return before !== this.state;
  }

  /** 清理 held input（blur / modal / cancel），保留聚焦。 */
  clearHeld(): void {
    this.state = finishGesture(this.state);
    this.pointerId = null;
  }

  /**
   * 连续缩放主观察相机（change: 对齐 xyflow-bevy 聚焦导航）。
   *
   * 用于触控板捏合 / Chromium ctrl-wheel / Safari `GestureEvent`：`factor > 1` 放大。
   * 只改相机 distance，不写规范数据；返回是否有净变化。
   */
  zoomBy(factor: number): boolean {
    const before = this.state;
    this.state = zoomFocusByFactor(this.state, factor);
    return before !== this.state;
  }

  /** 当前是否有活动的 model placement 手势（含 preview）。 */
  get hasModelGesture(): boolean {
    return this.state.phase === "focused" && this.state.gesture.kind === "model";
  }
}
