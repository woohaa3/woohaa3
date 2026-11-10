/**
 * Canvas 渲染节点布局几何（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 节点视觉种类映射、尺寸派生、端口/抓手/命中矩形、拖动粘连与聚合把手几何。全部为纯几何
 * 常量与函数，与 Bevy 绘制共用同一公式；不包含 any 领域投影或快照装配。
 */
import { RESIZE_HANDLE_SIZE } from "../domain/index.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "../domain/core/composite-asset-identity.js";
import { estimateNodeActionTextWidth } from "./node-action-toolbar.js";
export { effectiveCanvasNodeSize, minimumNodeSizeFor } from "../node-dimensions.js";

/** 参考实现的 palette kind（决定 Bevy 中的配色与图标）。 */
export type BevyNodeKind = "text" | "image" | "model" | "audio" | "video" | "shot" | "node";

/** 静态 model3d 卡片自带本地轨道预览。
 * 已下线的 generate/edit/shot 不在此列，保持未知节点行为（change: 2026-10-08-integrate-render-performance-and-model-preview）。 */
export function isModelPreviewNodeType(type: string): boolean {
  return type === "model3d";
}

/**
 * woohaa3 六类应用节点 → 参考 palette kind。
 * `model3d`/`composite-asset` 承载 3D 内容，映射为 `model`；start 已下线；未知回落 `node`。
 */
export function bevyKindForNodeType(type: string): BevyNodeKind {
  switch (type) {
    case "text": return "text";
    case "image": return "image";
    case "model3d":
    case COMPOSITE_ASSET_NODE_TYPE: return "model";
    case "audio": return "audio";
    case "video": return "video";
    // 镜头卡片使用相机图标（与右键“插入镜头”一致），不再落回通用节点图标。
    case "world-camera": return "shot";
    default: return "node";
  }
}

/** 参考 `nodeSize`：富内容节点 248x232，其余 196x64。 */
export function bevyNodeSize(kind: BevyNodeKind): { width: number; height: number } {
  return kind === "text" || kind === "image" || kind === "audio" || kind === "video" || kind === "shot"
    ? { width: 248, height: 232 }
    : { width: 196, height: 64 };
}

/**
 * 承载 3D 内容的节点类型（与 `bevyKindForNodeType` 的 `model` 映射一致）。
 *
 * 单一事实源：模型聚焦、编辑面板与 MCP 生成提示都据此判定「这是模型节点」
 * （change: 2026-10-05-bind-model-animation-to-shots；2026-10-11 复合资产类别收敛）。
 */
export const MODEL_NODE_TYPES = ["model3d", COMPOSITE_ASSET_NODE_TYPE] as const;

/** 是否为承载 3D 内容的节点类型。 */
export function isModelNodeType(type: string): boolean {
  return (MODEL_NODE_TYPES as readonly string[]).includes(type);
}

/** 具备输出端点（可作为连线起点）的视觉种类。 */
export function bevyKindHasOutput(kind: BevyNodeKind): boolean {
  void kind;
  return true;
}

/** 具备输入端点（可作为连线终点）的视觉种类。 */
export function bevyKindHasInput(kind: BevyNodeKind): boolean {
  void kind;
  return true;
}


/** 参考 `port`：输入在左中、输出在右中。 */
export function bevyPort(
  node: { x: number; y: number; width: number; height: number },
  side: "input" | "output"
): { x: number; y: number } {
  return { x: node.x + (side === "output" ? node.width : 0), y: node.y + node.height / 2 };
}

/** 把尺寸 clamp 到共享下限（非有限值回退到下限）。 */
export function clampNodeSize(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, value);
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/** 四角 resize 抓手命中区域（世界坐标）。 */
export function bevyResizeHandleRects(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Record<ResizeHandle, { x: number; y: number; width: number; height: number }> {
  return {
    nw: { x: node.x, y: node.y, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE },
    ne: { x: node.x + node.width - RESIZE_HANDLE_SIZE, y: node.y, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE },
    sw: { x: node.x, y: node.y + node.height - RESIZE_HANDLE_SIZE, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE },
    se: { x: node.x + node.width - RESIZE_HANDLE_SIZE, y: node.y + node.height - RESIZE_HANDLE_SIZE, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE }
  };
}

/** 兼容旧测试/调用方：返回右下角抓手。 */
export function bevyResizeHandleRect(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return bevyResizeHandleRects(node).se;
}

/** 节点右上角历史动作的边框尺寸（世界坐标）。 */
export const NODE_HISTORY_ACTION_SIZE = 28;

/**
 * 连线删除按钮的边长（世界坐标），change: add-edge-hover-delete。
 *
 * 与参考实现的 18px 圆形按钮一致；必须与 Bevy `canvas2d::layout` 的同名常量一致
 * （由 `render-scene.test.ts` 断言两边相同）。
 */
export const EDGE_DELETE_BUTTON_SIZE = 18;

/**
 * 连线标签胶囊**最大**宽度（世界坐标）。
 *
 * 实际宽度按文本内容收缩（`edgeLabelWidth`）。固定 104px 会把两个字的标签画成八个字宽，
 * 并把删除按钮推到远离曲线的地方（修复：标签过宽导致删除按钮点不到）。
 */
export const EDGE_LABEL_MAX_WIDTH = 104;
/** 连线标签胶囊高度（世界坐标，与 Bevy 标签背景同高）。 */
export const EDGE_LABEL_HEIGHT = 24;
/** 连线标签字号（世界坐标），与 Bevy `EDGE_LABEL_FONT` 一致。 */
export const EDGE_LABEL_FONT = 11;
/** 连线标签胶囊左右内边距（世界坐标），与 Bevy `EDGE_LABEL_PADDING` 一致。 */
export const EDGE_LABEL_PADDING = 8;
/** 标签与删除按钮之间的间隙（世界坐标）。 */
export const EDGE_DELETE_BUTTON_GAP = 4;

/**
 * 连线标签胶囊宽度（世界坐标）：按文本内容收缩，超长文本封顶到 `EDGE_LABEL_MAX_WIDTH`。
 *
 * 与 Rust `edge_label_width` 同一启发式；空标签返回 0（按钮居中于连线中点）。
 */
export function edgeLabelWidth(label: string): number {
  if (!label) return 0;
  return Math.min(estimateNodeActionTextWidth(label, EDGE_LABEL_FONT) + EDGE_LABEL_PADDING * 2, EDGE_LABEL_MAX_WIDTH);
}

/**
 * 删除按钮的命中外扩（世界坐标，修复：删除按钮悬停丢失）。
 *
 * 18px 的按钮本身偏小，且按钮与标签之间还有 `EDGE_DELETE_BUTTON_GAP` 的空隙；外扩后命中区
 * 与标签右缘相接，指针从标签走到按钮时不会落进「既不在标签、也不在按钮」的死区。
 */
export const EDGE_DELETE_HIT_PADDING = 4;

/**
 * 悬停连线时「线体 → 标签 → 删除按钮」连续命中区的外扩（世界坐标，
 * 修复：删除按钮悬停丢失）。
 *
 * 有标签时按钮排在标签胶囊右侧，而连线曲线只从标签中间穿过；只按曲线距离判定命中时，
 * 指针离开线体、还没进入按钮的那段路（整个标签与间隙）会清空悬停，按钮随即消失。
 */
export const EDGE_HOVER_BRIDGE_PADDING = 8;

/** 连线中点（两端口的算术中点，与 Bevy 现有边标签定位共用同一公式）。 */
function edgeMidpoint(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const a = bevyPort(source, "output");
  const b = bevyPort(target, "input");
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 连线删除按钮的命中矩形（世界坐标），change: add-edge-hover-delete。
 *
 * 与 Bevy 绘制共用 `EDGE_DELETE_BUTTON_SIZE` / `EDGE_LABEL_*` 常量，命中判定与绘制用同一
 * 函数，保证「画在哪、点在哪」一致。
 *
 * `label` 非空时按钮排在**按内容收缩**的标签胶囊右侧（避免盖住标签，也避免固定宽度把
 * 按钮推远）；否则居中于连线中点。
 */
export function bevyEdgeDeleteRect(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  label = ""
): { x: number; y: number; width: number; height: number } {
  const center = edgeMidpoint(source, target);
  const labelWidth = edgeLabelWidth(label);
  const centerX = labelWidth > 0
    ? center.x + labelWidth / 2 + EDGE_DELETE_BUTTON_GAP + EDGE_DELETE_BUTTON_SIZE / 2
    : center.x;
  return {
    x: centerX - EDGE_DELETE_BUTTON_SIZE / 2,
    y: center.y - EDGE_DELETE_BUTTON_SIZE / 2,
    width: EDGE_DELETE_BUTTON_SIZE,
    height: EDGE_DELETE_BUTTON_SIZE
  };
}

/**
 * 连线删除按钮的**命中**矩形（世界坐标，修复：删除按钮悬停丢失）。
 *
 * 视觉仍按 `bevyEdgeDeleteRect` 绘制 18px 圆钮，命中区外扩 `EDGE_DELETE_HIT_PADDING`，
 * 在低缩放下也留出可点击余量，并补上按钮与标签胶囊之间的间隙。
 */
export function bevyEdgeDeleteHitRect(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  label = ""
): { x: number; y: number; width: number; height: number } {
  const rect = bevyEdgeDeleteRect(source, target, label);
  return {
    x: rect.x - EDGE_DELETE_HIT_PADDING,
    y: rect.y - EDGE_DELETE_HIT_PADDING,
    width: rect.width + EDGE_DELETE_HIT_PADDING * 2,
    height: rect.height + EDGE_DELETE_HIT_PADDING * 2
  };
}

/** 连线标签胶囊矩形（世界坐标，与 Bevy 标签背景同几何；宽度按内容收缩）。 */
export function bevyEdgeLabelRect(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  label = ""
): { x: number; y: number; width: number; height: number } {
  const center = edgeMidpoint(source, target);
  const width = edgeLabelWidth(label);
  return {
    x: center.x - width / 2,
    y: center.y - EDGE_LABEL_HEIGHT / 2,
    width,
    height: EDGE_LABEL_HEIGHT
  };
}

/**
 * 悬停连线时维持悬停的连续命中区（世界坐标，修复：删除按钮悬停丢失）。
 *
 * 覆盖标签胶囊与删除按钮（含两者外扩），使指针从线体经标签走到按钮时悬停不丢失。
 * 该区域只维持悬停，点击不删除；删除仍只由 `bevyEdgeDeleteHitRect` 触发。
 */
export function bevyEdgeHoverBridgeRect(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  label = ""
): { x: number; y: number; width: number; height: number } {
  const button = bevyEdgeDeleteHitRect(source, target, label);
  const labelRect = bevyEdgeLabelRect(source, target, label);
  if (labelRect.width <= 0) return button;
  const left = Math.min(labelRect.x, button.x) - EDGE_HOVER_BRIDGE_PADDING;
  const top = Math.min(labelRect.y, button.y) - EDGE_HOVER_BRIDGE_PADDING;
  const right = Math.max(labelRect.x + labelRect.width, button.x + button.width) + EDGE_HOVER_BRIDGE_PADDING;
  const bottom = Math.max(labelRect.y + labelRect.height, button.y + button.height) + EDGE_HOVER_BRIDGE_PADDING;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 节点右上角历史动作命中区域（世界坐标）
 * （change: add-canvas-node-generation-history，任务 3.1）。
 *
 * 刻意放在关闭动作**左侧**：关闭命中区是 `x+width-34 .. x+width-8`，历史动作紧邻其左，
 * 两者不重叠。Bevy 绘制用同一矩形，保证「画在哪、点在哪」一致。
 */
export function bevyNodeHistoryActionRect(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: node.x + node.width - 34 - NODE_HISTORY_ACTION_SIZE,
    y: node.y + 8,
    width: NODE_HISTORY_ACTION_SIZE,
    height: NODE_HISTORY_ACTION_SIZE
  };
}

/**
 * 节点历史条的视觉高度（世界坐标）
 * （change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * 历史圆点位于节点内部底部，无独立背景和边框。
 * Bevy 绘制与 Web 命中 MUST 共用本常量（由 `render-scene.test.ts` 断言两边一致）。
 */
export const NODE_HISTORY_STRIP_HEIGHT = 16;
/** 历史条圆点半径（世界坐标，直径约 5.2px）。 */
export const NODE_HISTORY_STRIP_DOT_RADIUS = 2.6;
/** 历史条圆点之间的最小间隙（世界坐标）。 */
export const NODE_HISTORY_STRIP_DOT_GAP = 6;
/** 历史条与节点下缘的间隙（世界坐标）。 */
export const NODE_HISTORY_STRIP_GAP = 4;
/** 历史条最左侧历史图标区域宽度（世界坐标）。 */
export const NODE_HISTORY_STRIP_ICON_SIZE = 18;
/** 历史条整体左右内边距（世界坐标）。 */
export const NODE_HISTORY_STRIP_PADDING = 6;
/** 历史条圆角半径（世界坐标）。 */
export const NODE_HISTORY_STRIP_RADIUS = 6;
/** 单节点一次展示的最大圆点数；围绕当前版本截取窗口。 */
export const NODE_HISTORY_STRIP_MAX_DOTS = 24;

/**
 * 节点历史条命中/绘制矩形（世界坐标），change: 2026-10-12。
 *
 * 圆点区域位于节点内部底部，左右留出 resize 抓手的空间。点击选择版本，拖动只平移画布。
 * Bevy 绘制与 Web 命中 MUST 共用本函数。
 */
export function bevyNodeHistoryStripRect(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: node.x + 24,
    y: node.y + node.height - NODE_HISTORY_STRIP_GAP - NODE_HISTORY_STRIP_HEIGHT,
    width: Math.max(1, node.width - 48),
    height: NODE_HISTORY_STRIP_HEIGHT
  };
}

/**
 * 历史条最左侧历史图标中心（世界坐标），change: 2026-10-12。
 *
 * 图标固定在整个横条的最左侧，表示「这里可以打开节点历史」。
 */
export function bevyNodeHistoryStripIcon(
  node: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const strip = bevyNodeHistoryStripRect(node);
  return { x: strip.x + NODE_HISTORY_STRIP_PADDING + NODE_HISTORY_STRIP_ICON_SIZE / 2, y: strip.y + strip.height / 2 };
}

/**
 * 历史圆点的中心（世界坐标），紧凑居中排列
 * （change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * 纯几何：调用方负责按 `NODE_HISTORY_STRIP_MAX_DOTS` 有界化 `count/index`。
 */
export function bevyNodeHistoryStripDot(
  node: { x: number; y: number; width: number; height: number },
  index: number,
  count: number
): { x: number; y: number } {
  const strip = bevyNodeHistoryStripRect(node);
  const clampedCount = Math.max(1, count);
  const usable = Math.max(0, strip.width - 2 * NODE_HISTORY_STRIP_PADDING);
  const step = clampedCount > 1 ? Math.min(12, usable / (clampedCount - 1)) : 0;
  const x = strip.x + strip.width / 2 + (index - (clampedCount - 1) / 2) * step;
  return { x, y: strip.y + strip.height / 2 };
}

/**
 * 拖动粘连方向（change: add-drag-touch-connections，design D3）。
 *
 * `predecessor` 表示「接触节点 -> 拖动节点」（Q 触须在左），`successor` 表示
 * 「拖动节点 -> 接触节点」（E 触须在右）。
 */
export type DragAttachMode = "predecessor" | "successor";

/**
 * 拖动粘连操作条高度（世界坐标），change: add-drag-touch-connections。
 *
 * 操作条拥有**稳定高度**并受节点宽度约束，贴着节点下缘；Bevy 镜像常量与 Web 几何共享，
 * 避免「画在哪、碰在哪」漂移（由 `render-scene.test.ts` 断言两边相同）。
 */
export const DRAG_ATTACH_ACTION_BAR_HEIGHT = 24;
/** 操作条与节点下缘的间隙（世界坐标）。 */
export const DRAG_ATTACH_ACTION_BAR_GAP = 8;
/** 触须探针的固定世界长度（从节点左右中点向外延伸）。 */
export const DRAG_ATTACH_PROBE_LENGTH = 52;

export type NodeRect = { x: number; y: number; width: number; height: number };

/**
 * 拖动粘连操作条矩形（世界坐标），change: add-drag-touch-connections。
 *
 * 横向与节点同宽（保证不超出节点宽度、无布局回流），纵向贴在节点下缘下方固定间隙处。
 * 与 Bevy 绘制共用同一函数，保证命中/绘制一致。
 */
export function bevyDragAttachActionBarRect(node: NodeRect): NodeRect {
  return {
    x: node.x,
    y: node.y + node.height + DRAG_ATTACH_ACTION_BAR_GAP,
    width: node.width,
    height: DRAG_ATTACH_ACTION_BAR_HEIGHT
  };
}

/**
 * 拖动粘连触须探针线段（世界坐标），change: add-drag-touch-connections，design D3。
 *
 * `predecessor` 从节点左中点向左外延，`successor` 从右中点向右外延，长度固定为
 * `DRAG_ATTACH_PROBE_LENGTH`。Web 碰撞与 Bevy 绘制共用同一几何。
 */
export function bevyDragAttachProbe(
  node: NodeRect,
  mode: DragAttachMode
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const y = node.y + node.height / 2;
  if (mode === "predecessor") {
    const x = node.x;
    return { from: { x, y }, to: { x: x - DRAG_ATTACH_PROBE_LENGTH, y } };
  }
  const x = node.x + node.width;
  return { from: { x, y }, to: { x: x + DRAG_ATTACH_PROBE_LENGTH, y } };
}

/**
 * 触须探针与节点矩形的相交判定（世界坐标），change: add-drag-touch-connections，design D3。
 *
 * probe 是水平线段；候选节点按视觉层级从高到低遍历，首个相交且合法的候选即接触目标。
 * 纯几何、无 DOM 依赖，供 Web 碰撞与契约测试复用。
 */
export function dragAttachProbeIntersects(
  probe: { from: { x: number; y: number }; to: { x: number; y: number } },
  rect: NodeRect
): boolean {
  const minX = Math.min(probe.from.x, probe.to.x);
  const maxX = Math.max(probe.from.x, probe.to.x);
  const y = probe.from.y;
  if (y < rect.y || y > rect.y + rect.height) return false;
  return minX <= rect.x + rect.width && maxX >= rect.x;
}

/**
 * 聚合拉线方向（change: add-multi-select-aggregate-connect，design D2）。
 *
 * `output` 从选区右侧把手出发建立「成员 -> 目标」边；`input` 从左侧把手出发建立
 * 「目标 -> 成员」边。
 */
export type AggregateConnectDirection = "input" | "output";

/**
 * 聚合把手圆钮半径与相对选区边缘的外移间隙（世界坐标）
 * （change: add-multi-select-aggregate-connect，design D2）。
 *
 * Bevy 镜像常量与契约测试锁定；命中半径沿用 `hitRadius(zoom)`（Web 侧），保证「画在哪、
 * 碰在哪」一致。
 */
export const AGGREGATE_HANDLE_RADIUS = 8;
export const AGGREGATE_HANDLE_GAP = 18;

/**
 * 选区轴对齐包围盒（世界坐标并集），change: add-multi-select-aggregate-connect，design D2。
 *
 * 空集合返回 `null`。纯几何、无 DOM 依赖，供 Web 把手定位、命中与 Bevy 绘制复用。
 */
export function bevySelectionBounds(rects: readonly NodeRect[]): NodeRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 聚合把手中心（世界坐标），change: add-multi-select-aggregate-connect，design D2。
 *
 * `input` 在包围盒左中向左外移，`output` 在右中向右外移；外移量固定为
 * `AGGREGATE_HANDLE_GAP`。Web 命中与 Bevy 绘制共用同一函数。
 */
export function bevyAggregateHandle(bounds: NodeRect, side: AggregateConnectDirection): { x: number; y: number } {
  const y = bounds.y + bounds.height / 2;
  const x = side === "output"
    ? bounds.x + bounds.width + AGGREGATE_HANDLE_GAP
    : bounds.x - AGGREGATE_HANDLE_GAP;
  return { x, y };
}

/**
 * 单节点历史条的有界圆点窗口
 * （change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * 围绕「当前版本」截取至多 `NODE_HISTORY_STRIP_MAX_DOTS` 个；圆点选择与直接版本选择
 * （历史条点击/横向滚动）共用同一窗口，避免两处各自截断导致索引漂移。
 */
export function visibleNodeHistoryVersions<T extends { current: boolean }>(items: readonly T[]): readonly T[] {
  const current = items.findIndex((item) => item.current);
  const start = Math.max(0, Math.min(items.length - NODE_HISTORY_STRIP_MAX_DOTS, current - Math.floor(NODE_HISTORY_STRIP_MAX_DOTS / 2)));
  return items.slice(start, start + NODE_HISTORY_STRIP_MAX_DOTS);
}
