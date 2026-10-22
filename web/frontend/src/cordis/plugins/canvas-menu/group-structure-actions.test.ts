/**
 * group 结构动作共享入口测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.1 / design D3）。
 *
 * 非渲染回归：只测纯逻辑的可用性判定、规划器选择与「一次操作 = 一个批次」。
 */
import { describe, expect, it } from "vitest";
import {
  groupStructureIsActionable,
  planGroupStructureCommands,
  resolveGroupStructureAvailability,
  runGroupStructureAction,
  type GroupStructureCanvas,
  type GroupStructureDeps
} from "./group-structure-actions.js";

const NODES = [
  { id: "g", type: "group", position: { x: 0, y: 0 }, width: 300, height: 200 },
  { id: "a", type: "image", position: { x: 20, y: 20 }, width: 200, height: 100, parentId: "g" },
  { id: "b", type: "image", position: { x: 220, y: 20 }, width: 200, height: 100, parentId: "g" },
  { id: "outside", type: "image", position: { x: 800, y: 800 } }
];

function canvas(nodes = NODES): GroupStructureCanvas {
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

describe("groupStructureIsActionable（任务 2.1）", () => {
  it("整理需要至少一个直接成员，解组只需 group 存在", () => {
    expect(groupStructureIsActionable(NODES, "tidy", "g")).toBe(true);
    expect(groupStructureIsActionable(NODES, "ungroup", "g")).toBe(true);
    const emptyGroup = [{ id: "g", type: "group", position: { x: 0, y: 0 } }];
    expect(groupStructureIsActionable(emptyGroup, "tidy", "g")).toBe(false);
    expect(groupStructureIsActionable(emptyGroup, "ungroup", "g")).toBe(true);
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
});
