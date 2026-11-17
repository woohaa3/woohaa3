/**
 * 2D 组的排布纯规则（成员解析、宫格/竖排/横排规划、整体平移）。
 *
 * 自前端 `cordis/plugins/world-scopes/group-actions.ts` 上提到 contracts
 * （change: 一键整理扩展需要同一份规则）：
 * - 宿主的组卡片顶部栏按钮与浏览器扩展都要排组内成员，规则只能有一份；
 * - 这里是纯数据变换，不读写 store、不提交命令、不持有控制器状态，符合 contracts 的职责边界。
 *
 * 成员以**绝对坐标**存在 `nodeData.workflowGroup2d.memberNodeIds`；组卡片与成员的相对关系就是组的
 * 全部内容，因此所有动作要么整体平移、要么同时改成员与组框，绝不只动一边。
 */
import type { ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";
import { decodeWorkflowGroupData } from "./creation-scope-codec.js";
import { bevyKindForNodeType, bevyNodeSize } from "./render-scene/node-geometry.js";
import type { CanvasCommand } from "./commands.js";

/** 与内置 `workflow-group-2d` 能力声明的 defaultSize 保持一致。 */
export const GROUP_DEFAULT_WIDTH = 260;
export const GROUP_DEFAULT_HEIGHT = 195;
export const GROUP_TIDY_GAP = 24;
export const GROUP_TIDY_PADDING = 24;

/** 组内成员的整理方式。 */
export type GroupArrangeMode = "grid" | "vertical" | "horizontal";

type Point = { x: number; y: number };

export type GroupLayoutMember = {
  nodeId: string;
  position: Point;
  width: number;
  height: number;
};

export type GroupLayout = {
  groupId: string;
  position: Point;
  width: number;
  height: number;
  groupScopeVersion: string;
  members: GroupLayoutMember[];
};

export type GroupLayoutResult =
  | { ok: true; layout: GroupLayout }
  | { ok: false; reason: string };

export type GroupPlanResult =
  | { ok: true; commands: CanvasCommand[]; label: string }
  | { ok: false; reason: string };

function memberSize(node: Woohaa3CanvasSerializedNode): { width: number; height: number } {
  if (node.type === "workflow-group-2d") {
    return {
      width: node.width && node.width > 0 ? node.width : GROUP_DEFAULT_WIDTH,
      height: node.height && node.height > 0 ? node.height : GROUP_DEFAULT_HEIGHT
    };
  }
  const fallback = bevyNodeSize(bevyKindForNodeType(node.type));
  return {
    width: node.width && node.width > 0 ? node.width : fallback.width,
    height: node.height && node.height > 0 ? node.height : fallback.height
  };
}

/** 解析组、成员绝对位置与尺寸；成员缺失或组数据非法时失败而不是猜测。 */
export function readGroupLayout(canvas: ServerCanvas | null, groupId: string): GroupLayoutResult {
  if (!canvas) return { ok: false, reason: "画布尚未加载" };
  const node = canvas.document.nodes.find(entry => entry.id === groupId);
  if (!node || node.type !== "workflow-group-2d") return { ok: false, reason: "不是 2D 组" };
  const decoded = decodeWorkflowGroupData((canvas.nodeData[node.id] as Record<string, unknown> | undefined)?.workflowGroup2d);
  if (!decoded.ok) return { ok: false, reason: "2D 组数据无效" };
  const size = memberSize(node);
  if (!node.position) return { ok: false, reason: "2D 组没有卡片位置" };
  const members: GroupLayoutMember[] = [];
  for (const memberId of decoded.value.memberNodeIds) {
    const member = canvas.document.nodes.find(entry => entry.id === memberId);
    if (!member || member.type === "workflow-group-2d" || !member.position) continue;
    const memberDimensions = memberSize(member);
    members.push({
      nodeId: member.id,
      position: { x: member.position.x, y: member.position.y },
      width: memberDimensions.width,
      height: memberDimensions.height
    });
  }
  return {
    ok: true,
    layout: {
      groupId: groupId,
      position: { x: node.position.x, y: node.position.y },
      width: size.width,
      height: size.height,
      groupScopeVersion: decoded.value.scopeVersion,
      members
    }
  };
}

function groupCommand(layout: GroupLayout, position: Point, width: number, height: number): CanvasCommand {
  return {
    type: "node.update",
    nodeId: layout.groupId,
    position: { x: position.x, y: position.y },
    width: Math.max(GROUP_DEFAULT_WIDTH, Math.round(width)),
    height: Math.max(GROUP_DEFAULT_HEIGHT, Math.round(height))
  };
}

/**
 * 整理成员：按宫格/竖排/横排重排，成员左上角从组左上角内缩 padding 起排；
 * 组卡片范围同步扩到外接框。一次 `record` 可整体撤销。
 */
export function planGroupArrange(layout: GroupLayout, mode: GroupArrangeMode): GroupPlanResult {
  if (!layout.members.length) return { ok: false, reason: "2D 组没有可整理的成员" };
  const columns = mode === "vertical"
    ? 1
    : mode === "horizontal"
      ? layout.members.length
      : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(layout.members.length))));
  const rows = Math.ceil(layout.members.length / columns);
  const cellWidth = Math.max(...layout.members.map(member => member.width));
  const cellHeight = Math.max(...layout.members.map(member => member.height));
  const startX = layout.position.x + GROUP_TIDY_PADDING;
  const startY = layout.position.y + GROUP_TIDY_PADDING;
  const commands: CanvasCommand[] = [];
  layout.members.forEach((member, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    commands.push({
      type: "node.update",
      nodeId: member.nodeId,
      position: {
        x: Math.round(startX + column * (cellWidth + GROUP_TIDY_GAP)),
        y: Math.round(startY + row * (cellHeight + GROUP_TIDY_GAP))
      }
    });
  });
  const width = GROUP_TIDY_PADDING * 2 + columns * cellWidth + (columns - 1) * GROUP_TIDY_GAP;
  const height = GROUP_TIDY_PADDING * 2 + rows * cellHeight + (rows - 1) * GROUP_TIDY_GAP;
  commands.unshift(groupCommand(layout, layout.position, width, height));
  return {
    ok: true,
    commands,
    label: mode === "vertical" ? "竖排 2D 组成员" : mode === "horizontal" ? "横排 2D 组成员" : "宫格整理 2D 组成员"
  };
}

/** 兼容旧入口：宫格整理。 */
export function planGroupTidy(layout: GroupLayout): GroupPlanResult {
  return planGroupArrange(layout, "grid");
}

/** 框住成员：只改组卡片位置/尺寸，不移动成员。 */
export function planGroupFit(layout: GroupLayout): GroupPlanResult {
  if (!layout.members.length) return { ok: false, reason: "2D 组没有可框定的成员" };
  const left = Math.min(...layout.members.map(member => member.position.x));
  const top = Math.min(...layout.members.map(member => member.position.y));
  const right = Math.max(...layout.members.map(member => member.position.x + member.width));
  const bottom = Math.max(...layout.members.map(member => member.position.y + member.height));
  const position = { x: Math.round(left - GROUP_TIDY_PADDING), y: Math.round(top - GROUP_TIDY_PADDING) };
  const width = right - left + GROUP_TIDY_PADDING * 2;
  const height = bottom - top + GROUP_TIDY_PADDING * 2;
  return {
    ok: true,
    commands: [groupCommand(layout, position, width, height)],
    label: "框住 2D 组成员"
  };
}

/** 整体平移组与成员；纯规划，供宿主拖动提交与测试复用。 */
export function planGroupMove(layout: GroupLayout, delta: Point): GroupPlanResult {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return { ok: false, reason: "移动距离无效" };
  if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5) return { ok: false, reason: "没有净变化" };
  const commands: CanvasCommand[] = [{
    type: "node.update",
    nodeId: layout.groupId,
    position: {
      x: Math.round(layout.position.x + delta.x),
      y: Math.round(layout.position.y + delta.y)
    }
  }];
  for (const member of layout.members) {
    commands.push({
      type: "node.update",
      nodeId: member.nodeId,
      position: {
        x: Math.round(member.position.x + delta.x),
        y: Math.round(member.position.y + delta.y)
      }
    });
  }
  return { ok: true, commands, label: "移动 2D 组" };
}
