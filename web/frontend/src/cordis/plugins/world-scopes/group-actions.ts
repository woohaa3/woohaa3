/**
 * 2D 组成员整理与范围框定（T07 scope gestures）。
 *
 * 2D 组只组织卡片，不是共享世界权限容器：这里只产生普通 `node.update` 命令，经页面
 * `CanvasEditService.record` 走既有 journal/撤销，不写 `workflowGroup2d` 成员集合，
 * 也不改变任何模型世界变换或镜头 pose。
 *
 * **纯规划规则已上提到 `@woohaa3/contracts` 的 `group-layout`**：浏览器扩展（如一键整理）与宿主
 * 顶部栏按钮必须用同一份排布规则，否则同一个组在两处排出不同结果。本模块只保留宿主专属的两件事：
 * 用注入的画布/编辑端口把规划接到 journal，以及成员集合增删（写 `scopeVersion`）。规则、常量与类型
 * 全部从 contracts 转出，不再在此重复实现。
 */
import {
  createHighEntropyId,
  decodeWorkflowGroupData,
  planGroupArrange,
  planGroupFit,
  planGroupTidy,
  readGroupLayout,
  type CanvasCommand,
  type CanvasNodeData,
  type GroupArrangeMode,
  type GroupLayout,
  type GroupPlanResult,
  type ServerCanvas
} from "@woohaa3/contracts";

export {
  GROUP_DEFAULT_HEIGHT,
  GROUP_DEFAULT_WIDTH,
  GROUP_TIDY_GAP,
  GROUP_TIDY_PADDING,
  planGroupArrange,
  planGroupFit,
  planGroupMove,
  planGroupTidy,
  readGroupLayout
} from "@woohaa3/contracts";
export type {
  GroupArrangeMode,
  GroupLayout,
  GroupLayoutMember,
  GroupLayoutResult,
  GroupPlanResult
} from "@woohaa3/contracts";

/** 成员集合改写：换 `scopeVersion` 并整体替换 `workflowGroup2d`，一次命令即可撤销。 */
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
    if (member.type === "scene-area") return { ok: false, reason: "导演区不是画布卡片，不能加入 2D 组" };
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
  arrange(groupId: string, mode: GroupArrangeMode): Promise<{ ok: true } | { ok: false; reason: string }>;
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
    arrange: (groupId, mode) => run(groupId, layout => planGroupArrange(layout, mode)),
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
