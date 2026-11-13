import { builtinNodeCapabilitiesForType } from "../builtin-node-capabilities.js";
/**
 * 节点顶部操作横条的纯几何与可见性判定
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1 / design D6/D7 修订）。
 *
 * Web 动作栏用 runtime 提供的屏幕矩形锚定，并按屏幕像素排版、处理 DOM 点击。
 * 本模块只做纯几何计算，不依赖 DOM；Rust 保留旧协议消费端的同一布局供兼容使用。
 * 当前 Web scene builder 不再向 renderer 下发 nodeActions。
 */

/** 横条与节点之间固定的屏幕像素间距（design D7「约 8px」）。 */
export const NODE_ACTION_TOOLBAR_GAP = 8;
/** 单个动作控件高度（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_ACTION_HEIGHT = 32;
/** 横条容器上下内边距（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_PAD = 4;
/** 单个动作控件的最小宽度（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH = 56;
/** 动作标签与控件边缘的水平内边距（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_ACTION_PAD = 8;
/** 图标与文字同时呈现时的图标格尺寸（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_ICON_SIZE = 16;
/** 图标与文字之间的水平间距（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_ICON_GAP = 6;
/** 设置箭头独立宽度（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_CHEVRON_WIDTH = 24;
/** 动作分组之间的细分隔线占位宽度（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_SEPARATOR = 2;
/** 动作标签字号与模型名摘要字号（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_FONT = 13;
/** 模型名摘要与动作之间的水平间距（屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_SUMMARY_GAP = 8;
/** 摘要最大宽度（超出省略，屏幕像素）。 */
export const NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH = 280;
/** 顶部碰撞回退判定所用的视口安全边距（屏幕像素，仅用于「上方是否放得下」）。 */
export const NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN = 8;

export type NodeActionToolbarRect = { x: number; y: number; width: number; height: number };

/**
 * 单节点屏幕矩形（CSS px，含 canvas 外框偏移）
 * （change: 2026-10-13-add-node-to-film-set-shortcut）。
 *
 * 供宿主把横条/设置弹窗锚定到节点之上；由唯一 runtime 投影 `nodeScreenRect` 产出。
 */
export type ScreenRect = { left: number; top: number; width: number; height: number };

/** 一个横条动作（按钮）；`menu` 为真时其后紧跟一个独立设置箭头矩形。 */
export type NodeActionToolbarAction = {
  /** 通用动作强调与图标呈现。 */
  tone?: "primary" | "neutral";
  icon?: "download" | "edit" | "box" | "arrange-horizontal" | "arrange-vertical" | "arrange-grid" | "arrange-diagonal-up" | "arrange-diagonal-down" | "collapse-groups" | "expand-groups" | "rotate-clockwise";
  iconOnly?: boolean;
  /** 稳定动作 ID（命中回传，贡献据此派发）。 */
  id: string;
  /** 可见文案（中文）。 */
  label: string;
  /** 是否可用；Web 按钮在 false 时禁用。 */
  enabled: boolean;
  /** 是否附带独立设置箭头。 */
  menu?: boolean;
};

export type NodeActionToolbarLayoutInput = {
  /** 节点世界矩形（含 working 拖动/改尺寸后的投影）。 */
  node: { x: number; y: number; width: number; height: number };
  /** 按从左到右顺序排列的动作。 */
  actions: readonly NodeActionToolbarAction[];
  /** 节点摘要（可选，显示在动作左侧）。 */
  summary?: string;
  /** 当前视口（世界→屏幕用于顶部碰撞判定）；缺省时始终置顶。 */
  viewport?: { x: number; y: number; zoom: number };
  /** 应用视口尺寸（屏幕像素）。 */
  surface?: { width: number; height: number };
};

export type NodeActionToolbarLayout = {
  /** 横条容器矩形（世界坐标），与布局一并使用。 */
  bar: NodeActionToolbarRect;
  /** 动作矩形，与输入 `actions` 同序。 */
  actions: NodeActionToolbarRect[];
  /** 设置箭头矩形，与输入 `actions` 同序；无箭头者为 null。 */
  menus: (NodeActionToolbarRect | null)[];
  /** 模型名摘要矩形（含截断后文本）或 null。 */
  summary: { text: string; rect: NodeActionToolbarRect } | null;
  /**
   * 最终选择的位置：`above` 默认、`below` 上方放不下但下方放得下时回退。
   *
   * 上下两侧都放不下时保持 `above` 并把横条钳制在视口内（design D2，change:
   * 2026-10-16-add-group-selection-toolbar）。
   */
  placement: "above" | "below";
};

/** 估算文本宽度（与 Rust `layout::estimated_text_width` 同一启发式；ASCII≈0.62×字号）。 */
export function estimateNodeActionTextWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += char.codePointAt(0)! <= 0x7f ? size * 0.62 : size;
  return width;
}

/** 按最大宽度截断文本（超出加省略号），返回带省略号的最终文本。 */
export function truncateNodeActionText(text: string, size: number, maxWidth: number): string {
  if (estimateNodeActionTextWidth(text, size) <= maxWidth) return text;
  const ellipsis = "…";
  const budget = maxWidth - estimateNodeActionTextWidth(ellipsis, size);
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = char.codePointAt(0)! <= 0x7f ? size * 0.62 : size;
    if (width + charWidth > budget) break;
    width += charWidth;
    result += char;
  }
  return `${result}${ellipsis}`;
}

/**
 * 计算横条及其各动作矩形（纯几何，世界坐标）。
 *
 * - 横条水平居中于节点；
 * - 默认放在节点**上方** `GAP`；上方在应用视口内放不下、下方放得下时回退到**下方**并保留
 *   同一间距；上下两侧都放不下时保持上方并把横条钳制在视口内（允许覆盖节点空白或成员，
 *   change: 2026-10-16-add-group-selection-toolbar design D2）；
 * - 目标完全移出视口时返回 null（不呈现也不保留吸附热区）；
 * - 摘要排在左侧，动作从左到右排列，声明 `menu` 的动作后紧跟独立箭头；
 * - 无动作时返回 null（不呈现横条）。
 *
 * 缺省 viewport/surface 时不做可见性与回退判定（保持旧的「始终置顶」行为，供无视口的
 * 纯几何用例使用）。
 */
export function nodeActionToolbarLayout(
  input: NodeActionToolbarLayoutInput
): NodeActionToolbarLayout | null {
  const zoom = input.viewport?.zoom && Number.isFinite(input.viewport.zoom) && input.viewport.zoom > 0 ? input.viewport.zoom : 1;
  const node = { x: input.node.x * zoom, y: input.node.y * zoom, width: input.node.width * zoom, height: input.node.height * zoom };
  const { actions } = input;
  if (actions.length === 0) return null;
  const height = NODE_ACTION_TOOLBAR_ACTION_HEIGHT;

  // 摘要（可选）：先截断到最大宽度，宽度计入横条。
  const summaryText = input.summary?.trim() ? truncateNodeActionText(input.summary!.trim(), NODE_ACTION_TOOLBAR_FONT, NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH) : null;
  const summaryWidth = summaryText ? estimateNodeActionTextWidth(summaryText, NODE_ACTION_TOOLBAR_FONT) : 0;

  // 每个动作宽度：图标按钮固定高度见方；图标 + 文字时同时容纳图标格与文案。
  const actionWidths = actions.map((action) => {
    if (action.iconOnly) return NODE_ACTION_TOOLBAR_ACTION_HEIGHT;
    const text = Math.ceil(estimateNodeActionTextWidth(action.label, NODE_ACTION_TOOLBAR_FONT));
    const icon = action.icon ? NODE_ACTION_TOOLBAR_ICON_SIZE + NODE_ACTION_TOOLBAR_ICON_GAP : 0;
    return Math.max(NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH, text + icon + NODE_ACTION_TOOLBAR_ACTION_PAD * 2);
  });
  const chevronCount = actions.filter((action) => action.menu).length;
  const separatorWidth = Math.max(0, actions.length - 1) * NODE_ACTION_TOOLBAR_SEPARATOR;
  const contentWidth =
    actionWidths.reduce((sum, width) => sum + width, 0) +
    chevronCount * NODE_ACTION_TOOLBAR_CHEVRON_WIDTH +
    separatorWidth +
    (summaryText ? summaryWidth + NODE_ACTION_TOOLBAR_SUMMARY_GAP : 0);
  const barWidth = contentWidth + NODE_ACTION_TOOLBAR_PAD * 2;
  const barHeight = height + NODE_ACTION_TOOLBAR_PAD * 2;

  const centeredX = node.x + node.width / 2 - barWidth / 2;
  const aboveY = node.y - NODE_ACTION_TOOLBAR_GAP - barHeight;
  const belowY = node.y + node.height + NODE_ACTION_TOOLBAR_GAP;

  // 视口可见性：目标矩形与视口完全不相交时隐藏（不保留吸附工具栏）。
  if (input.viewport && input.surface) {
    const { viewport, surface } = input;
    const nodeLeft = node.x + viewport.x;
    const nodeTop = node.y + viewport.y;
    const nodeRight = nodeLeft + node.width;
    const nodeBottom = nodeTop + node.height;
    const noOverlapX = nodeRight < 0 || nodeLeft > surface.width;
    const noOverlapY = nodeBottom < 0 || nodeTop > surface.height;
    if (noOverlapX || noOverlapY) return null;
  }

  // 位置回退：默认上方；上方放不下且下方放得下时改放下方；两侧都放不下则保持上方并在下方
  // 统一钳制到视口内（允许覆盖节点空白或成员）。
  let placement: "above" | "below" = "above";
  if (input.viewport && input.surface) {
    const { viewport, surface } = input;
    const margin = NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN;
    const screenTopAbove = aboveY + viewport.y;
    if (screenTopAbove < margin) {
      const screenBottomBelow = belowY + viewport.y + barHeight;
      if (screenBottomBelow <= surface.height - margin) placement = "below";
    }
  }
  let barY = placement === "above" ? aboveY : belowY;
  let barX = centeredX;
  if (input.viewport && input.surface) {
    const margin = NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN;
    barX = Math.max(margin - input.viewport.x, Math.min(barX, input.surface.width - margin - barWidth - input.viewport.x));
    barY = Math.max(margin - input.viewport.y, Math.min(barY, input.surface.height - margin - barHeight - input.viewport.y));
  }
  const bar: NodeActionToolbarRect = { x: barX, y: barY, width: barWidth, height: barHeight };

  let cursor = bar.x + NODE_ACTION_TOOLBAR_PAD;
  let summary: { text: string; rect: NodeActionToolbarRect } | null = null;
  if (summaryText) {
    summary = {
      text: summaryText,
      rect: { x: cursor, y: bar.y + NODE_ACTION_TOOLBAR_PAD, width: summaryWidth, height }
    };
    cursor += summaryWidth + NODE_ACTION_TOOLBAR_SUMMARY_GAP;
  }
  const actionRects: NodeActionToolbarRect[] = [];
  const menuRects: (NodeActionToolbarRect | null)[] = [];
  actions.forEach((action, index) => {
    const width = actionWidths[index]!;
    actionRects.push({ x: cursor, y: bar.y + NODE_ACTION_TOOLBAR_PAD, width, height });
    cursor += width;
    if (action.menu) {
      menuRects.push({ x: cursor, y: bar.y + NODE_ACTION_TOOLBAR_PAD, width: NODE_ACTION_TOOLBAR_CHEVRON_WIDTH, height });
      cursor += NODE_ACTION_TOOLBAR_CHEVRON_WIDTH;
    } else {
      menuRects.push(null);
    }
    if (index < actions.length - 1) cursor += NODE_ACTION_TOOLBAR_SEPARATOR;
  });

  const world = (rect: NodeActionToolbarRect): NodeActionToolbarRect => ({ x: rect.x / zoom, y: rect.y / zoom, width: rect.width / zoom, height: rect.height / zoom });
  return { bar: world(bar), actions: actionRects.map(world), menus: menuRects.map(rect => rect ? world(rect) : null), summary: summary ? { text: summary.text, rect: world(summary.rect) } : null, placement };
}

/**
 * 显示节点操作横条的节点类型（design D7：「单选图片、视频或 3D」；
 * change: 2026-10-16-add-group-selection-toolbar 增加 `group`）。
 *
 * 属于**渲染宿主**的通用呈现规则：宿主只按通用 node type 判定是否呈现单节点横条，
 * MUST NOT 按具体扩展 ID 分支。复合资产可以提供自己的动作；没有贡献时不绘制横条。
 */
export type NodeActionToolbarNodeType = string;
export function isNodeActionToolbarNodeType(nodeType: string): boolean {
  return !!builtinNodeCapabilitiesForType(nodeType).actions;
}

/**
 * 解析单节点横条目标（纯函数）：仅在**恰好单选**一个适用类型的节点时返回该节点。
 *
 * 多选、取消选择、选中不适用类型或目标不在当前 working projection 中时返回 null（隐藏横条，
 * 不因此取消任何已受理的后台工作）。来源身份在此固定，激活后不随 selection 变化。
 *
 * `group` 与其他适用类型一样按最终选区判定：完整成员选区经选择服务规范化为单个 group 时
 * 同样显示 group 横条（change: 2026-10-16-add-group-selection-toolbar design D1）。
 */
export function resolveNodeActionToolbarTarget(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly { id: string; type: string }[];
  accepts?: (nodeId: string) => boolean;
}): { nodeId: string; nodeType: NodeActionToolbarNodeType } | null {
  if (input.selectedNodeIds.length !== 1) return null;
  const nodeId = input.selectedNodeIds[0]!;
  const node = input.nodes.find((entry) => entry.id === nodeId);
  if (!node || !(input.accepts ? input.accepts(node.id) : isNodeActionToolbarNodeType(node.type))) return null;
  return { nodeId, nodeType: node.type };
}

/** 多选动作横条至少需要的选中节点数（change: 2026-10-16-add-group-selection-toolbar）。 */
export const SELECTION_ACTION_TOOLBAR_MIN_NODES = 2;

/**
 * 解析多选动作横条目标（纯函数）：**恰好**选中 ≥2 个仍存在的节点时返回这些节点。
 *
 * 横条锚定选区轴对齐包围盒顶部，由 Bevy 绘制、Rust 命中；动作内容由宿主按选区判定（打组、
 * 解组）。单选、取消选择、聚焦或目标已从 working projection 移除时返回 null。只返回稳定
 * nodeId 列表，不计算几何——几何由 `nodeActionToolbarLayout` 与 Rust 对选区包围盒派生
 * （change: 2026-10-16-add-group-selection-toolbar）。
 */
export function resolveSelectionActionToolbarTarget(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly { id: string }[];
}): { nodeIds: string[] } | null {
  if (input.selectedNodeIds.length < SELECTION_ACTION_TOOLBAR_MIN_NODES) return null;
  const known = new Set(input.nodes.map((entry) => entry.id));
  const nodeIds: string[] = [];
  for (const id of input.selectedNodeIds) {
    if (known.has(id) && !nodeIds.includes(id)) nodeIds.push(id);
  }
  return nodeIds.length >= SELECTION_ACTION_TOOLBAR_MIN_NODES ? { nodeIds } : null;
}
