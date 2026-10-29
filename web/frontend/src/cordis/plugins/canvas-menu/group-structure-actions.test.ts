/**
 * group 结构动作共享入口测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.1 / design D3）。
 *
 * 非渲染回归：只测纯逻辑的可用性判定、规划器选择与「一次操作 = 一个批次」。
 */
import { describe, expect, it } from "vitest";
import type { CanvasCommand } from "@woohaa3/contracts";
import {
  groupStructureIsActionable,
  planGroupStructureCommands,
  resolveGroupStructureAvailability,
  runGroupStructureAction,
  type GroupStructureCanvas,
  type GroupStructureDeps
} from "./group-structure-actions.js";

type StructureTestNode = { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; parentId?: string };

const NODES: StructureTestNode[] = [
  { id: "g", type: "group", position: { x: 0, y: 0 }, width: 300, height: 200 },
  { id: "a", type: "image", position: { x: 20, y: 20 }, width: 200, height: 100, parentId: "g" },
  { id: "b", type: "image", position: { x: 220, y: 20 }, width: 200, height: 100, parentId: "g" },
  { id: "outside", type: "image", position: { x: 800, y: 800 } }
];

function canvas(nodes: readonly StructureTestNode[] = NODES): GroupStructureCanvas {
  return { document: { nodes, edges: [] } };
}

function deps(overrides: Partial<GroupStructureDeps> = {}): GroupStructureDeps & { batches: Array<{ commands: readonly unknown[]; label: string }> } {
  const batches: Array<{ commands: readonly unknown[]; label: string }> = [];
  return {
    batches,
    isWritable: () => true,
    getCanvas: () => canvas(),
    isSubmitting: () => false,
    record: (commands, label) => { batches.push({ commands, label }); },
    ...overrides
  };
}

/** 把规划出的 `node.update` 位置/尺寸写回节点，模拟提交后的画布。 */
function applyUpdates(nodes: readonly StructureTestNode[], commands: readonly CanvasCommand[]): StructureTestNode[] {
  return nodes.map((node) => {
    const update = commands.find(
      (command): command is Extract<CanvasCommand, { type: "node.update" }> =>
        command.type === "node.update" && command.nodeId === node.id
    );
    if (!update) return node;
    return {
      ...node,
      ...(update.position ? { position: update.position } : {}),
      ...(update.width !== undefined ? { width: update.width } : {}),
      ...(update.height !== undefined ? { height: update.height } : {})
    };
  });
}

describe("groupStructureIsActionable（任务 2.1）", () => {
  it("整理需要至少一个直接成员，解组只需 group 存在", () => {
    expect(groupStructureIsActionable(NODES, "tidy", "g")).toBe(true);
    expect(groupStructureIsActionable(NODES, "ungroup", "g")).toBe(true);
    for (const kind of ["arrange-horizontal", "arrange-vertical", "arrange-grid", "arrange-diagonal-up", "arrange-diagonal-down"] as const) {
      expect(groupStructureIsActionable(NODES, kind, "g")).toBe(true);
    }
    const emptyGroup = [{ id: "g", type: "group", position: { x: 0, y: 0 } }];
    expect(groupStructureIsActionable(emptyGroup, "tidy", "g")).toBe(false);
    expect(groupStructureIsActionable(emptyGroup, "ungroup", "g")).toBe(true);
    expect(groupStructureIsActionable(emptyGroup, "arrange-grid", "g")).toBe(false);
  });

  it("目标不存在或不是 group 时不可执行", () => {
    expect(groupStructureIsActionable(NODES, "tidy", "a")).toBe(false);
    expect(groupStructureIsActionable(NODES, "tidy", "missing")).toBe(false);
  });
});

describe("resolveGroupStructureAvailability（任务 2.1/2.2）", () => {
  const base = { nodes: NODES, groupId: "g", kind: "tidy" as const, writable: true, submitting: false };

  it("可写且未提交时可用", () => {
    expect(resolveGroupStructureAvailability(base)).toEqual({ available: true });
  });

  it("目标不存在、只读或提交中时禁用并给出原因", () => {
    expect(resolveGroupStructureAvailability({ ...base, groupId: "missing" })).toEqual({ available: false, reason: "分组已不存在" });
    expect(resolveGroupStructureAvailability({ ...base, writable: false })).toEqual({ available: false, reason: "当前会话不可写（画布只读）" });
    expect(resolveGroupStructureAvailability({ ...base, submitting: true })).toEqual({ available: false, reason: "提交中" });
  });
});

describe("planGroupStructureCommands（任务 2.1）", () => {
  it("整理只布局直接成员并调整容器尺寸", () => {
    const commands = planGroupStructureCommands(canvas(), "tidy", "g");
    expect(commands.length).toBeGreaterThan(0);
    // 组外节点不变。
    expect(commands.some((command) => command.type !== "node.remove" && "nodeId" in command && command.nodeId === "outside")).toBe(false);
    // 至少有一条 node.update 改动 g 的尺寸或成员位置。
    expect(commands.some((command) => command.type === "node.update")).toBe(true);
  });

  it("解组保留成员并移除容器", () => {
    const commands = planGroupStructureCommands(canvas(), "ungroup", "g");
    expect(commands.some((command) => command.type === "node.remove")).toBe(true);
    // 成员不被删除。
    const removed = commands.flatMap((command) => (command.type === "node.remove" ? command.nodeIds : []));
    expect(removed).toEqual(["g"]);
  });

  it("整理无可执行变更时返回空数组", () => {
    const empty: GroupStructureCanvas = {
      document: { nodes: [{ id: "g", type: "group", position: { x: 0, y: 0 }, width: 300, height: 200 }], edges: [] }
    };
    expect(planGroupStructureCommands(empty, "tidy", "g")).toEqual([]);
  });

  it("五种排列都走同一规划器并只改直接成员", () => {
    for (const kind of ["arrange-horizontal", "arrange-vertical", "arrange-grid", "arrange-diagonal-up", "arrange-diagonal-down"] as const) {
      const commands = planGroupStructureCommands(canvas(), kind, "g");
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.some((command) => command.type !== "node.remove" && "nodeId" in command && command.nodeId === "outside")).toBe(false);
      expect(commands.some((command) => command.type === "node.update" && command.nodeId !== "outside")).toBe(true);
    }
  });

  it("同一排列重复执行时不再产生命令", () => {
    for (const kind of ["arrange-horizontal", "arrange-vertical", "arrange-grid", "arrange-diagonal-up", "arrange-diagonal-down"] as const) {
      const first = planGroupStructureCommands(canvas(), kind, "g");
      expect(first.length).toBeGreaterThan(0);
      const arranged = applyUpdates(NODES, first);
      expect(planGroupStructureCommands(canvas(arranged), kind, "g")).toEqual([]);
    }
  });
});

describe("runGroupStructureAction（任务 2.1）", () => {
  it("可用时作为一个批次提交并返回命令数", () => {
    const d = deps();
    const outcome = runGroupStructureAction(d, "tidy", "g");
    expect(outcome.ok).toBe(true);
    expect(d.batches).toHaveLength(1);
    expect(d.batches[0]!.label).toBe("整理");
    expect(d.batches[0]!.commands.length).toBeGreaterThan(0);
  });

  it("只读或提交中不提交空批次，并返回原因", () => {
    const readOnly = deps({ isWritable: () => false });
    expect(runGroupStructureAction(readOnly, "ungroup", "g")).toEqual({ ok: false, reason: "当前会话不可写（画布只读）" });
    expect(readOnly.batches).toHaveLength(0);

    const submitting = deps({ isSubmitting: () => true });
    expect(runGroupStructureAction(submitting, "tidy", "g")).toEqual({ ok: false, reason: "提交中" });
    expect(submitting.batches).toHaveLength(0);
  });

  it("画布未加载时返回原因且不提交", () => {
    const d = deps({ getCanvas: () => null });
    expect(runGroupStructureAction(d, "tidy", "g")).toEqual({ ok: false, reason: "分组已不存在" });
    expect(d.batches).toHaveLength(0);
  });

  it("排列成员已就位时返回已排列且不提交空批次", () => {
    const arranged = applyUpdates(NODES, planGroupStructureCommands(canvas(), "arrange-grid", "g"));
    const d = deps({ getCanvas: () => canvas(arranged) });
    expect(runGroupStructureAction(d, "arrange-grid", "g")).toEqual({ ok: false, reason: "已按该方式排列" });
    expect(d.batches).toHaveLength(0);
  });
});
