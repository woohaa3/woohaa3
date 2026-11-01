/** Mutable plan-local geometry. */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import { AGENT_CANVAS_LIMITS, type AgentGridLayout } from "../../agent-canvas-protocol.js";
import type { CanvasCommand } from "../../commands.js";
import { collectWoohaa3CanvasRemovalIds } from "../../domain/core/node-removal.js";
import type { OrganizationNode } from "../organization.js";
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
    for (const n of snapshot.nodes)
      this.nodes.set(n.id, {
        ...n,
        position: { x: n.position.x, y: n.position.y },
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
  canonical(): GeometryNode[] {
    return [...this.nodes.values()].map((n) => ({ ...n, position: { ...n.position } }));
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
