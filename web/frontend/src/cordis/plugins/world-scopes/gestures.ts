/**
 * 场景区手势运行时（T07 scope gestures）。
 *
 * 浏览器只做三件事：把指针换算成地面坐标、按准备快照生成纯请求、把结果交给权威
 * `scene-area-prepare/commit/undo/redo`。这里不判断“谁有资格”、不写占用、不伪造
 * 权限，也不自己改规范画布：
 *
 * - 普通拖动 = `move`，成员集合固定为 prepare 返回的可写实例与区内镜头；高度、旋转、
 *   缩放由 OC04 规划保留。
 * - 边缘拖动 / 显式“仅调整范围” / 修饰键 = `resize`，只改 bounds。
 * - 删除默认只移除范围；显式“连同内容删除”才删除固定可写成员，素材与任务不动。
 *
 * 撤销/重做同样走权威 `scene-area-undo/redo`，但被采纳进页面级 `CanvasEditService`
 * 的同一条撤销时间线（`recordExternal`）：回执确认后只保存 replay 回调，成功才推进
 * 指针。只有没有页面 journal 的测试/独立宿主才退回有界 operationId 栈。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  createHighEntropyId,
  decodeSceneAreaData,
  planSceneAreaOperation,
  type GroundAabb,
  type GroundPoint,
  type SceneAreaData,
  type SceneAreaPlanIntent,
  type SceneAreaPlanRequest,
  type ServerCanvas,
  type WorldAuthoringConflict,
  type WorldAuthoringExecuteInput,
  type WorldAuthoringExecuteOutcome,
  type WorldAuthoringHistoryInput,
  type WorldAuthoringHistoryOutcome,
  type WorldAuthoringPrepareOutcome,
  type WorldPreparedAuthoritySnapshot
} from "@woohaa3/contracts";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";

export type SceneAreaPoint = { x: number; y: number };
export type SceneAreaDragMode = "auto" | "move" | "resize";
export type SceneAreaGestureIntent = "move" | "resize";
export type SceneAreaGesturePhase = "idle" | "preparing" | "moving" | "resizing" | "committing" | "cancelled" | "failed";

/** 手势边缘：-1 = min 侧，1 = max 侧，0 = 该轴不动。 */
export type SceneAreaEdge = { u: -1 | 0 | 1; v: -1 | 0 | 1 };

/** 屏幕边缘命中容差的地面近似值（米）；真实调用按当前缩放换算。 */
export const SCENE_AREA_EDGE_TOLERANCE_METERS = 0.18;
/** 范围最小边长（米），只用于指针预览，权威仍按完整请求校验。 */
export const SCENE_AREA_MIN_SIZE_METERS = 0.25;

export type SceneAreaGestureSnapshot = {
  phase: SceneAreaGesturePhase;
  intent: SceneAreaPlanIntent | null;
  areaNodeId: string | null;
  delta: GroundPoint | null;
  bounds: GroundAabb | null;
  message: string | null;
  conflicts: WorldAuthoringConflict[];
};

const IDLE_STATE: SceneAreaGestureSnapshot = {
  phase: "idle",
  intent: null,
  areaNodeId: null,
  delta: null,
  bounds: null,
  message: null,
  conflicts: []
};

function sameState(left: SceneAreaGestureSnapshot, right: SceneAreaGestureSnapshot): boolean {
  return left.phase === right.phase
    && left.intent === right.intent
    && left.areaNodeId === right.areaNodeId
    && left.message === right.message
    && sameGround(left.delta, right.delta)
    && sameBounds(left.bounds, right.bounds)
    && left.conflicts.length === right.conflicts.length;
}

function sameGround(left: GroundPoint | null, right: GroundPoint | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.u === right.u && left.v === right.v;
}

function sameBounds(left: GroundAabb | null, right: GroundAabb | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.min.u === right.min.u && left.min.v === right.min.v
    && left.max.u === right.max.u && left.max.v === right.max.v;
}

/** 当前场景手势（控件与快捷键提示订阅）。 */
class SceneAreaGestureStore {
  private value: SceneAreaGestureSnapshot = IDLE_STATE;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): SceneAreaGestureSnapshot => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(next: SceneAreaGestureSnapshot): void {
    if (sameState(this.value, next)) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.set(IDLE_STATE);
  }
}

/** 显式模式（Pad 可见入口；默认跟随指针落点）。 */
class SceneAreaModeStore {
  private value: SceneAreaDragMode = "auto";
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): SceneAreaDragMode => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(mode: SceneAreaDragMode): void {
    if (this.value === mode) return;
    this.value = mode;
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.set("auto");
  }
}

export type SceneAreaHistoryEntry = {
  operationId: string;
  canvasId: string;
  intent: SceneAreaPlanIntent;
  label: string;
};

export type SceneAreaHistorySnapshot = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  size: number;
};

/**
 * 有界场景历史。只记权威 operationId；不做本地反向编辑。
 * 非场景编辑可能插在中间，权威会用 command chain 拒绝过期回执，本栈保留条目并上报原因。
 */
class SceneAreaHistoryStore {
  private entries: SceneAreaHistoryEntry[] = [];
  private index = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): SceneAreaHistorySnapshot {
    const undo = this.entries[this.index - 1] ?? null;
    const redo = this.entries[this.index] ?? null;
    return {
      canUndo: !!undo,
      canRedo: !!redo,
      undoLabel: undo?.label ?? null,
      redoLabel: redo?.label ?? null,
      size: this.entries.length
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  record(entry: SceneAreaHistoryEntry): void {
    const previous = this.entries[this.index - 1];
    if (previous?.operationId === entry.operationId && previous.canvasId === entry.canvasId) return;
    this.entries = this.entries.slice(0, this.index);
    this.entries.push(entry);
    if (this.entries.length > 50) this.entries = this.entries.slice(this.entries.length - 50);
    this.index = this.entries.length;
    this.emit();
  }

  entryForUndo(canvasId: string | undefined): SceneAreaHistoryEntry | null {
    for (let offset = -1; this.index + offset >= 0; offset -= 1) {
      const entry = this.entries[this.index + offset]!;
      if (entry.canvasId === canvasId) return entry;
    }
    return null;
  }

  entryForRedo(canvasId: string | undefined): SceneAreaHistoryEntry | null {
    for (let offset = 0; this.index + offset < this.entries.length; offset += 1) {
      const entry = this.entries[this.index + offset]!;
      if (entry.canvasId === canvasId) return entry;
    }
    return null;
  }

  markUndone(): void {
    if (this.index > 0) {
      this.index -= 1;
      this.emit();
    }
  }

  markRedone(): void {
    if (this.index < this.entries.length) {
      this.index += 1;
      this.emit();
    }
  }

  clear(): void {
    if (!this.entries.length && this.index === 0) return;
    this.entries = [];
    this.index = 0;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const sceneAreaGestureStore = new SceneAreaGestureStore();
export const sceneAreaModeStore = new SceneAreaModeStore();
export const sceneAreaHistoryStore = new SceneAreaHistoryStore();

/**
 * 纯指针决策：卡片默认搬场景；Alt / 显式 resize / 边缘拖动只改范围。
 * `auto` 模式下区域内部空白返回 `null`，让既有框选继续工作。
 */
export function decideSceneAreaDrag(input: {
  mode: SceneAreaDragMode;
  card: boolean;
  altKey: boolean;
  bounds: GroundAabb;
  ground: GroundPoint;
  tolerance: number;
}): { intent: SceneAreaGestureIntent; edge?: SceneAreaEdge } | null {
  const { mode, card, altKey, bounds, ground, tolerance } = input;
  if (card) {
    if (mode === "resize" || altKey) return { intent: "resize", edge: nearestSceneAreaEdge(bounds, ground) };
    return { intent: "move" };
  }
  if (!groundInsideBounds(bounds, ground)) return null;
  const edge = locateSceneAreaEdge(bounds, ground, tolerance);
  // 修饰键是显式意图：即使指针在区域内部，也只调整范围。
  if (altKey) return { intent: "resize", edge: edge ?? nearestSceneAreaEdge(bounds, ground) };
  if (mode === "move") return { intent: "move" };
  if (mode === "resize") return { intent: "resize", edge: edge ?? nearestSceneAreaEdge(bounds, ground) };
  return edge ? { intent: "resize", edge } : null;
}

export function groundInsideBounds(bounds: GroundAabb, point: GroundPoint): boolean {
  return point.u >= bounds.min.u && point.u <= bounds.max.u
    && point.v >= bounds.min.v && point.v <= bounds.max.v;
}

/** 命中区域边缘（含角）；不在区域内或离边缘超过容差时返回 null。 */
export function locateSceneAreaEdge(bounds: GroundAabb, point: GroundPoint, tolerance: number): SceneAreaEdge | null {
  if (!groundInsideBounds(bounds, point) || !Number.isFinite(tolerance) || tolerance <= 0) return null;
  const nearU = Math.min(point.u - bounds.min.u, bounds.max.u - point.u) <= tolerance;
  const nearV = Math.min(point.v - bounds.min.v, bounds.max.v - point.v) <= tolerance;
  if (!nearU && !nearV) return null;
  const u: -1 | 0 | 1 = nearU ? (point.u - bounds.min.u <= bounds.max.u - point.u ? -1 : 1) : 0;
  const v: -1 | 0 | 1 = nearV ? (point.v - bounds.min.v <= bounds.max.v - point.v ? -1 : 1) : 0;
  return { u, v };
}

/** 最近的角/边；卡片 Alt 拖动与显式范围模式使用，不要求指针已在区域内部。 */
export function nearestSceneAreaEdge(bounds: GroundAabb, point: GroundPoint): SceneAreaEdge {
  const u: -1 | 1 = point.u - bounds.min.u <= bounds.max.u - point.u ? -1 : 1;
  const v: -1 | 1 = point.v - bounds.min.v <= bounds.max.v - point.v ? -1 : 1;
  return { u, v };
}

/** 按边缘增量得到新 bounds；只移动被拖的边，并保证最小尺寸。 */
export function resizeSceneAreaBounds(
  bounds: GroundAabb,
  edge: SceneAreaEdge,
  delta: GroundPoint,
  minSize = SCENE_AREA_MIN_SIZE_METERS
): GroundAabb {
  const next: GroundAabb = {
    min: { u: bounds.min.u, v: bounds.min.v },
    max: { u: bounds.max.u, v: bounds.max.v }
  };
  if (edge.u < 0) next.min.u = bounds.min.u + delta.u;
  if (edge.u > 0) next.max.u = bounds.max.u + delta.u;
  if (edge.v < 0) next.min.v = bounds.min.v + delta.v;
  if (edge.v > 0) next.max.v = bounds.max.v + delta.v;
  if (next.max.u - next.min.u < minSize) {
    if (edge.u < 0) next.min.u = next.max.u - minSize;
    else if (edge.u > 0) next.max.u = next.min.u + minSize;
  }
  if (next.max.v - next.min.v < minSize) {
    if (edge.v < 0) next.min.v = next.max.v - minSize;
    else if (edge.v > 0) next.max.v = next.min.v + minSize;
  }
  return next;
}

/**
 * 从 prepare 快照生成权威请求。成员集合保持快照固定值，不吸收拖拽途中扫到的对象。
 */
export function buildSceneAreaRequest(input: {
  canvasId: string;
  operationId: string;
  snapshot: WorldPreparedAuthoritySnapshot;
  intent: SceneAreaPlanIntent;
  delta?: GroundPoint;
  bounds?: GroundAabb;
}): { ok: true; request: SceneAreaPlanRequest } | { ok: false; reason: string } {
  const { canvasId, operationId, snapshot, intent } = input;
  if (!canvasId || !operationId) return { ok: false, reason: "场景操作身份缺失" };
  if (!snapshot.area.areaId || !snapshot.area.scopeVersion) return { ok: false, reason: "场景区版本未就绪" };
  const base = {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId,
    operationId,
    area: snapshot.area,
    members: snapshot.members
  } as const;
  if (intent === "move") {
    const delta = input.delta;
    if (!delta || !Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return { ok: false, reason: "移动距离无效" };
    return { ok: true, request: { ...base, intent: "move", delta: { u: delta.u, v: delta.v } } };
  }
  if (intent === "resize") {
    const bounds = input.bounds;
    if (!bounds || ![bounds.min.u, bounds.min.v, bounds.max.u, bounds.max.v].every(Number.isFinite)) {
      return { ok: false, reason: "范围无效" };
    }
    if (bounds.min.u > bounds.max.u || bounds.min.v > bounds.max.v) return { ok: false, reason: "范围边界无效" };
    return {
      ok: true,
      request: { ...base, intent: "resize", bounds: { min: { ...bounds.min }, max: { ...bounds.max } } }
    };
  }
  return { ok: true, request: { ...base, intent } };
}

export type SceneAreaGestureBeginInput = {
  point: SceneAreaPoint;
  /** 卡片命中时传入；地面空白由运行时按地面坐标寻找。 */
  areaNodeId?: string | null;
  /** 指针是否落在区域卡片本体。 */
  card: boolean;
  altKey?: boolean;
  /** 优先使用的已选区域（重叠时稳定选择）。 */
  preferredAreaNodeId?: string | null;
  mode?: SceneAreaDragMode;
};

export type SceneAreaGestureResult =
  | { ok: true; operationId: string; intent: SceneAreaPlanIntent; receipt: import("@woohaa3/contracts").WorldAuthoringReceipt }
  | { ok: true; noop: true }
  | { ok: false; code: string; message: string; conflicts?: WorldAuthoringConflict[] };

export type SceneAreaAdoptedHistory = {
  operationId: string;
  canvasId: string;
  intent: SceneAreaPlanIntent;
  label: string;
  undo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  redo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type SceneAreaGestureDeps = {
  canvasId: () => string | undefined;
  writable: () => boolean;
  getCanvas: () => ServerCanvas | null;
  prepare: (areaId: string, signal?: AbortSignal) => Promise<WorldAuthoringPrepareOutcome>;
  execute: (input: WorldAuthoringExecuteInput, signal?: AbortSignal) => Promise<WorldAuthoringExecuteOutcome>;
  history: (direction: "undo" | "redo", input: WorldAuthoringHistoryInput, signal?: AbortSignal) => Promise<WorldAuthoringHistoryOutcome>;
  /**
   * Adopt a verified scene-area receipt into the page journal. When present, the
   * local operation-id stack is not used: global Ctrl+Z owns this action.
   */
  adoptHistory?: (entry: SceneAreaAdoptedHistory) => { ok: boolean; reason?: string };
  queryGround: (point: SceneAreaPoint) => GroundPoint | null;
  /** 只预览可写实例的地面位移；相机没有对应的地面预览通道。 */
  preview: (nodeId: string, delta: GroundPoint | null) => void;
  mode?: () => SceneAreaDragMode;
  tolerance?: (point: SceneAreaPoint) => number;
  newOperationId?: (prefix: string) => string;
};

export type SceneAreaGestureStart = { areaNodeId: string; intent: SceneAreaGestureIntent };

export type SceneAreaGesturePort = {
  begin(input: SceneAreaGestureBeginInput): SceneAreaGestureStart | null;
  update(point: SceneAreaPoint): boolean;
  end(): Promise<SceneAreaGestureResult>;
  cancel(): void;
  active(): boolean;
  deleteArea(areaNodeId: string, withContents: boolean): Promise<SceneAreaGestureResult>;
  undo(): Promise<SceneAreaGestureResult>;
  redo(): Promise<SceneAreaGestureResult>;
};

type ActiveGesture = {
  areaNodeId: string;
  canvasId: string;
  scopeVersion: string;
  intent: SceneAreaGestureIntent;
  edge: SceneAreaEdge;
  startGround: GroundPoint;
  startBounds: GroundAabb;
  delta: GroundPoint;
  bounds: GroundAabb;
  abort: AbortController;
  prepared: Promise<WorldAuthoringPrepareOutcome>;
  snapshot: WorldPreparedAuthoritySnapshot | null;
  prepareMessage: string | null;
  previewed: Set<string>;
  ending: boolean;
  committing: boolean;
};

const MOVE_LABEL = "搬动场景";
const RESIZE_LABEL = "调整场景范围";
const DELETE_LABEL = "删除场景区";
const DELETE_CONTENTS_LABEL = "删除场景区与内容";

function labelFor(intent: SceneAreaPlanIntent): string {
  switch (intent) {
    case "move": return MOVE_LABEL;
    case "resize": return RESIZE_LABEL;
    case "delete-area": return DELETE_LABEL;
    default: return DELETE_CONTENTS_LABEL;
  }
}

function areaOf(canvas: ServerCanvas, nodeId: string): SceneAreaData | null {
  const decoded = decodeSceneAreaData(canvas.nodeData[nodeId]?.sceneArea);
  return decoded.ok ? decoded.value : null;
}

function containingAreas(canvas: ServerCanvas, ground: GroundPoint): string[] {
  return canvas.document.nodes.flatMap(node => {
    const area = areaOf(canvas, node.id);
    if (!area) return [];
    const { min, max } = area.bounds;
    return ground.u >= min.u && ground.u <= max.u && ground.v >= min.v && ground.v <= max.v ? [node.id] : [];
  }).sort();
}

function instanceNodeIds(snapshot: WorldPreparedAuthoritySnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const object of snapshot.objects) {
    if (object.identity.kind === "instance" && object.nodeId) map.set(object.identity.instanceId, object.nodeId);
  }
  return map;
}

export function createSceneAreaGestures(deps: SceneAreaGestureDeps): SceneAreaGesturePort {
  let active: ActiveGesture | null = null;
  const newOperationId = (prefix: string) => deps.newOperationId?.(prefix) ?? createHighEntropyId(prefix);

  /**
   * Replay one frozen receipt through the authoritative history route. Only an
   * exact canvas/operation/direction receipt may move the shared journal cursor.
   */
  const replayHistory = async (
    direction: "undo" | "redo",
    entry: { canvasId: string; operationId: string }
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    let outcome: WorldAuthoringHistoryOutcome;
    try {
      outcome = await deps.history(direction, { canvasId: entry.canvasId, operationId: entry.operationId });
    } catch {
      return { ok: false, reason: "场景历史请求失败" };
    }
    if (!outcome.ok) return { ok: false, reason: outcome.message };
    if (outcome.canvasId !== entry.canvasId
      || outcome.operationId !== entry.operationId
      || outcome.direction !== direction) {
      return { ok: false, reason: "场景历史回执不匹配" };
    }
    return { ok: true };
  };

  const retainHistory = (entry: Omit<SceneAreaAdoptedHistory, "undo" | "redo">): void => {
    if (deps.adoptHistory) {
      // The authoritative commit already succeeded. Adoption is synchronous and only
      // stores verified callbacks; a busy/unwritable journal must not fake success.
      deps.adoptHistory({
        ...entry,
        undo: () => replayHistory("undo", entry),
        redo: () => replayHistory("redo", entry)
      });
      return;
    }
    // Standalone/test fallback: bounded operation-id stack behind the explicit panel.
    sceneAreaHistoryStore.record(entry);
  };

  const setState = (next: Partial<SceneAreaGestureSnapshot> & Pick<SceneAreaGestureSnapshot, "phase">): void => {
    sceneAreaGestureStore.set({
      phase: next.phase,
      intent: next.intent ?? null,
      areaNodeId: next.areaNodeId ?? null,
      delta: next.delta ?? null,
      bounds: next.bounds ?? null,
      message: next.message ?? null,
      conflicts: next.conflicts ?? []
    });
  };

  const clearPreview = (gesture: ActiveGesture): void => {
    for (const nodeId of gesture.previewed) deps.preview(nodeId, null);
    gesture.previewed.clear();
  };

  const applyPreview = (gesture: ActiveGesture): void => {
    if (!gesture.snapshot || gesture.intent !== "move") return;
    const nodeIdByInstance = instanceNodeIds(gesture.snapshot);
    const next = new Set<string>();
    for (const member of gesture.snapshot.members.instances) {
      const nodeId = nodeIdByInstance.get(member.identity.instanceId);
      if (!nodeId) continue;
      deps.preview(nodeId, { u: gesture.delta.u, v: gesture.delta.v });
      next.add(nodeId);
    }
    for (const nodeId of gesture.previewed) if (!next.has(nodeId)) deps.preview(nodeId, null);
    gesture.previewed = next;
  };

  const publish = (gesture: ActiveGesture, phase: SceneAreaGesturePhase): void => {
    setState({
      phase,
      intent: gesture.intent,
      areaNodeId: gesture.areaNodeId,
      delta: gesture.delta,
      bounds: gesture.bounds,
      message: gesture.prepareMessage
    });
  };

  const startPrepare = (gesture: ActiveGesture): Promise<WorldAuthoringPrepareOutcome> => {
    const promise = deps.prepare(gesture.areaNodeId, gesture.abort.signal).then(outcome => {
      if (active !== gesture) return outcome;
      if (!outcome.ok) {
        gesture.prepareMessage = outcome.message;
        publish(gesture, gesture.intent === "move" ? "moving" : "resizing");
        return outcome;
      }
      const snapshot = outcome.snapshot;
      if (snapshot.canvasId !== gesture.canvasId
        || snapshot.area.areaId !== gesture.areaNodeId
        || snapshot.area.scopeVersion !== gesture.scopeVersion) {
        gesture.prepareMessage = "场景上下文已过期，请重新开始";
        publish(gesture, gesture.intent === "move" ? "moving" : "resizing");
        return { ok: false, code: "version-conflict", message: gesture.prepareMessage } as WorldAuthoringPrepareOutcome;
      }
      gesture.snapshot = snapshot;
      gesture.prepareMessage = null;
      applyPreview(gesture);
      publish(gesture, gesture.intent === "move" ? "moving" : "resizing");
      return outcome;
    }).catch(() => {
      if (active === gesture) {
        gesture.prepareMessage = "无法读取场景上下文";
        publish(gesture, gesture.intent === "move" ? "moving" : "resizing");
      }
      return { ok: false, code: "not-ready", message: "无法读取场景上下文" } as WorldAuthoringPrepareOutcome;
    });
    return promise;
  };

  const begin = (input: SceneAreaGestureBeginInput): SceneAreaGestureStart | null => {
    const canvasId = deps.canvasId();
    const canvas = deps.getCanvas();
    if (!canvasId || !canvas || !deps.writable()) return null;
    const ground = deps.queryGround(input.point);
    if (!ground) return null;
    const mode = input.mode ?? deps.mode?.() ?? sceneAreaModeStore.getSnapshot();
    const candidates = containingAreas(canvas, ground);
    let areaNodeId = input.areaNodeId ?? null;
    if (!areaNodeId) {
      const preferred = input.preferredAreaNodeId && candidates.includes(input.preferredAreaNodeId)
        ? input.preferredAreaNodeId : null;
      areaNodeId = preferred ?? candidates[0] ?? null;
    }
    if (!areaNodeId) return null;
    const area = areaOf(canvas, areaNodeId);
    if (!area) return null;
    const tolerance = deps.tolerance?.(input.point) ?? SCENE_AREA_EDGE_TOLERANCE_METERS;
    const decision = decideSceneAreaDrag({
      mode,
      card: input.card && !!input.areaNodeId && input.areaNodeId === areaNodeId,
      altKey: !!input.altKey,
      bounds: area.bounds,
      ground,
      tolerance
    });
    if (!decision) return null;
    cancel();
    const gesture: ActiveGesture = {
      areaNodeId,
      canvasId,
      scopeVersion: area.scopeVersion,
      intent: decision.intent,
      edge: decision.edge ?? nearestSceneAreaEdge(area.bounds, ground),
      startGround: { u: ground.u, v: ground.v },
      startBounds: { min: { ...area.bounds.min }, max: { ...area.bounds.max } },
      delta: { u: 0, v: 0 },
      bounds: { min: { ...area.bounds.min }, max: { ...area.bounds.max } },
      abort: new AbortController(),
      prepared: Promise.resolve({ ok: false, code: "not-ready", message: "尚未读取场景上下文" }),
      snapshot: null,
      prepareMessage: null,
      previewed: new Set(),
      ending: false,
      committing: false
    };
    active = gesture;
    publish(gesture, "preparing");
    gesture.prepared = startPrepare(gesture);
    return { areaNodeId, intent: decision.intent };
  };

  const update = (point: SceneAreaPoint): boolean => {
    const gesture = active;
    if (!gesture || gesture.ending) return false;
    const ground = deps.queryGround(point);
    if (!ground) return false;
    const delta = { u: ground.u - gesture.startGround.u, v: ground.v - gesture.startGround.v };
    gesture.delta = delta;
    if (gesture.intent === "resize") {
      gesture.bounds = resizeSceneAreaBounds(gesture.startBounds, gesture.edge, delta);
    } else {
      gesture.bounds = {
        min: { u: gesture.startBounds.min.u + delta.u, v: gesture.startBounds.min.v + delta.v },
        max: { u: gesture.startBounds.max.u + delta.u, v: gesture.startBounds.max.v + delta.v }
      };
      applyPreview(gesture);
    }
    publish(gesture, gesture.intent === "move" ? "moving" : "resizing");
    return true;
  };

  const finish = (gesture: ActiveGesture): { ok: false; code: string; message: string } => {
    clearPreview(gesture);
    active = null;
    return { ok: false, code: "not-ready", message: gesture.prepareMessage ?? "场景操作未完成" };
  };

  const end = async (): Promise<SceneAreaGestureResult> => {
    const gesture = active;
    if (!gesture || gesture.ending) return { ok: false, code: "not-ready", message: "没有进行中的场景手势" };
    gesture.ending = true;
    const prepared = await gesture.prepared;
    if (!gesture.snapshot) {
      const failure = finish(gesture);
      setState({ phase: "failed", message: failure.message });
      return failure;
    }
    const hasDelta = Math.abs(gesture.delta.u) > 1e-6 || Math.abs(gesture.delta.v) > 1e-6;
    const changed = gesture.intent === "move" ? hasDelta : !sameBounds(gesture.bounds, gesture.startBounds);
    if (!changed) {
      clearPreview(gesture);
      active = null;
      setState({ phase: "idle" });
      return { ok: true, noop: true };
    }
    const operationId = newOperationId("scene-area");
    const built = buildSceneAreaRequest({
      canvasId: gesture.canvasId,
      operationId,
      snapshot: gesture.snapshot,
      intent: gesture.intent,
      ...(gesture.intent === "move" ? { delta: gesture.delta } : { bounds: gesture.bounds })
    });
    if (!built.ok) {
      const failure = finish(gesture);
      setState({ phase: "failed", message: built.reason });
      return { ...failure, message: built.reason };
    }
    const preflight = planSceneAreaOperation(built.request);
    if (!preflight.ok) {
      const failure = finish(gesture);
      setState({ phase: "failed", message: `场景操作无效：${preflight.code}` });
      return { ...failure, code: preflight.code, message: `场景操作无效：${preflight.code}` };
    }
    setState({
      phase: "committing",
      intent: gesture.intent,
      areaNodeId: gesture.areaNodeId,
      delta: gesture.delta,
      bounds: gesture.bounds
    });
    gesture.committing = true;
    let outcome: WorldAuthoringExecuteOutcome;
    try {
      outcome = await deps.execute({ canvasId: gesture.canvasId, request: built.request, operationId }, gesture.abort.signal);
    } catch {
      clearPreview(gesture);
      active = null;
      setState({ phase: "failed", message: "场景操作提交失败" });
      return { ok: false, code: "not-ready", message: "场景操作提交失败" };
    }
    clearPreview(gesture);
    active = null;
    if (!outcome.ok) {
      setState({ phase: "failed", message: outcome.message, conflicts: outcome.conflicts ?? [] });
      return { ok: false, code: outcome.code, message: outcome.message, ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}) };
    }
    if (outcome.canvasId !== gesture.canvasId || outcome.operationId !== operationId) {
      setState({ phase: "failed", message: "场景操作回执不匹配" });
      return { ok: false, code: "version-conflict", message: "场景操作回执不匹配" };
    }
    retainHistory({
      operationId: outcome.operationId,
      canvasId: gesture.canvasId,
      intent: gesture.intent,
      label: labelFor(gesture.intent)
    });
    setState({ phase: "idle" });
    void prepared;
    return { ok: true, operationId: outcome.operationId, intent: gesture.intent, receipt: outcome.receipt };
  };

  const cancel = (): void => {
    const gesture = active;
    if (!gesture) return;
    // 已进入权威提交后不再伪装取消；仍在等待 prepare 时允许取消并释放准备请求。
    if (gesture.ending && gesture.committing) return;
    gesture.abort.abort();
    clearPreview(gesture);
    active = null;
    setState({ phase: "idle" });
  };

  const deleteArea = async (areaNodeId: string, withContents: boolean): Promise<SceneAreaGestureResult> => {
    const canvasId = deps.canvasId();
    const canvas = deps.getCanvas();
    if (!canvasId || !canvas || !deps.writable()) return { ok: false, code: "write-forbidden", message: "当前不可写" };
    const area = areaOf(canvas, areaNodeId);
    if (!area) return { ok: false, code: "not-found", message: "场景区不存在" };
    cancel();
    const intent: SceneAreaPlanIntent = withContents ? "delete-area-with-contents" : "delete-area";
    setState({ phase: "committing", intent, areaNodeId });
    const abort = new AbortController();
    const prepared = await deps.prepare(areaNodeId, abort.signal);
    if (!prepared.ok) {
      setState({ phase: "failed", message: prepared.message, conflicts: prepared.conflicts ?? [] });
      return { ok: false, code: prepared.code, message: prepared.message, ...(prepared.conflicts ? { conflicts: prepared.conflicts } : {}) };
    }
    if (prepared.snapshot.canvasId !== canvasId || prepared.snapshot.area.areaId !== areaNodeId
      || prepared.snapshot.area.scopeVersion !== area.scopeVersion) {
      setState({ phase: "failed", message: "场景上下文已过期" });
      return { ok: false, code: "version-conflict", message: "场景上下文已过期" };
    }
    const operationId = newOperationId("scene-area");
    const built = buildSceneAreaRequest({ canvasId, operationId, snapshot: prepared.snapshot, intent });
    if (!built.ok) {
      setState({ phase: "failed", message: built.reason });
      return { ok: false, code: "invalid-data", message: built.reason };
    }
    let outcome: WorldAuthoringExecuteOutcome;
    try {
      outcome = await deps.execute({ canvasId, request: built.request, operationId }, abort.signal);
    } catch {
      setState({ phase: "failed", message: "场景删除提交失败" });
      return { ok: false, code: "not-ready", message: "场景删除提交失败" };
    }
    if (!outcome.ok) {
      setState({ phase: "failed", message: outcome.message, conflicts: outcome.conflicts ?? [] });
      return { ok: false, code: outcome.code, message: outcome.message, ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}) };
    }
    retainHistory({ operationId: outcome.operationId, canvasId, intent, label: labelFor(intent) });
    setState({ phase: "idle" });
    return { ok: true, operationId: outcome.operationId, intent, receipt: outcome.receipt };
  };

  const history = async (direction: "undo" | "redo"): Promise<SceneAreaGestureResult> => {
    const canvasId = deps.canvasId();
    if (!canvasId) return { ok: false, code: "not-ready", message: "画布尚未加载" };
    const entry = direction === "undo"
      ? sceneAreaHistoryStore.entryForUndo(canvasId)
      : sceneAreaHistoryStore.entryForRedo(canvasId);
    if (!entry) return { ok: false, code: "not-found", message: direction === "undo" ? "没有可撤销的场景操作" : "没有可重做的场景操作" };
    setState({ phase: "committing", intent: entry.intent });
    let outcome: WorldAuthoringHistoryOutcome;
    try {
      outcome = await deps.history(direction, { canvasId, operationId: entry.operationId });
    } catch {
      setState({ phase: "failed", message: "场景历史请求失败" });
      return { ok: false, code: "not-ready", message: "场景历史请求失败" };
    }
    if (!outcome.ok) {
      setState({ phase: "failed", message: outcome.message, conflicts: outcome.conflicts ?? [] });
      return { ok: false, code: outcome.code, message: outcome.message, ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}) };
    }
    if (outcome.canvasId !== canvasId || outcome.operationId !== entry.operationId || outcome.direction !== direction) {
      setState({ phase: "failed", message: "场景历史回执不匹配" });
      return { ok: false, code: "version-conflict", message: "场景历史回执不匹配" };
    }
    if (direction === "undo") sceneAreaHistoryStore.markUndone();
    else sceneAreaHistoryStore.markRedone();
    setState({ phase: "idle" });
    return { ok: true, operationId: entry.operationId, intent: entry.intent, receipt: outcome.receipt };
  };

  return {
    begin,
    update,
    end,
    cancel,
    active: () => !!active,
    deleteArea,
    undo: () => history("undo"),
    redo: () => history("redo")
  };
}

/* ------------------------------------------------------------------------- */
/* 安装入口：把运行时绑定到页面 scope，供交互控制器与可见控件消费。           */
/* ------------------------------------------------------------------------- */

let boundPort: SceneAreaGesturePort | null = null;

export function bindSceneAreaGestures(port: SceneAreaGesturePort): () => void {
  if (boundPort && boundPort !== port) boundPort.cancel();
  boundPort = port;
  return () => {
    if (boundPort === port) boundPort = null;
    port.cancel();
  };
}

export function currentSceneAreaGestures(): SceneAreaGesturePort | null {
  return boundPort;
}

/** 测试/宿主重置；生产由插件卸载调用。 */
export function resetSceneAreaGestures(): void {
  boundPort?.cancel();
  boundPort = null;
  sceneAreaGestureStore.reset();
  sceneAreaModeStore.reset();
  sceneAreaHistoryStore.clear();
}

/**
 * 从 Cordis Context 装配。交互控制器只通过 `currentSceneAreaGestures()` 读取，
 * 因此安装顺序不影响指针路由；页面切换时由调用方执行返回的 dispose。
 */
export function installSceneAreaGestures(ctx: Context, canvasId: string | undefined): () => void {
  const port = createSceneAreaGestures({
    canvasId: () => canvasId,
    writable: () => ctx.canvasSession.isWritable(),
    getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()),
    prepare: (areaId, signal) => canvasId
      ? ctx.canvasRemote.prepareSceneArea({ canvasId, areaId }, signal)
      : Promise.resolve({ ok: false, code: "not-ready", message: "画布尚未加载" }),
    execute: (input, signal) => ctx.canvasRemote.executeSceneArea(input, signal),
    history: (direction, input, signal) => ctx.canvasRemote.historySceneArea(direction, input, signal),
    adoptHistory: entry => {
      const result = ctx.canvasEdit.recordExternal({
        id: `scene-area:${entry.operationId}`,
        label: entry.label,
        undo: entry.undo,
        redo: entry.redo
      });
      return result.ok ? { ok: true } : result;
    },
    queryGround: point => ctx.canvasRuntime.controller()?.queryWorldGround(point) ?? null,
    preview: (nodeId, delta) => { ctx.canvasRuntime.controller()?.setWorldGroundPreview(nodeId, delta); },
    mode: () => sceneAreaModeStore.getSnapshot(),
    tolerance: point => {
      const controller = ctx.canvasRuntime.controller();
      const near = controller?.queryWorldGround({ x: point.x + 12, y: point.y });
      const origin = controller?.queryWorldGround(point);
      if (!near || !origin) return SCENE_AREA_EDGE_TOLERANCE_METERS;
      return Math.max(0.06, Math.hypot(near.u - origin.u, near.v - origin.v));
    }
  });
  const unbind = bindSceneAreaGestures(port);
  return () => {
    unbind();
    // 只在没有新页面实例接管时清空；避免 StrictMode/快速切换把新页面的栈清掉。
    if (!currentSceneAreaGestures()) {
      sceneAreaGestureStore.reset();
      sceneAreaModeStore.reset();
      sceneAreaHistoryStore.clear();
    }
  };
}
