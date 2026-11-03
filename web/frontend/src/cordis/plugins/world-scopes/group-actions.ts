/**
 * 2D 组成员整理与范围框定（T07 scope gestures）。
 *
 * 2D 组只组织卡片，不是共享世界权限容器：这里只产生普通 `node.update` 命令，经页面
 * `CanvasEditService.record` 走既有 journal/撤销，不写 `workflowGroup2d` 成员集合，
 * 也不改变任何模型世界变换或镜头 pose。
 *
 * - `planGroupTidy`：按组左上角把成员整理成近方网格，并同步把组卡片扩到能容纳它；
 * - `planGroupFit`：只把组卡片范围框到现有成员；
 * - `planGroupMove`：整体平移组与成员（纯规划；生产拖动由交互控制器合并 origins）。
 */
import {
  bevyKindForNodeType,
  bevyNodeSize,
  createHighEntropyId,
  decodeWorkflowGroupData,
  type CanvasCommand,
  type CanvasNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";

/** 与内置 `workflow-group-2d` 能力声明的 defaultSize 保持一致。 */
export const GROUP_DEFAULT_WIDTH = 260;
export const GROUP_DEFAULT_HEIGHT = 195;
export const GROUP_TIDY_GAP = 24;
export const GROUP_TIDY_PADDING = 24;

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

function memberSize(node: ServerCanvas["document"]["nodes"][number]): { width: number; height: number } {
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
  const decoded = decodeWorkflowGroupData(canvas.nodeData[node.id]?.workflowGroup2d);
  if (!decoded.ok) return { ok: false, reason: "2D 组数据无效" };
  const size = memberSize(node);
  const members: GroupLayoutMember[] = [];
  for (const memberId of decoded.value.memberNodeIds) {
    const member = canvas.document.nodes.find(entry => entry.id === memberId);
    if (!member || member.type === "workflow-group-2d") continue;
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
      groupId,
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
 * 整理成员：固定近方网格（最多 4 列），成员左上角从组左上角内缩 padding 起排；
 * 组卡片范围同步扩到网格外接框。一次 `record` 可整体撤销。
 */
export function planGroupTidy(layout: GroupLayout): GroupPlanResult {
  if (!layout.members.length) return { ok: false, reason: "2D 组没有可整理的成员" };
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(layout.members.length))));
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
  return { ok: true, commands, label: "整理 2D 组成员" };
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

/**
 * Membership edits are organizational only. One `nodeData.patch` replaces the frozen
 * group payload (with a new scopeVersion), so add/remove is a single journal command
 * and never touches model transforms, camera poses or scene-area authority.
 */
export function planGroupMembership(
  canvas: ServerCanvas | null,
  groupId: string,
  nextMemberNodeIds: readonly string[],
  scopeVersion: string
): GroupPlanResult {
  if (!canvas) return { ok: false, reason: "画布尚未加载" };
  const node = canvas.document.nodes.find(entry => entry.id === groupId);
  if (!node || node.type !== "workflow-group-2d") return { ok: false, reason: "不是 2D 组" };
  const decoded = decodeWorkflowGroupData(canvas.nodeData[groupId]?.workflowGroup2d);
  if (!decoded.ok) return { ok: false, reason: "2D 组数据无效" };
  if (!scopeVersion) return { ok: false, reason: "2D 组版本无效" };
  const next = [...new Set(nextMemberNodeIds)];
  if (next.length !== nextMemberNodeIds.length) return { ok: false, reason: "成员身份重复" };
  for (const memberId of next) {
    if (memberId === groupId) return { ok: false, reason: "2D 组不能包含自身" };
    const member = canvas.document.nodes.find(entry => entry.id === memberId);
    if (!member) return { ok: false, reason: "成员节点不存在" };
    if (member.type === "workflow-group-2d") return { ok: false, reason: "不能嵌套 2D 组" };
    const memberData = canvas.nodeData[memberId] as Record<string, unknown> | undefined;
    if (member.type === "scene-area") return { ok: false, reason: "场景区不是画布卡片，不能加入 2D 组" };
    if (memberData?.sharedWorldInstance !== undefined) return { ok: false, reason: "共享世界模型没有卡片，不能加入 2D 组" };
  }
  const same = decoded.value.memberNodeIds.length === next.length
    && decoded.value.memberNodeIds.every((id, index) => id === next[index]);
  if (same) return { ok: false, reason: "成员没有变化" };
  const raw = canvas.nodeData[groupId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "2D 组数据无效" };
  const value = {
    ...raw,
    workflowGroup2d: { ...decoded.value, scopeVersion, memberNodeIds: next }
  } as CanvasNodeData;
  return {
    ok: true,
    commands: [{ type: "nodeData.patch", nodeId: groupId, value }],
    label: next.length >= decoded.value.memberNodeIds.length ? "添加 2D 组成员" : "移除 2D 组成员"
  };
}

export type GroupActionEdit = {
  record(commands: readonly CanvasCommand[], label: string): Promise<{ ok: boolean; reason?: string }>;
};

export type GroupActionController = {
  tidy(groupId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  fit(groupId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  addMembers(groupId: string, memberNodeIds: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  removeMember(groupId: string, memberNodeId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type GroupActionDeps = {
  getCanvas: () => ServerCanvas | null;
  writable: () => boolean;
  edit: GroupActionEdit;
};

/** 把纯规划接到既有 journal；组动作因此天然可撤销/重做。 */
export function createGroupActions(deps: GroupActionDeps): GroupActionController {
  const run = async (
    groupId: string,
    plan: (layout: GroupLayout) => GroupPlanResult
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!deps.writable()) return { ok: false, reason: "当前不可写" };
    const layout = readGroupLayout(deps.getCanvas(), groupId);
    if (!layout.ok) return { ok: false, reason: layout.reason };
    const planned = plan(layout.layout);
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const result = await deps.edit.record(planned.commands, planned.label);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "操作被拒绝" };
  };
  const setMembers = async (
    groupId: string,
    next: (current: readonly string[]) => readonly string[]
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!deps.writable()) return { ok: false, reason: "当前不可写" };
    const canvas = deps.getCanvas();
    const decoded = decodeWorkflowGroupData(canvas?.nodeData[groupId]?.workflowGroup2d);
    if (!decoded.ok) return { ok: false, reason: "2D 组数据无效" };
    const planned = planGroupMembership(
      canvas,
      groupId,
      next(decoded.value.memberNodeIds),
      createHighEntropyId("group-scope-version")
    );
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const result = await deps.edit.record(planned.commands, planned.label);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "操作被拒绝" };
  };
  return {
    tidy: groupId => run(groupId, planGroupTidy),
    fit: groupId => run(groupId, planGroupFit),
    addMembers: (groupId, memberNodeIds) => setMembers(
      groupId,
      current => [...current, ...memberNodeIds.filter(id => !current.includes(id))]
    ),
    removeMember: (groupId, memberNodeId) => setMembers(
      groupId,
      current => current.filter(id => id !== memberNodeId)
    )
  };
}

let boundActions: GroupActionController | null = null;

export function bindGroupActions(controller: GroupActionController): () => void {
  boundActions = controller;
  return () => { if (boundActions === controller) boundActions = null; };
}

export function currentGroupActions(): GroupActionController | null {
  return boundActions;
}
