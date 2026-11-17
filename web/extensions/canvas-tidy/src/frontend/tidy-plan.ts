/**
 * 整理所选卡片的纯规划函数。
 *
 * 一次完成三件事，返回**同一批** `node.update`（调用方经 `canvasEdit.record` 提交，因此整次整理
 * 是一条可撤销记录）：
 *
 * 1. **等比缩回过大卡片**：只缩不放。当前尺寸超出该类型默认卡片尺寸时，按宽高比缩到能同时装进
 *    默认尺寸，并夹在该类型最小尺寸之上；
 * 2. **网格重排**：按文档顺序做书架式（shelf）排布，固定间距、逐行累加，行高取该行最高卡片；
 * 3. **锚点**：整个选区左上角保持原选区包围盒左上角，整理不会把内容整体搬到别处。
 *
 * ## 2D 组是原子单元
 *
 * `workflow-group-2d` 的成员以**绝对坐标**存在 `nodeData.workflowGroup2d.memberNodeIds` 里，宿主
 * 拖动组卡片时把成员并入同一批 origins 整体平移（[interaction-2d-input.ts] 的 2D 组整体移动）。
 * 换句话说：**成员与组卡片的相对关系就是组的全部内容**。
 *
 * 因此这里把「组卡片 + 它的成员」整体当**一个不可分割的单元**：
 * - 单元只做**刚性平移**，成员的相对位置与组卡片的尺寸都不改 —— 按普通卡片重排会把人从组里拆出去；
 * - 单元的占位尺寸取「组卡片 ∪ 全部成员」的包围盒，不会缩回标准尺寸（缩组卡片会让成员溢出框外）；
 * - 选区里**只**出现组成员而没有它的组（没选组卡片）时明确拒绝，而不是把这些成员单独挪走。
 *
 * 组内成员怎么排是组自己的事（`world-scopes` 的宫格/竖排/横排），本扩展不做，也不改成员集合。
 *
 * 只处理**有卡片的节点**：共享世界对象与导演区没有卡片坐标，规范化会丢弃它们的
 * position/width/height，对它们规划尺寸或位置只会被静默丢弃或报错，所以在入口明确拒绝。
 */
import {
  builtinNodeCapabilitiesForType,
  decodeWorkflowGroupData,
  DEFAULT_NODE_DIMS,
  effectiveCanvasNodeSize,
  minimumNodeSizeFor,
  nodeHasCanvasCard,
  type CanvasCommand,
  type ServerCanvas,
  type Woohaa3CanvasSerializedNode
} from "@woohaa3/contracts";
import { layeredLayout, type LayoutEdge } from "./dag-layout.js";

/** 卡片之间的固定间距（世界单位）。取两格网格，和新建节点的默认避让间距一致。 */
export const TIDY_GAP = 40;

/**
 * 列间距相对行间距的倍数（仅分层排布使用）。
 *
 * 左右相邻两列之间要留出连线空间：源卡片的输出端口在右侧、目标卡片的输入端口在左侧，
 * 列距太近会把这些边压成几乎垂直的短线，读不出方向。
 */
export const COLUMN_GAP_RATIO = 2.5;

/** 默认把过大的卡片缩回标准尺寸。 */
export const DEFAULT_SHRINK_OVERSIZED = true;

/**
 * 默认缩放阈值：`1` 表示严格按该类型的标准卡片尺寸。
 *
 * 调大会容忍更大的卡片（只缩真正离谱的），由扩展设置暴露给用户。
 */
export const DEFAULT_MAX_CARD_SCALE = 1;

/** 2D 组节点的画布类型。 */
const GROUP_NODE_TYPE = "workflow-group-2d";

export type TidyPlanOptions = {
  /** 卡片间距；缺省 `TIDY_GAP`。 */
  gap?: number;
  /** 列间距相对行间距的倍数；缺省 `COLUMN_GAP_RATIO`。 */
  columnGapRatio?: number;
  /** 是否把过大的卡片等比缩回标准尺寸；缺省 `DEFAULT_SHRINK_OVERSIZED`。 */
  shrinkOversized?: boolean;
  /**
   * 缩放阈值系数：卡片超过「标准尺寸 × 该系数」才缩；缺省 `DEFAULT_MAX_CARD_SCALE`（严格按标准尺寸）。
   */
  maxCardScale?: number;
};

export type TidyPlanResult =
  | { ok: true; commands: CanvasCommand[] }
  | { ok: false; reason: string };

/** 该类型的「标准卡片尺寸」；未知类型回落到通用卡片尺寸。 */
function defaultCardSizeFor(type: string): { width: number; height: number } {
  return builtinNodeCapabilitiesForType(type).appearance?.defaultSize ?? DEFAULT_NODE_DIMS;
}

/**
 * 等比缩回：只缩不放，保持宽高比，并夹在该类型最小尺寸之上。
 *
 * `maxScale` 是容忍阈值：卡片超过「标准尺寸 × maxScale」才缩，缩完仍按标准尺寸。
 * 传 `false` 给 `enabled` 则完全不缩放（设置里的开关）。
 *
 * 只有某一轴超过阈值时才返回新尺寸；否则原样返回（不做「把小卡片放大」）。
 */
export function shrinkToStandardCardSize(
  type: string,
  size: { width: number; height: number },
  options: { enabled?: boolean; maxScale?: number } = {}
): { width: number; height: number } {
  if (options.enabled === false) return { width: size.width, height: size.height };
  const standard = defaultCardSizeFor(type);
  const minimum = minimumNodeSizeFor(type);
  const tolerance = standard.width && standard.height
    ? { width: standard.width * (options.maxScale ?? DEFAULT_MAX_CARD_SCALE), height: standard.height * (options.maxScale ?? DEFAULT_MAX_CARD_SCALE) }
    : standard;
  const scale = Math.min(tolerance.width / size.width, tolerance.height / size.height);
  if (!(scale < 1)) return { width: size.width, height: size.height };
  // 先按比例缩再夹最小尺寸：夹完可能略超标准（极窄长卡片），那也比重叠更可读。
  return {
    width: Math.max(minimum.width, Math.round(size.width * scale)),
    height: Math.max(minimum.height, Math.round(size.height * scale))
  };
}

/**
 * 一个整理单元：单张卡片，或「组卡片 + 全部成员」。
 */
export type TidyUnit = {
  /** 单元的代表节点（组单元取组卡片）；用于排序与诊断。 */
  representativeId: string;
  /** 参与平移的节点（组单元含组卡片与全部成员）。 */
  nodeIds: string[];
  /** 单张卡片才允许缩放；组单元只平移。 */
  resize: { width: number; height: number } | null;
  /** 单元占位包围盒（世界坐标）；`resize` 非空时宽高是缩放后的值。 */
  bounds: { x: number; y: number; width: number; height: number };
};

/** 画布上所有组的「成员 → 组卡片」索引；成员表非法或成员不存在时按组数据原样记录。 */
function groupMembershipIndex(canvas: ServerCanvas): Map<string, string> {
  const byMember = new Map<string, string>();
  const byId = new Set(canvas.document.nodes.map((node) => node.id));
  for (const node of canvas.document.nodes) {
    if (node.type !== GROUP_NODE_TYPE) continue;
    const decoded = decodeWorkflowGroupData(
      (canvas.nodeData[node.id] as Record<string, unknown> | undefined)?.workflowGroup2d
    );
    if (!decoded.ok) continue;
    for (const memberId of decoded.value.memberNodeIds) {
      if (!byId.has(memberId)) continue;
      byMember.set(memberId, node.id);
    }
  }
  return byMember;
}

/** 组的全部成员节点（跳过缺位置与嵌套组；组不允许嵌套，这里只是防御）。 */
function groupMemberNodes(
  canvas: ServerCanvas,
  groupId: string
): { ok: true; members: Woohaa3CanvasSerializedNode[] } | { ok: false; reason: string } {
  const group = canvas.document.nodes.find((node) => node.id === groupId);
  if (!group) return { ok: false, reason: "2D 组已不存在" };
  const decoded = decodeWorkflowGroupData(
    (canvas.nodeData[groupId] as Record<string, unknown> | undefined)?.workflowGroup2d
  );
  if (!decoded.ok) return { ok: false, reason: "2D 组数据无效，请先在组里修复后再整理" };
  const members: Woohaa3CanvasSerializedNode[] = [];
  for (const memberId of decoded.value.memberNodeIds) {
    const member = canvas.document.nodes.find((node) => node.id === memberId);
    if (!member || member.type === GROUP_NODE_TYPE || !member.position) continue;
    members.push(member);
  }
  return { ok: true, members };
}

/**
 * 规划一次整理。
 *
 * 选区不足两个单元、选区已不存在、选中了组成员却没选它的组、或含无卡片对象时返回 `ok:false`。
 * 整理后与整理前完全一致时返回空命令数组，调用方据此不落一条空的历史记录。
 */
export function planTidySelection(
  canvas: ServerCanvas,
  selectedNodeIds: readonly string[],
  options: TidyPlanOptions = {}
): TidyPlanResult {
  const gap = options.gap ?? TIDY_GAP;
  const columnGapRatio = options.columnGapRatio ?? COLUMN_GAP_RATIO;
  const shrinkOptions = {
    enabled: options.shrinkOversized ?? DEFAULT_SHRINK_OVERSIZED,
    maxScale: options.maxCardScale ?? DEFAULT_MAX_CARD_SCALE
  };
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));

  // 去重但保持选择顺序：用户多选时的点击顺序就是他们心里的流程顺序。
  const selected: Woohaa3CanvasSerializedNode[] = [];
  for (const id of [...new Set(selectedNodeIds)]) {
    const node = byId.get(id);
    if (!node) return { ok: false, reason: "部分选中作品已不存在，请刷新后重试" };
    selected.push(node);
  }

  // 有卡片才能整理：共享世界对象与导演区没有卡片坐标。
  const worldSelection = selected.find(
    (node) => !node.position || !nodeHasCanvasCard(node, canvas.nodeData[node.id] as Record<string, unknown> | undefined)
  );
  if (worldSelection) {
    return { ok: false, reason: "请选择画布卡片整理，世界对象请在导演区中调整" };
  }
  // 组成员必须与它的组一起整理：单独挪成员会把人从组里拆出去。
  const groupOfMemo = groupMembershipIndex(canvas);
  const selectedIds = new Set(selected.map((node) => node.id));
  const orphanMember = selected.find((node) => {
    if (node.type === GROUP_NODE_TYPE) return false;
    const groupId = groupOfMemo.get(node.id);
    return groupId !== undefined && !selectedIds.has(groupId);
  });
  if (orphanMember) {
    const groupId = groupOfMemo.get(orphanMember.id)!;
    const title = (canvas.nodeData[groupId] as { title?: unknown } | undefined)?.title;
    return {
      ok: false,
      reason: `选区含「${typeof title === "string" && title.trim() ? title : "2D 组"}」的组内成员。组是一个整体，请连同组卡片一起选择后再整理。`
    };
  }

  // 1. 组装单元：组卡片与其成员合成一个刚性单元，其余节点各成一个单元。
  const units: TidyUnit[] = [];
  const consumed = new Set<string>();
  for (const node of selected) {
    if (consumed.has(node.id)) continue;
    if (node.type === GROUP_NODE_TYPE) {
      const read = groupMemberNodes(canvas, node.id);
      if (!read.ok) return { ok: false, reason: read.reason };
      const parts = [node, ...read.members];
      for (const part of parts) consumed.add(part.id);
      // 组卡片尺寸即组框尺寸：缩它会让成员溢出框外，所以组单元从不缩放。
      units.push({
        representativeId: node.id,
        nodeIds: parts.map((part) => part.id),
        resize: null,
        bounds: boundingBox(parts)
      });
      continue;
    }
    consumed.add(node.id);
    const current = effectiveCanvasNodeSize(node);
    const target = shrinkToStandardCardSize(node.type, current, shrinkOptions);
    units.push({
      representativeId: node.id,
      nodeIds: [node.id],
      resize: target.width === current.width && target.height === current.height ? null : target,
      bounds: { x: node.position!.x, y: node.position!.y, width: target.width, height: target.height }
    });
  }
  // 「至少两个对象」按单元算：单独选中一个组也算一个整理目标，但那样没有重排可言。
  if (units.length < 2) return { ok: false, reason: "至少选择两个作品才能整理" };

  // 2. 锚点：原选区包围盒左上角。整理只改排布，不搬运整个选区。
  const anchorX = Math.min(...units.map((unit) => unit.bounds.x));
  const anchorY = Math.min(...units.map((unit) => unit.bounds.y));
  const boundsRight = Math.max(...units.map((unit) => unit.bounds.x + unit.bounds.width));

  // 3. 把连线归约成单元之间的依赖：源节点所在的单元 → 目标节点所在的单元。
  const unitOfNode = new Map<string, number>();
  units.forEach((unit, index) => { for (const id of unit.nodeIds) unitOfNode.set(id, index); });
  const edges: LayoutEdge[] = [];
  for (const edge of canvas.document.edges) {
    const from = unitOfNode.get(edge.source);
    const to = unitOfNode.get(edge.target);
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to });
  }

  // 4. 分层排布：有依赖就按左右列排（源在左、目标在右），没依赖的单独排在下方。
  const layout = layeredLayout({
    items: units.map((unit) => ({ width: unit.bounds.width, height: unit.bounds.height })),
    edges,
    columnGap: gap * columnGapRatio,
    rowGap: gap,
    // 孤立项用原选区宽度铺开，避免退化成一列。
    preferredWidth: boundsRight - anchorX
  });

  const commands: CanvasCommand[] = [];
  units.forEach((unit, index) => {
    const target = layout.positions[index]!;
    const dx = anchorX + target.x - unit.bounds.x;
    const dy = anchorY + target.y - unit.bounds.y;
    for (const id of unit.nodeIds) {
      const node = byId.get(id)!;
      const position = { x: node.position!.x + dx, y: node.position!.y + dy };
      const positionChanged = node.position!.x !== position.x || node.position!.y !== position.y;
      // 只有单元代表节点（单张卡片）可能带尺寸变化；组成员尺寸永远不动。
      const resizeTarget = id === unit.representativeId ? unit.resize : null;
      const sizeChanged = !!resizeTarget
        && (node.width !== resizeTarget.width || node.height !== resizeTarget.height);
      if (!positionChanged && !sizeChanged) continue;
      commands.push({
        type: "node.update",
        nodeId: id,
        ...(positionChanged ? { position } : {}),
        ...(sizeChanged ? { width: resizeTarget!.width, height: resizeTarget!.height } : {})
      });
    }
  });
  return { ok: true, commands };
}

/**
 * 选区可整理的锚点（纯函数）：**按钮的呈现条件就是它**。
 *
 * 与 `planTidySelection` 的可执行条件保持一致：真能整理才返回锚点，否则返回 null。这条一致性
 * 是刻意的——按钮只在能成功时出现，用户不会点到一个注定失败的按钮再被错误弹窗打断。
 *
 * `candidateNodeIds` 是带卡片位置的选中节点（由调用方过滤，因为它还需要渲染顺序）。
 */
export function tidyAnchorOfSelection(
  canvas: ServerCanvas | null,
  selectedNodeIds: readonly string[]
): { nodeIds: string[]; worldTopLeft: { x: number; y: number }; groups: TidyGroupTarget[] } | null {
  if (!canvas) return null;
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  // 去重保持顺序，与规划同一口径。
  const nodes: Woohaa3CanvasSerializedNode[] = [];
  for (const id of [...new Set(selectedNodeIds)]) {
    const node = byId.get(id);
    if (node?.position) nodes.push(node);
  }
  // 单选、空选都不归这里管：单选由宿主的节点动作横条负责。
  if (nodes.length < 2) return null;
  // 用真正的规划做门禁：不可整理时不出现按钮。
  if (!planTidySelection(canvas, selectedNodeIds).ok) return null;
  return {
    nodeIds: nodes.map((node) => node.id),
    worldTopLeft: {
      x: Math.min(...nodes.map((node) => node.position!.x)),
      y: Math.min(...nodes.map((node) => node.position!.y))
    },
    groups: tidyGroupTargets(canvas, selectedNodeIds)
  };
}

/** 一组节点（含本身没有位置的）的世界包围盒；缺位置按 0 处理。 */
function boundingBox(nodes: readonly Woohaa3CanvasSerializedNode[]): { x: number; y: number; width: number; height: number } {
  const rects = nodes.map((node) => ({
    x: node.position?.x ?? 0,
    y: node.position?.y ?? 0,
    ...effectiveCanvasNodeSize(node)
  }));
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 选区里可以被「组内整理」的 2D 组：有成员才有排布可言。 */
export type TidyGroupTarget = { groupId: string; title: string; memberCount: number };

/**
 * 找出选区里可整理内部的 2D 组（供组内整理入口使用）。
 *
 * 只返回成员数 > 0 的组：空组没有可排的东西，按钮就不该出现。选区里的组成员不会被当成组候选
 * ——要排组内成员，用户得选那个组卡片。
 */
export function tidyGroupTargets(canvas: ServerCanvas | null, selectedNodeIds: readonly string[]): TidyGroupTarget[] {
  if (!canvas) return [];
  const selected = new Set(selectedNodeIds);
  const targets: TidyGroupTarget[] = [];
  for (const node of canvas.document.nodes) {
    if (node.type !== GROUP_NODE_TYPE || !selected.has(node.id)) continue;
    const read = groupMemberNodes(canvas, node.id);
    if (!read.ok || read.members.length === 0) continue;
    const title = (canvas.nodeData[node.id] as { title?: unknown } | undefined)?.title;
    targets.push({
      groupId: node.id,
      title: typeof title === "string" && title.trim() ? title : "2D 组",
      memberCount: read.members.length
    });
  }
  return targets;
}
