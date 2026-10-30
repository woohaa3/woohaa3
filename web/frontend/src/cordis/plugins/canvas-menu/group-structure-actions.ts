/**
 * group 结构动作的**固定 groupId 共享入口**
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.1/2.2 / design D3）。
 *
 * 「整理」「解组」既能从分组横条（`canvas.node-action`）触发，也能从右键菜单触发。两者 MUST 使用
 * 同一规划器、同一写权限与提交门禁，以及同一目标存在性检查；本模块是该共享入口的**唯一**实现，
 * 不复制第二套逻辑。
 *
 * 每次结构操作仍经 `canvasEdit.record` 作为**一个**受保护命令批次提交，可一次撤销，不产生额外
 * 持久动作状态。group 之外的结构动作（打组、对齐/分布）不走这里。
 *
 * 可用性判定是**廉价**的（只看目标存在、直接成员数与门禁），不逐帧重跑布局规划；规划只在真正
 * 执行一次时进行。
 */
import type { CanvasCommand, Woohaa3CanvasNode } from "@woohaa3/contracts";
import { planArrangeGroupChildren, planTidyGroup, planUngroupNodes, type GroupArrangementKind } from "../../../extension-api/command-planner.js";

/** 排列动作类型（横条图标按钮）。 */
export type GroupArrangeActionKind = GroupArrangementKind;

/** 结构动作类型：整理与排列只布局直接成员；解组保留成员与绝对位置。 */
export type GroupStructureActionKind = "tidy" | GroupArrangeActionKind | "ungroup";

/**
 * 结构动作只读取的节点字段。
 *
 * 与 canonical `Woohaa3CanvasNode` 的结构字段兼容，但**不含** `data`：调用方传
 * `ServerCanvas.document.nodes` 即可，不需要为判定动作而物化整份节点数据。
 */
export type GroupStructureNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  parentId?: string;
};

/** 结构动作可读取的最小画布视图。 */
export type GroupStructureCanvas = {
  document: {
    nodes: readonly GroupStructureNode[];
    edges: readonly { source: string; target: string }[];
  };
};

/** 结构动作的稳定动作 ID（横条贡献 ID 与右键菜单项 ID 共用，保证两入口同源）。 */
export const GROUP_STRUCTURE_ACTION_IDS: Readonly<Record<GroupStructureActionKind, string>> = {
  tidy: "group-tidy",
  ungroup: "group-ungroup",
  "arrange-horizontal": "group-arrange-horizontal",
  "arrange-vertical": "group-arrange-vertical",
  "arrange-grid": "group-arrange-grid",
  "arrange-diagonal-up": "group-arrange-diagonal-up",
  "arrange-diagonal-down": "group-arrange-diagonal-down"
};

/** 结构动作展示文案（横条与右键共用）。 */
export const GROUP_STRUCTURE_ACTION_LABELS: Readonly<Record<GroupStructureActionKind, string>> = {
  tidy: "整理",
  ungroup: "解组",
  "arrange-horizontal": "横排",
  "arrange-vertical": "竖排",
  "arrange-grid": "宫格",
  "arrange-diagonal-up": "斜排 ↗",
  "arrange-diagonal-down": "斜排 ↘"
};

/** 结构动作可用性（不可用时给出可读原因）。 */
export type GroupStructureAvailability = { available: true } | { available: false; reason: string };

/** 结构动作依赖：宿主注入写门禁、画布读取、提交态查询与命令批次提交。 */
export type GroupStructureDeps = {
  isWritable(): boolean;
  getCanvas(): GroupStructureCanvas | null;
  /** 该分组是否仍在编排一批提交（横条与右键共享门禁）。缺省视为未提交。 */
  isSubmitting?(groupId: string): boolean;
  /** 提交一个命令批次（`canvasEdit.record`）；一次调用即一次撤销。 */
  record(commands: readonly CanvasCommand[], label: string): void;
};

export type GroupStructureOutcome =
  | { ok: true; commandCount: number }
  | { ok: false; reason: string };

/** document 结构节点 → planner 需要的 `Woohaa3CanvasNode`（补空 data）。 */
export function toPlannerNodes(nodes: readonly GroupStructureNode[]): Woohaa3CanvasNode[] {
  return nodes.map((node) => ({ ...node, data: {} })) as Woohaa3CanvasNode[];
}

/**
 * 结构动作是否**有可执行变更**（廉价判定，不跑规划）。
 *
 * 整理与排列需要至少一个直接成员（否则 planner 返回空）；解组只要目标 group 存在就可行
 * （`planUngroupNodes` 会解散该容器并把成员上提）。
 */
export function groupStructureIsActionable(
  nodes: readonly { id: string; type: string; parentId?: string }[],
  kind: GroupStructureActionKind,
  groupId: string
): boolean {
  const group = nodes.find((node) => node.id === groupId && node.type === "group");
  if (!group) return false;
  if (kind === "ungroup") return true;
  return nodes.some((node) => node.parentId === groupId);
}

/**
 * 判定结构动作此刻是否可用（纯逻辑）：目标存在性、写权限、提交态、可执行变更与只读。
 *
 * `submitting` 为 true 时与「只读」一样禁用，两入口共享同一结果
 * （spec「右键不能绕过提交门禁」）。原因文案与横条描述一致。
 */
export function resolveGroupStructureAvailability(input: {
  nodes: readonly { id: string; type: string; parentId?: string }[];
  groupId: string;
  kind: GroupStructureActionKind;
  writable: boolean;
  submitting: boolean;
}): GroupStructureAvailability {
  if (!input.nodes.some((node) => node.id === input.groupId && node.type === "group")) {
    return { available: false, reason: "分组已不存在" };
  }
  if (!input.writable) return { available: false, reason: "当前会话不可写（画布只读）" };
  if (input.submitting) return { available: false, reason: "提交中" };
  if (!groupStructureIsActionable(input.nodes, input.kind, input.groupId)) {
    return { available: false, reason: "分组内没有成员" };
  }
  return { available: true };
}

/**
 * 按固定 groupId 规划结构动作命令（纯函数）。
 *
 * 目标不存在或无可执行变更时返回空数组（调用方据此判定「不可用」而非提交空批次）。
 */
export function planGroupStructureCommands(
  canvas: GroupStructureCanvas,
  kind: GroupStructureActionKind,
  groupId: string
): CanvasCommand[] {
  const nodes = toPlannerNodes(canvas.document.nodes);
  if (kind === "tidy") return planTidyGroup(nodes, canvas.document.edges, groupId);
  if (kind === "ungroup") return planUngroupNodes(nodes, [groupId]);
  return planArrangeGroupChildren(nodes, groupId, kind);
}

/** 读取当前节点集合（画布未加载时返回空数组）。 */
export function nodesOf(deps: Pick<GroupStructureDeps, "getCanvas">): readonly GroupStructureNode[] {
  return deps.getCanvas()?.document.nodes ?? [];
}

/** 横条/右键共享的可用性查询（廉价，不跑规划）。 */
export function describeGroupStructureAction(
  deps: GroupStructureDeps,
  kind: GroupStructureActionKind,
  groupId: string
): GroupStructureAvailability {
  return resolveGroupStructureAvailability({
    nodes: nodesOf(deps),
    groupId,
    kind,
    writable: deps.isWritable(),
    submitting: deps.isSubmitting?.(groupId) ?? false
  });
}

/**
 * 执行固定 groupId 的结构动作（横条与右键共用入口）。
 *
 * 先按同一门禁判定，再规划命令并作为**一个**批次提交。不可用时返回原因，**不**提交空批次；调用方
 * 据此给出可读反馈（横条由描述层禁用，右键由菜单项禁用）。
 */
export function runGroupStructureAction(
  deps: GroupStructureDeps,
  kind: GroupStructureActionKind,
  groupId: string
): GroupStructureOutcome {
  const availability = describeGroupStructureAction(deps, kind, groupId);
  if (!availability.available) return { ok: false, reason: availability.reason };
  const canvas = deps.getCanvas();
  if (!canvas) return { ok: false, reason: "作品尚未加载" };
  const commands = planGroupStructureCommands(canvas, kind, groupId);
  if (commands.length === 0) {
    // 排列的成员已在目标位置时规划结果为空；不要误报成「没有成员」。
    const arranged = kind.startsWith("arrange-");
    return { ok: false, reason: arranged ? "已按该方式排列" : "分组内没有成员" };
  }
  deps.record(commands, GROUP_STRUCTURE_ACTION_LABELS[kind]);
  return { ok: true, commandCount: commands.length };
}
