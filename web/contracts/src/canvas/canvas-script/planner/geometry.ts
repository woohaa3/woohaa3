/** Mutable plan-local geometry. */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import { AGENT_CANVAS_LIMITS, type AgentGridLayout } from "../../agent-canvas-protocol.js";
import type { CanvasCommand } from "../../commands.js";
import { collectWoohaa3CanvasRemovalIds } from "../../domain/core/node-removal.js";
import type { OrganizationNode } from "../organization.js";
import type { PlannerSnapshot } from "./types.js";
import type { CanvasNodeData } from "../../domain/index.js";

export class PlanGeometryError extends Error {
  constructor(
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}
export function planAssert(value: unknown, code: string, message: string, field?: string): asserts value {
  if (!value) throw new PlanGeometryError(code, message, field);
}
export type GeometryNode = OrganizationNode & {
  position: { x: number; y: number };
  width: number;
  height: number;
  /** 组作用域计划中新建的成员：提交时需要同步写进根组 `memberNodeIds`。 */
  groupMemberOf?: string;
};

export class PlanGeometry {
  readonly nodes = new Map<string, GeometryNode>();
  readonly affected = new Set<string>();
  readonly originalIds: Set<string>;
  constructor(
    readonly snapshot: PlannerSnapshot,
    /** 组作用域计划的根组与数据读取器；缺省表示普通画布（无组作用域）。 */
    readonly groupScope?: { rootGroupId: string; nodeDataOf: (nodeId: string) => Record<string, unknown> | undefined },
  ) {
    for (const n of snapshot.nodes) {
      if (!n.position) continue;
      this.nodes.set(n.id, {
        ...n,
        position: { x: n.position.x, y: n.position.y },
        width: n.width ?? effectiveCanvasNodeSize(n).width,
        height: n.height ?? effectiveCanvasNodeSize(n).height,
      });
    }
    this.originalIds = new Set(this.nodes.keys());
  }
  require(id: string): GeometryNode {
    const n = this.nodes.get(id);
    planAssert(n, "unknown-node", `节点 ${id} 不存在或已删除`);
    return n;
  }
  touch(id: string) {
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.1：影响节点数不再是额度；
    // 完整派生集合由同一 planner 原子处理。
    this.affected.add(id);
  }
  move(id: string, target: { x: number; y: number }) {
    const n = this.require(id);
    if (!n.position.x && !n.position.y && !target.x && !target.y) return;
    this.touch(id);
    n.position = { x: target.x, y: target.y };
  }
  grid(ids: string[], grid: AgentGridLayout) {
    planAssert(ids.length && new Set(ids).size === ids.length, "invalid-ref", "选择必须非空且不重复");
    const selected = ids.map((id) => this.require(id));
    planAssert(
      grid.mode === "grid" && Number.isInteger(grid.columns) && grid.columns >= 1,
      "malformed-request",
      "grid.columns 必须是正整数",
    );
    const columns = Math.min(grid.columns, selected.length),
      gapX = grid.gapX ?? AGENT_CANVAS_LIMITS.layoutGap,
      gapY = grid.gapY ?? AGENT_CANVAS_LIMITS.layoutGap;
    planAssert(
      Number.isFinite(gapX) && gapX >= 0 && Number.isFinite(gapY) && gapY >= 0,
      "malformed-request",
      "grid gap 非法",
    );
    const widths = Array(columns).fill(0),
      heights = Array(Math.ceil(selected.length / columns)).fill(0);
    selected.forEach((n, i) => {
      widths[i % columns] = Math.max(widths[i % columns]!, n.width);
      heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)]!, n.height);
    });
    const origin = grid.origin ?? {
      x: Math.min(...selected.map((n) => n.position.x)),
      y: Math.min(...selected.map((n) => n.position.y)),
    };
    const offset = (values: number[], i: number, gap: number) => values.slice(0, i).reduce((a, b) => a + b + gap, 0);
    selected.forEach((n, i) =>
      this.move(n.id, {
        x: origin.x + offset(widths, i % columns, gapX),
        y: origin.y + offset(heights, Math.floor(i / columns), gapY),
      }),
    );
  }
  remove(ids: string[]) {
    ids.forEach((id) => this.require(id));
    const removed = collectWoohaa3CanvasRemovalIds(this.canonical(), ids, Object.fromEntries([...this.nodes].map(([id]) => [id, {}])));
    for (const id of removed) {
      this.touch(id);
      this.nodes.delete(id);
    }
    return removed;
  }

  /**
   * 调整卡片矩形（change: 2D 组组作用域 agent）。
   *
   * 2D 组的成员表独立于卡片矩形，因此“整理进组后缩小组卡片”必须能单独改宽高；这里只改
   * 世界坐标下的宽高，不改位置，也不改动任何成员关系。
   */
  resize(id: string, size: { width: number; height: number }) {
    const n = this.require(id);
    planAssert(
      Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0,
      "malformed-request",
      "尺寸必须是正数",
    );
    if (n.width === size.width && n.height === size.height) return;
    this.touch(id);
    n.width = size.width;
    n.height = size.height;
  }
  canonical(): GeometryNode[] {
    return [...this.nodes.values()].map((n) => ({ ...n, position: { ...n.position } }));
  }

  /**
   * 组作用域提交收尾：把本次新建的成员写进根组 `memberNodeIds`（换新 `scopeVersion`）。
   *
   * 2D 组用显式成员表表达归属，`parentId` 不参与；没有这一步，Agent 新建的节点只是落在组
   * 卡片范围内的普通节点。`groupData` 是根组当前解码后的 2D 组数据（含 `memberNodeIds`）。
   */
  syncGroupMembers(nextScopeVersion: () => string): CanvasCommand[] {
    if (!this.groupScope) return [];
    const rootGroupId = this.groupScope.rootGroupId;
    const root = this.require(rootGroupId);
    const raw = this.groupScope.nodeDataOf(root.id);
    const group = (raw as { workflowGroup2d?: Record<string, unknown> } | undefined)?.workflowGroup2d;
    planAssert(group && Array.isArray(group.memberNodeIds), "invalid-group", "根组缺少 2D 组数据", "workflowGroup2d");
    const current = (group.memberNodeIds as unknown[]).filter((id): id is string => typeof id === "string");
    const next = [...current];
    for (const node of this.nodes.values()) {
      if (node.groupMemberOf !== rootGroupId) continue;
      if (!next.includes(node.id)) next.push(node.id);
    }
    const removed = new Set(current.filter((id) => !this.nodes.has(id)));
    if (next.length === current.length && removed.size === 0) return [];
    const remaining = next.filter((id) => !removed.has(id));
    this.touch(root.id);
    return [{
      type: "nodeData.patch",
      nodeId: root.id,
      value: {
        ...(raw ?? {}),
        workflowGroup2d: { ...group, scopeVersion: nextScopeVersion(), memberNodeIds: remaining },
      } as CanvasNodeData,
    }];
  }
  diff(before: GeometryNode[]): CanvasCommand[] {
    const old = new Map(before.map((n) => [n.id, n]));
    const commands: CanvasCommand[] = [];
    for (const n of this.canonical()) {
      const prev = old.get(n.id);
      if (!prev) continue;
      if (
        prev.position.x !== n.position.x ||
        prev.position.y !== n.position.y ||
        prev.width !== n.width ||
        prev.height !== n.height
      ) {
        this.touch(n.id);
        commands.push({
          type: "node.update",
          nodeId: n.id,
          position: n.position,
          width: n.width,
          height: n.height,
        });
      }
    }
    const removed = before.filter((n) => !this.nodes.has(n.id));
    if (removed.length) commands.push({ type: "node.remove", nodeIds: removed.map((n) => n.id) });
    for (const n of this.nodes.values())
      planAssert(
        Number.isFinite(n.position.x) &&
          Number.isFinite(n.position.y) &&
          Math.abs(n.position.x) <= AGENT_CANVAS_LIMITS.maxPositionAbs &&
          Math.abs(n.position.y) <= AGENT_CANVAS_LIMITS.maxPositionAbs,
        "limit-exceeded",
        "布局超出画布世界坐标范围",
      );
    return commands;
  }
}
