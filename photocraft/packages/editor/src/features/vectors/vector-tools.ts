/**
 * 矢量工具组与画布手势归约（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 这一层是**共享画布唯一的接入点**：工具清单（id/标签/手势种类/快捷键/可用性）与手势状态机都在
 * 这里，`photo-editor-canvas.tsx` 只需把指针事件交给 `reduceVectorGesture`，把返回的
 * `commands` 逐条执行、把 `overlay` 交给叠加层渲染。这样本域不复制取景换算、不持有 pointer
 * capture，也不在 React 里重算贝塞尔。
 *
 * 为什么单独成文件而不是直接往 `features/vectors/index.ts` 里加 `tools`：
 * 共享画布当前只认 `selection|sample|stroke|point|text|move` 六种手势，未登记的工具会被
 * 当成平移或笔迹处理（会误画像素）。因此工具先在这里声明并完成手势归约与回归，
 * 由集成会话在画布分派里接入后再对外暴露按钮；见 `openspec/changes/…/tasks.md` 的交接记录。
 */

import { hitTolerance, shapeCreateParams, shapeGeometry, shapePreview, type ShapeDrag, type ShapeKind } from "./shape-tools.js";
import { addKnot, canFinish, closeDraft, continueFrom, cornerKnot, emptyDraft, finishDraft, freehandDraft, removeKnot, type PenDraft, type PenKind, type PenPath } from "./pen-tools.js";
import { addAnchorParams, applySelection, bendSegmentParams, commandForDrag, convertPointParams, hitTest, hitTestSegment, type EditablePath, type PathHit, type SegmentHit, type SelectMode } from "./path-edit.js";

/** 工具分类（决定画布指针语义）。 */
export type VectorToolGesture = "shape-draw" | "pen" | "path-edit";

export type VectorTool = {
  id: string;
  label: string;
  group: "shape" | "pen" | "path";
  gesture: VectorToolGesture;
  /** 形状子工具的形状种类。 */
  kind?: ShapeKind;
  /** 钢笔变体。 */
  pen?: PenKind;
  /** 建议快捷键（由共享快捷键表落位，避免与既有工具冲突）。 */
  shortcut?: string;
  order: number;
};

/** 工具栏顺序：接在既有 `pen`（order 11）之后，保持数字快捷键表不变。 */
export const VECTOR_TOOLS: readonly VectorTool[] = [
  { id: "shape-rect", label: "矩形", group: "shape", gesture: "shape-draw", kind: "rect", shortcut: "U", order: 12 },
  { id: "shape-rounded-rect", label: "圆角矩形", group: "shape", gesture: "shape-draw", kind: "roundedRect", order: 13 },
  { id: "shape-ellipse", label: "椭圆", group: "shape", gesture: "shape-draw", kind: "ellipse", order: 14 },
  { id: "shape-triangle", label: "三角形", group: "shape", gesture: "shape-draw", kind: "triangle", order: 15 },
  { id: "shape-polygon", label: "多边形", group: "shape", gesture: "shape-draw", kind: "polygon", order: 16 },
  { id: "shape-star", label: "星形", group: "shape", gesture: "shape-draw", kind: "star", order: 17 },
  { id: "shape-line", label: "直线", group: "shape", gesture: "shape-draw", kind: "line", order: 18 },
  { id: "pen-freeform", label: "自由钢笔", group: "pen", gesture: "pen", pen: "freeform", order: 19 },
  { id: "pen-curvature", label: "曲率钢笔", group: "pen", gesture: "pen", pen: "curvature", order: 20 },
  { id: "path-select", label: "路径选择", group: "path", gesture: "path-edit", order: 21 },
  { id: "direct-select", label: "直接选择", group: "path", gesture: "path-edit", order: 22 },
  { id: "custom-shape", label: "自定形状", group: "shape", gesture: "shape-draw", order: 23 },
];

export function vectorTool(id: string): VectorTool | undefined {
  return VECTOR_TOOLS.find(tool => tool.id === id);
}

/** 该工具 id 是否为矢量组（画布据此路由指针，不落到平移/笔迹分支）。 */
export function isVectorToolGesture(id: string): boolean {
  return vectorTool(id) !== undefined;
}

/** 指针事件（与 React 的 `PointerEvent` 对齐，但只保留本域用到的字段）。 */
export type VectorPointer = {
  type: "down" | "move" | "up" | "cancel";
  point: [number, number];
  shift?: boolean;
  alt?: boolean;
  /** 双击由画布合成（`detail >= 2`）。 */
  doubleClick?: boolean;
  /** 指针是否已经移动超过阈值（用于区分单击与拖动）。 */
  moved?: boolean;
};

/** 叠加层状态：拖绘预览、钢笔草稿或锚点选择。 */
export type VectorOverlay =
  | { kind: "none" }
  | { kind: "shape"; drag: ShapeDrag }
  | { kind: "pen"; draft: PenDraft }
  | { kind: "anchors"; path: EditablePath; selection: PathHit[]; hover: PathHit | null };

/** 归约结果：要执行的命令（按顺序、每条一步历史）与下一帧状态。 */
export type VectorGestureResult = {
  overlay: VectorOverlay;
  commands: { id: string; params: Record<string, unknown> }[];
  /** 需要展示给用户的拒绝原因（未产生命令）。 */
  message?: string;
  /**
   * 零面积单击：界面据此改为「尺寸输入」而不是创建一个看不见的形状（design D1）。
   * 值是被点击的源像素点，面板用它填入起点。
   */
  sizeInput?: [number, number];
};

export type VectorGestureState = {
  tool: string;
  overlay: VectorOverlay;
  /** 拖绘起点（形状）或命中对象（路径编辑）。 */
  anchor?: [number, number];
  hit?: PathHit | null;
  /** 按下时命中的线段（拖动弯折 / 双击插锚）；与 `hit` 互斥。 */
  segment?: SegmentHit | null;
  selection?: PathHit[];
  /** 正在拖动的形状/路径是否已经产生过命令。 */
  dragging?: boolean;
  /** 钢笔最后一个锚点是否正在拖出控制柄。 */
  penDragging?: boolean;
};

export function initialVectorGesture(tool = "pen"): VectorGestureState {
  return { tool, overlay: { kind: "none" }, selection: [], dragging: false, penDragging: false };
}

/**
 * 单击命中了哪条开放子路径的**末端**锚点（续接手势的入口）。
 *
 * 只认末端：`path.set` 追加的是尾部锚点，从首锚点继续需要先反向整条路径，
 * 那会改变已有几何，属于另一个功能（Reverse Path），这里不做。
 */
export function continueHit(path: PenPath, point: readonly [number, number], tolerance: number): number {
  for (let index = 0; index < path.subpaths.length; index += 1) {
    const subpath = path.subpaths[index];
    if (!subpath || subpath.closed || subpath.knots.length < 2) continue;
    const end = subpath.knots[subpath.knots.length - 1]!.anchor;
    if (Math.hypot(end[0] - point[0], end[1] - point[1]) <= tolerance) return index;
  }
  return -1;
}

/** 路径编辑的目标描述（形状层/矢量蒙版用 `layer`，其余是文档路径名）。 */
export type VectorEditTarget = { name: string; layer?: number | null };

export type VectorGestureOptions = {
  /** 文档尺寸（形状越界判定）。 */
  canvas: readonly [number, number];
  /** 当前取景缩放（命中阈值换算）。 */
  zoom: number;
  /** 提交形状时使用的填充/描边（面板当前值）。 */
  fill?: string | null;
  stroke?: Record<string, unknown> | null;
  /** 路径编辑的目标与当前路径几何。 */
  target?: VectorEditTarget;
  path?: EditablePath | null;
  /** 选择修饰键：Shift 加选/减选。 */
  selectionMode?: SelectMode;
  /** 形状拖绘的固定参数（圆角、边数、星形比例、线宽）。 */
  shapeOptions?: { radius?: number; sides?: number; starRatio?: number; weight?: number };
  /** 钢笔草稿的变体。 */
  penKind?: PenKind;
  /**
   * 自由钢笔：指针移动时累积的采样点。为空时按普通钢笔逐点落锚。
   * 由画布在拖动期间填入；归约器只在 `up` 时用它生成平滑折线。
   */
  freehandPoints?: readonly (readonly [number, number])[];
  /** 续接目标：单击它的**开放子路径末端**时从那里继续追加（U11「续接」）。 */
  continuePath?: PenPath | null;
  /** 自定形状工具当前选中的预设（`custom-shape` 拖绘必须选一个）。 */
  preset?: { name: string; group?: string } | null;
  /** 钢笔结束时把路径落到哪里：工作路径（默认）、形状层或矢量蒙版。 */
  penTarget?: "work" | "shape" | "mask";
  /**
   * `penTarget` 为 `work` 时落到的路径名：面板选了已存路径就写它，默认工作路径。
   *
   * 只能是 `path.set` 支持的名字（`work` 或已存路径）；图层自身路径不能经 `path.set` 写入，
   * 调用方必须先把它解析成形状层/蒙版目标，不能把 `"layer"` 当名字混传。
   */
  pathName?: string;
  /** `penTarget` 为形状/蒙版时的目标图层。 */
  layer?: number | null;
  /**
   * 路径选择工具（`path-select`）：拖动锚点时移动**整个子路径**，而不是单个锚点。
   *
   * 这是 Photoshop「路径选择」与「直接选择」的语义差别；两条工具共用同一套命中与命令，
   * 只在这里分支，避免第二套节点编号或第二份几何。
   */
  moveWholeSubpath?: boolean;
};

/**
 * 指针事件 → 命令与叠加层。
 *
 * 事务规则（与内核一致）：拖动期间只更新叠加层，**松手才产生命令**，因此一次拖绘/一次锚点拖动
 * 都是一步历史；零面积或非法几何只返回 `message`，不产生命令。
 */
export function reduceVectorGesture(
  state: VectorGestureState,
  pointer: VectorPointer,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  const tool = vectorTool(state.tool);
  if (!tool) return { state, result: { overlay: state.overlay, commands: [] } };
  if (tool.gesture === "shape-draw") return reduceShape(state, tool, pointer, options);
  // 工具自己是变体的唯一来源：`pen-freeform`/`pen-curvature` 必须真的走采样与平滑，
  // 而不是退化成普通点钢笔。调用方漏传 `penKind` 时也仍然正确。
  if (tool.gesture === "pen") return reducePen(state, pointer, tool.pen ? { ...options, penKind: tool.pen } : options);
  return reducePathEdit(state, pointer, options);
}

function reduceShape(
  state: VectorGestureState,
  tool: VectorTool,
  pointer: VectorPointer,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  // 自定形状（U16）与形状拖绘共用同一套起止点/修饰键，只把提交命令换成预设放置。
  if (tool.id === "custom-shape") return reducePreset(state, pointer, options);
  const kind: ShapeKind = tool.kind ?? "roundedRect";
  const drag: ShapeDrag = {
    kind,
    start: state.anchor ?? pointer.point,
    end: pointer.point,
    modifiers: { constrain: pointer.shift, fromCenter: pointer.alt },
    ...options.shapeOptions,
  };
  if (pointer.type === "down") {
    return {
      state: { ...state, anchor: pointer.point, dragging: true, overlay: { kind: "shape", drag } },
      result: { overlay: { kind: "shape", drag }, commands: [] },
    };
  }
  if (pointer.type === "move" && state.dragging) {
    // 拖绘预览与提交共用 `shapePreview`，非法几何只提示不画形状。
    const preview = shapePreview(drag, options.canvas);
    const message = preview.ok ? undefined : preview.message;
    return {
      state: { ...state, overlay: { kind: "shape", drag } },
      result: { overlay: { kind: "shape", drag }, commands: [], ...(message ? { message } : {}) },
    };
  }
  if (pointer.type === "cancel") {
    return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
  }
  if (pointer.type === "up") {
    const next = { ...initialVectorGesture(state.tool) };
    if (!state.dragging) return { state: next, result: { overlay: { kind: "none" }, commands: [] } };
    try {
      const params = shapeCreateParams(drag, options.canvas);
      return {
        state: next,
        result: {
          overlay: { kind: "none" },
          commands: [{
            id: "shape.create",
            params: {
              ...params,
              fill: options.fill ?? null,
              ...(options.stroke ? { stroke: options.stroke } : {}),
            },
          }],
        },
      };
    } catch (error) {
      return {
        state: next,
        result: {
          overlay: { kind: "none" },
          commands: [],
          message: error instanceof Error ? error.message : String(error),
          // 零面积/零长度 = 单击（不是拖动）：界面据此打开尺寸输入，起点就是这一击的位置。
          ...(Math.hypot(drag.end[0] - drag.start[0], drag.end[1] - drag.start[1]) < 1e-6 ? { sizeInput: [drag.start[0], drag.start[1]] as [number, number] } : {}),
        },
      };
    }
  }
  return { state, result: { overlay: state.overlay, commands: [] } };
}

/**
 * 自定形状拖绘（U16）：几何与矩形完全一致（`shapeGeometry`），落点矩形交给
 * `shape.presets.place`；未选预设时只提示，不创建空形状。
 */
function reducePreset(
  state: VectorGestureState,
  pointer: VectorPointer,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  const drag: ShapeDrag = {
    kind: "rect",
    start: state.anchor ?? pointer.point,
    end: pointer.point,
    modifiers: { constrain: pointer.shift, fromCenter: pointer.alt },
  };
  if (pointer.type === "down") {
    if (!options.preset) {
      return { state, result: { overlay: { kind: "none" }, commands: [], message: "请先选择一个形状预设" } };
    }
    return {
      state: { ...state, anchor: pointer.point, dragging: true, overlay: { kind: "shape", drag } },
      result: { overlay: { kind: "shape", drag }, commands: [] },
    };
  }
  if (pointer.type === "move" && state.dragging) {
    const preview = shapePreview(drag, options.canvas);
    return {
      state: { ...state, overlay: { kind: "shape", drag } },
      result: { overlay: { kind: "shape", drag }, commands: [], ...(preview.ok ? {} : { message: preview.message }) },
    };
  }
  if (pointer.type === "cancel") {
    return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
  }
  if (pointer.type === "up") {
    const next = { ...initialVectorGesture(state.tool) };
    if (!state.dragging || !options.preset) return { state: next, result: { overlay: { kind: "none" }, commands: [] } };
    try {
      const geometry = shapeGeometry(drag, options.canvas);
      return {
        state: next,
        result: {
          overlay: { kind: "none" },
          commands: [{
            id: "shape.presets.place",
            params: {
              preset: options.preset.name,
              ...(options.preset.group ? { group: options.preset.group } : {}),
              rect: geometry.rect,
              ...(options.fill === undefined ? {} : { fill: options.fill }),
            },
          }],
        },
      };
    } catch (error) {
      return { state: next, result: { overlay: { kind: "none" }, commands: [], message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { state, result: { overlay: state.overlay, commands: [] } };
}

function currentDraft(state: VectorGestureState, options: VectorGestureOptions): PenDraft {
  if (state.overlay.kind === "pen") return state.overlay.draft;
  // 续接**不在这里**自动发生：只有单击落在已有开放路径的末端锚点上才开始续接
  // （见 `reducePen` 的 down 分支）。否则只要存在开放路径，钢笔就再也画不出第二条独立路径——
  // 每次落锚都会悄悄延长旧路径，松手 `path.set` 直接覆盖它。
  return emptyDraft(options.penKind ?? "pen");
}

function reducePen(
  state: VectorGestureState,
  pointer: VectorPointer,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  const draft = currentDraft(state, options);
  if (pointer.type === "cancel") {
    return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
  }
  if (pointer.type === "down") {
    // 双击/回车结束：默认**开放**路径（U11 的核心修正），点回首锚点才闭合。
    if (pointer.doubleClick) return finishPen(state, draft, false, options);
    const first = draft.subpaths[0]?.knots[0];
    const closing = !!first && Math.hypot(first.anchor[0] - pointer.point[0], first.anchor[1] - pointer.point[1]) <= hitTolerance(6, options.zoom);
    if (closing && canFinish(draft)) return finishPen(state, draft, true, options);
    // 续接：草稿还是空的、而这一击落在已有开放路径的末端锚点上 → 从那里继续画，
    // 不在旁边另起一条。落点与末端重合本身就是「接着画」的手势，不额外造锚点。
    if (!draft.subpaths[0]?.knots.length && options.continuePath) {
      const index = continueHit(options.continuePath, pointer.point, hitTolerance(6, options.zoom));
      if (index >= 0) {
        const resumed = continueFrom(options.continuePath, index, draft.kind);
        if (resumed) {
          // 不进入拖柄状态：这一击只是「接着画」，拖动不应静默改写已有末端锚点的手柄。
          return {
            state: { ...state, dragging: false, penDragging: false, overlay: { kind: "pen", draft: resumed } },
            result: { overlay: { kind: "pen", draft: resumed }, commands: [] },
          };
        }
      }
    }
    // 曲率钢笔：落**平滑**锚点（手柄暂与锚点重合），提交时再由内核按曲率重排手柄。
    // 落成角点的话内核不会重排（实测：`smooth:false` 的锚点被 `curvature` 跳过）。
    const next = draft.kind === "curvature"
      ? addKnot(draft, { point: pointer.point, handle: pointer.point })
      : addKnot(draft, { point: pointer.point });
    return {
      state: { ...state, dragging: true, penDragging: true, overlay: { kind: "pen", draft: next } },
      result: { overlay: { kind: "pen", draft: next }, commands: [] },
    };
  }
  if (pointer.type === "move" && state.penDragging) {
    // 按住拖动拉出对称控制柄（Alt 只留出向柄）。
    const knots = draft.subpaths[draft.active]?.knots ?? [];
    const last = knots[knots.length - 1];
    if (!last) return { state, result: { overlay: state.overlay, commands: [] } };
    if (!pointer.moved) return { state, result: { overlay: { kind: "pen", draft }, commands: [] } };
    const withoutLast = removeKnot(draft);
    const next = addKnot(withoutLast, { point: last.anchor, handle: pointer.point, breakHandle: pointer.alt });
    return {
      state: { ...state, overlay: { kind: "pen", draft: next } },
      result: { overlay: { kind: "pen", draft: next }, commands: [] },
    };
  }
  if (pointer.type === "up") {
    // 自由钢笔：本次拖动采样到 ≥2 个点时，用它替换刚落的单锚为平滑折线。
    // 未提供采样（普通钢笔/仅单击）时保持逐点落锚，语义不变。
    const samples = options.freehandPoints;
    if (samples && samples.length >= 2 && draft.subpaths[0]?.knots.length) {
      // 曲率钢笔在采样之后按邻居自动平滑；自由钢笔保留 Catmull-Rom 的手柄。
      const kind = options.penKind === "curvature" ? "curvature" : "freeform";
      const freehand = freehandDraft(samples, 1.5, kind);
      const run = freehand.subpaths[0]?.knots ?? [];
      if (run.length >= 2) {
        const merged: PenDraft = {
          ...draft,
          subpaths: draft.subpaths.map((subpath, index) =>
            index === draft.active ? { ...subpath, knots: [...subpath.knots.slice(0, -1), ...run] } : subpath),
        };
        return { state: { ...state, penDragging: false, dragging: false, overlay: { kind: "pen", draft: merged } }, result: { overlay: { kind: "pen", draft: merged }, commands: [] } };
      }
    }
    return { state: { ...state, penDragging: false, dragging: false }, result: { overlay: { kind: "pen", draft }, commands: [] } };
  }
  return { state, result: { overlay: { kind: "pen", draft }, commands: [] } };
}

/**
 * 结束钢笔：`closed` 决定闭合；锚点不足时返回提示而不是空提交。
 *
 * 落点由 `penTarget` 决定，和既有钢笔一致：工作路径（默认）走 `path.set`；
 * 画成形状层走 `shape.create`（`kind: "path"`）；画进矢量蒙版走 `layer.vectorMask.add`。
 * `penTarget` 为 `work` 且面板选了已存路径时，`path.set` 与随后的曲率重排都写该名字，
 * 不能一条写命名路径、另一条改工作路径。
 */
function finishPen(
  state: VectorGestureState,
  draft: PenDraft,
  closed: boolean,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  const path = finishDraft(closed ? closeDraft(draft) : draft, closed);
  const next = { ...initialVectorGesture(state.tool) };
  if (!path) {
    return { state: next, result: { overlay: { kind: "none" }, commands: [], message: "路径至少需要两个锚点" } };
  }
  const target = options.penTarget ?? "work";
  const layer = options.layer;
  // 形状层由 `shape.create` 自己建层，只有画进已有图层蒙版才必须给目标图层。
  if (target === "mask" && layer == null) {
    return { state: next, result: { overlay: { kind: "none" }, commands: [], message: "请先选择一个图层" } };
  }
  const command = target === "shape"
    ? { id: "shape.create", params: { kind: "path", path, ...(options.fill === undefined ? {} : { fill: options.fill }) } }
    : target === "mask"
      ? { id: "layer.vectorMask.add", params: { layer, path } }
      : { id: "path.set", params: { name: penPathName(options.pathName), path } };
  // 曲率钢笔（U11）：先落路径，再让**内核**重排子路径所有平滑锚点的手柄
  // （`path.moveAnchors` + `curvature: true`，上游即曲率钢笔的拖动语义）。前端不重算贝塞尔。
  const reflow = draft.kind === "curvature" ? curvatureReflow(path, penPathName(options.pathName)) : null;
  const commands = reflow ? [command, reflow] : [command];
  return { state: next, result: { overlay: { kind: "none" }, commands } };
}

/**
 * 曲率钢笔的手柄重排参数：每个 >=3 锚点的子路径取第 2 个锚点作支点、位移为零，
 * 只借 `curvature: true` 让内核重排该子路径的平滑锚点。少于 3 个锚点时没有可依的相邻点，
 * 返回 `null`（不制造空命令）。
 *
 * 单点版本的参数形状在 `pen-tools.curvatureParams`（导出给叠加层与测试）；这里要跨多个子路径，
 * 因此直接在同一个 `path.moveAnchors` 里汇总 `[subpath, knot]` 对，不拆成多条命令。
 *
 * `name` 必须与刚落路径的名字一致，否则会给空白的工作路径发一次无意义的写入
 * （面板把钢笔画进已存路径时正是这条分支）。
 */
function curvatureReflow(path: PenPath, name: string): { id: string; params: Record<string, unknown> } | null {
  const anchors: number[][] = [];
  path.subpaths.forEach((subpath, index) => {
    if (subpath.knots.length >= 3) anchors.push([index, 1]);
  });
  if (anchors.length === 0) return null;
  return { id: "path.moveAnchors", params: { name, anchors, move: [0, 0], curvature: true } };
}

/** 钢笔落点的路径名：`layer` 不是可写入的名字（图层路径走 shape/mask 目标），退回工作路径。 */
function penPathName(name: string | undefined): string {
  return !name || name === "layer" ? "work" : name;
}

function reducePathEdit(
  state: VectorGestureState,
  pointer: VectorPointer,
  options: VectorGestureOptions,
): { state: VectorGestureState; result: VectorGestureResult } {
  const path = options.path;
  const target = options.target ?? { name: "work" };
  if (!path) return { state, result: { overlay: { kind: "none" }, commands: [] } };
  if (pointer.type === "cancel") {
    return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "anchors", path, selection: [], hover: null }, commands: [] } };
  }
  if (pointer.type === "down") {
    const hit = hitTest(path, pointer.point, 6, options.zoom);
    const mode: SelectMode = pointer.shift ? (state.selection?.some(entry => entry.subpath === hit?.subpath && entry.knot === hit?.knot) ? "subtract" : "add") : "replace";
    const selection = applySelection(state.selection ?? [], hit, mode);
    if (!hit) {
      // 锚点/手柄都没命中时再看线段：拖动即弯折、双击即插锚。路径选择工具同样支持，
      // 但不会因此产生第二种命中的锚点编号（仍用 `subpath` + 段起始 `knot` + `t`）。
      const segment = hitTestSegment(path, pointer.point, 6, options.zoom);
      if (segment) {
        return {
          state: { ...state, hit: null, selection: [], anchor: pointer.point, dragging: true, overlay: { kind: "anchors", path, selection: [], hover: null }, segment },
          result: { overlay: { kind: "anchors", path, selection: [], hover: null }, commands: [] },
        };
      }
      return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [] } };
    }
    return {
      state: { ...state, hit, selection, anchor: pointer.point, dragging: true, segment: null, overlay: { kind: "anchors", path, selection, hover: hit } },
      result: { overlay: { kind: "anchors", path, selection, hover: hit }, commands: [] },
    };
  }
  if (pointer.type === "move") {
    const hover = state.dragging ? state.hit ?? null : hitTest(path, pointer.point, 6, options.zoom);
    return { state: { ...state, overlay: { kind: "anchors", path, selection: state.selection ?? [], hover } }, result: { overlay: { kind: "anchors", path, selection: state.selection ?? [], hover }, commands: [] } };
  }
  if (pointer.type === "up") {
    const hit = state.hit;
    const segment = state.segment ?? null;
    const from = state.anchor;
    const selection = state.selection ?? [];
    const next = { ...state, dragging: false, hit: null, segment: null, anchor: undefined };
    if (!from) return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [] } };
    const moved = Math.hypot(pointer.point[0] - from[0], pointer.point[1] - from[1]) > 0.01;
    if (segment) {
      if (!moved) {
        // 双击线段 = 在该处插入锚点（`t` 来自真实命中，不是硬编码 0.5）。
        if (pointer.doubleClick) {
          const command = addAnchorParams(target, segment);
          return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [command] } };
        }
        return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [] } };
      }
      const command = bendSegmentParams(target, segment, [pointer.point[0] - from[0], pointer.point[1] - from[1]]);
      return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [command] } };
    }
    if (!hit) return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [] } };
    if (!moved) {
      // 单击不移动 = 只改变选择；双击则转换平滑/尖角。
      if (pointer.doubleClick) {
        const command = commandForConvert(target, hit);
        return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: hit }, commands: command ? [command] : [] } };
      }
      return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: hit }, commands: [] } };
    }
    // 路径选择工具拖锚点移动整条子路径；直接选择只动选中的锚点。
    const anchors = options.moveWholeSubpath && hit.kind === "anchor"
      ? path.subpaths[hit.subpath]?.knots.map((_, knot) => [hit.subpath, knot] as readonly [number, number]) ?? null
      : null;
    const command = commandForDrag({ hit, from, to: pointer.point }, target, selection, anchors ? { anchors } : {});
    return { state: next, result: { overlay: { kind: "anchors", path, selection, hover: null }, commands: [command] } };
  }
  return { state, result: { overlay: state.overlay, commands: [] } };
}

/**
 * 双击锚点 → 平滑/尖角**双向**转换。
 *
 * 上游 `path.convertPoint` 有三种用法（`vector/src/edit.rs`）：
 * - 不带 `out`：转尖角并收回手柄（**单向**，永远只能是尖角）；
 * - 带 `out`：转平滑点，入向柄镜像为 `2·anchor − out`；
 * - `curvature: true`：按锚点当前状态翻转（`toggle_curvature_point`），平滑 ↔ 尖角。
 *
 * 双击要的是双向切换，且前端不必先知道锚点是否平滑（内核自己判），所以用 `curvature: true`。
 * 用「不带 out」会把双击变成只会转尖角，第二次双击毫无效果 —— 实测确实如此，已改。
 */
function commandForConvert(target: VectorEditTarget, hit: PathHit): { id: string; params: Record<string, unknown> } | null {
  if (hit.kind !== "anchor") return null;
  return convertPointParams(target, hit, undefined, { curvature: true });
}

/**
 * 键盘结束规则（Enter 完成开放路径，Escape 丢弃草稿，Delete 删除选中锚点）。
 *
 * `options` 只用于决定落点（工作路径/形状/蒙版）；不传时落到工作路径。
 * 删除锚点只在路径编辑状态下生效（有 `selection` 且没有正在拖的草稿），避免与钢笔的
 * Backspace（撤一个锚点）混淆。
 */
export function reduceVectorKey(
  state: VectorGestureState,
  key: "Enter" | "Escape" | "Backspace" | "Delete",
  options: VectorGestureOptions = { canvas: [8192, 8192], zoom: 1 },
): { state: VectorGestureState; result: VectorGestureResult } {
  if (state.overlay.kind !== "pen") {
    if (key === "Escape") return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
    if (key === "Delete") {
      // 直接选择：删除选中的锚点。逆序删除，避免前面的索引位移影响后面的目标。
      const target = options.target ?? { name: "work" };
      const selection = (state.selection ?? []).filter(hit => hit.kind === "anchor");
      if (!selection.length || !options.path) return { state, result: { overlay: state.overlay, commands: [] } };
      const commands = [...selection]
        .sort((a, b) => b.subpath - a.subpath || b.knot - a.knot)
        .map(hit => ({
          id: "path.deleteAnchor",
          params: { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }), subpath: hit.subpath, knot: hit.knot },
        }));
      return { state: { ...state, selection: [] }, result: { overlay: { kind: "anchors", path: options.path, selection: [], hover: null }, commands } };
    }
    return { state, result: { overlay: state.overlay, commands: [] } };
  }
  const draft = state.overlay.draft;
  if (key === "Escape") return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
  if (key === "Backspace") {
    const next = removeKnot(draft);
    if (next.subpaths[0]?.knots.length === 0) return { state: { ...initialVectorGesture(state.tool) }, result: { overlay: { kind: "none" }, commands: [] } };
    return { state: { ...state, overlay: { kind: "pen", draft: next } }, result: { overlay: { kind: "pen", draft: next }, commands: [] } };
  }
  return finishPen(state, draft, false, options);
}

/** 单个锚点草稿（用于叠加层预览与测试）。 */
export function draftFromPoints(points: readonly (readonly [number, number])[], kind: PenKind = "pen"): PenDraft {
  let draft = emptyDraft(kind);
  for (const point of points) draft = addKnot(draft, { point: [point[0], point[1]] });
  return draft;
}

/** 角点导出（叠加层预览与续接共用）。 */
export function cornerOf(point: readonly [number, number]) {
  return cornerKnot(point);
}
