/** Mutable plan-local geometry. World positions keep refits from moving unrelated siblings. */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import { AGENT_CANVAS_LIMITS, type AgentGridLayout } from "../../agent-canvas-protocol.js";
import type { CanvasCommand } from "../../commands.js";
import { collectWoohaa3CanvasRemovalIds } from "../../domain/core/node-removal.js";
import { groupPadding, groupBottomPadding } from "../../domain/core/group-geometry.js";
import { organizationWorldBounds, type OrganizationNode } from "../organization.js";
import type { PlannerSnapshot } from "./types.js";

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
export type GeometryNode = OrganizationNode & { width: number; height: number };

export class PlanGeometry {
  readonly nodes = new Map<string, GeometryNode>();
  readonly affected = new Set<string>();
  readonly originalIds: Set<string>;
  constructor(readonly snapshot: PlannerSnapshot) {
    const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
    for (const n of snapshot.nodes)
      this.nodes.set(n.id, {
        ...n,
        position: (({ x, y }) => ({ x, y }))(organizationWorldBounds(n, byId)),
        width: n.width ?? effectiveCanvasNodeSize(n).width,
        height: n.height ?? effectiveCanvasNodeSize(n).height,
      });
    this.originalIds = new Set(this.nodes.keys());
  }
  require(id: string): GeometryNode {
    const n = this.nodes.get(id);
    planAssert(n, "unknown-node", `节点 ${id} 不存在或已删除`);
    return n;
  }
  children(id: string) {
    return [...this.nodes.values()].filter((n) => n.parentId === id);
  }
  isAncestor(ancestor: string, id: string): boolean {
    let p = this.require(id).parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (p === ancestor) return true;
      seen.add(p);
      p = this.nodes.get(p)?.parentId;
    }
    return false;
  }
  roots(ids: string[], sameParent: boolean) {
    planAssert(ids.length && new Set(ids).size === ids.length, "invalid-ref", "选择必须非空且不重复");
    const selected = ids.map((id) => this.require(id));
    for (const a of ids)
      for (const b of ids) if (a !== b) planAssert(!this.isAncestor(a, b), "invalid-parent", "不能混选祖先与后代");
    if (sameParent)
      planAssert(
        selected.every((n) => n.parentId === selected[0].parentId),
        "invalid-parent",
        "成员必须共享直属 parent；请先 reparent",
      );
    return selected;
  }
  touch(id: string) {
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.1：影响节点数不再是额度；
    // 完整派生集合由同一 planner 原子处理。
    this.affected.add(id);
  }
  move(id: string, target: { x: number; y: number }) {
    const n = this.require(id),
      dx = target.x - n.position.x,
      dy = target.y - n.position.y;
    if (!dx && !dy) {
      this.touch(id);
      return;
    }
    for (const child of this.nodes.values())
      if (child.id === id || this.isAncestor(id, child.id)) {
        this.touch(child.id);
        child.position = { x: child.position.x + dx, y: child.position.y + dy };
      }
  }
  /** Tight refit, inner to outer; world positions of every child stay fixed. */
  refit(ids: Iterable<string | undefined>) {
    const queue = new Set<string>();
    for (const id of ids) {
      let cursor = id;
      while (cursor && !queue.has(cursor)) {
        queue.add(cursor);
        cursor = this.nodes.get(cursor)?.parentId;
      }
    }
    const depth = (id: string) => {
      let d = 0,
        p = this.nodes.get(id)?.parentId;
      while (p) {
        d++;
        p = this.nodes.get(p)?.parentId;
      }
      return d;
    };
    for (const id of [...queue].sort((a, b) => depth(b) - depth(a))) {
      const n = this.nodes.get(id);
      if (!n || n.type !== "group") continue;
      const children = this.children(id);
      if (!children.length && n.retainWhenEmpty === true) continue;
      if (!children.length) {
        this.touch(id);
        this.nodes.delete(id);
        continue;
      }
      const x = this.snapshot.rootGroupId === id
        ? Math.min(n.position.x, Math.min(...children.map((c) => c.position.x)) - groupPadding)
        : Math.min(...children.map((c) => c.position.x)) - groupPadding;
      const y = this.snapshot.rootGroupId === id
        ? Math.min(n.position.y, Math.min(...children.map((c) => c.position.y)) - groupPadding)
        : Math.min(...children.map((c) => c.position.y)) - groupPadding;
      const right = Math.max(...children.map((c) => c.position.x + effectiveCanvasNodeSize(c).width)) + groupPadding;
      const bottom = Math.max(...children.map((c) => c.position.y + effectiveCanvasNodeSize(c).height)) + groupBottomPadding;
      const root = this.snapshot.rootGroupId === id;
      // 根组向外扩展时保留原来的右/下边界；否则上/左移动会把另一侧缩小。
      const rightEdge = root ? Math.max(right, n.position.x + n.width) : right;
      const bottomEdge = root ? Math.max(bottom, n.position.y + n.height) : bottom;
      this.touch(id);
      n.position = { x, y };
      n.width = root ? rightEdge - x : Math.max(248, rightEdge - x);
      n.height = root ? bottomEdge - y : Math.max(232, bottomEdge - y);
    }
  }
  grid(ids: string[], grid: AgentGridLayout) {
    const selected = this.roots(ids, true);
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
      widths[i % columns] = Math.max(widths[i % columns], effectiveCanvasNodeSize(n).width);
      heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)], effectiveCanvasNodeSize(n).height);
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
    this.refit(selected.map((n) => n.parentId));
  }
  reparent(ids: string[], parent: string | null) {
    const selected = this.roots(ids, false);
    if (parent !== null) {
      planAssert(this.require(parent).type === "group", "invalid-parent", "parent 必须是 group");
      for (const id of ids)
        planAssert(id !== parent && !this.isAncestor(id, parent), "invalid-parent", "成员关系不能成环");
    }
    const ancestors = selected.map((n) => n.parentId);
    for (const n of selected) {
      this.touch(n.id);
      n.parentId = parent ?? undefined;
    }
    this.refit([...ancestors, parent ?? undefined]);
  }
  ungroup(id: string) {
    const group = this.require(id);
    planAssert(group.type === "group", "invalid-parent", "ungroup 需要 group");
    for (const child of this.children(id)) {
      this.touch(child.id);
      child.parentId = group.parentId;
    }
    this.touch(id);
    this.nodes.delete(id);
    this.refit([group.parentId]);
  }
  remove(ids: string[]) {
    ids.forEach((id) => this.require(id));
    const removed = collectWoohaa3CanvasRemovalIds(this.canonical(), ids, Object.fromEntries([...this.nodes].map(([id, n]) => [id, { retainWhenEmpty: n.retainWhenEmpty }])));
    const parents = [...removed].map((id) => this.nodes.get(id)?.parentId);
    for (const id of removed) {
      this.touch(id);
      this.nodes.delete(id);
    }
    this.refit(parents);
    return removed;
  }
  canonical(): GeometryNode[] {
    return [...this.nodes.values()].map((n) => {
      const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
      return {
        ...n,
        position: { x: n.position.x - (parent?.position.x ?? 0), y: n.position.y - (parent?.position.y ?? 0) },
      };
    });
  }
  /** Emit reparent/geometry updates before removals, so ungroup cannot cascade into members. */
  diff(before: GeometryNode[]): CanvasCommand[] {
    const old = new Map(before.map((n) => [n.id, n]));
    const commands: CanvasCommand[] = [];
    for (const n of this.canonical()) {
      const prev = old.get(n.id);
      if (!prev) continue;
      if (
        prev.parentId !== n.parentId ||
        prev.position.x !== n.position.x ||
        prev.position.y !== n.position.y ||
        prev.width !== n.width ||
        prev.height !== n.height
      ) {
        this.touch(n.id);
        commands.push({
          type: "node.update",
          nodeId: n.id,
          parentId: n.parentId ?? null,
          position: n.position,
          width: n.width,
          height: n.height,
        });
      }
    }
    const removed = before.filter((n) => !this.nodes.has(n.id));
    // Deepest first: all surviving descendants have already been detached above.
    const removedIds = new Set(removed.map((n) => n.id));
    const roots = removed.filter((n) => !n.parentId || !removedIds.has(n.parentId));
    if (roots.length) commands.push({ type: "node.remove", nodeIds: roots.map((n) => n.id) });
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
