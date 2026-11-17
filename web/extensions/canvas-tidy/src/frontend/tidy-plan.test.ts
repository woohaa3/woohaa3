import { describe, expect, it } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  decodeWorkflowGroupData,
  planCanvasEdit,
  planGroupArrange,
  readGroupLayout,
  SHARED_WORLD_VERSION,
  type CanvasNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";
import { shrinkToStandardCardSize, TIDY_GAP, planTidySelection, tidyAnchorOfSelection, tidyGroupTargets } from "./tidy-plan.js";

function canvasWith(nodes: Array<{ id: string; type?: string; x: number; y: number; width?: number; height?: number }>) {
  const canvas = createEmptyWoohaa3ServerCanvas("tidy");
  canvas.document.nodes = nodes.map((node) => ({
    id: node.id,
    type: node.type ?? "image",
    position: { x: node.x, y: node.y },
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {})
  }));
  return canvas;
}

/** 给画布加一个 2D 组：`group` 为组卡片，`members` 为成员。 */
function withGroup(
  canvas: ServerCanvas,
  group: { id: string; x: number; y: number; width?: number; height?: number },
  members: readonly string[]
) {
  canvas.document.nodes.push({
    id: group.id,
    type: "workflow-group-2d",
    position: { x: group.x, y: group.y },
    ...(group.width !== undefined ? { width: group.width } : {}),
    ...(group.height !== undefined ? { height: group.height } : {})
  });
  canvas.nodeData[group.id] = {
    workflowGroup2d: {
      kind: "workflow-group-2d",
      version: SHARED_WORLD_VERSION,
      groupId: group.id,
      scopeVersion: `${group.id}-v1`,
      memberNodeIds: [...members]
    }
  } as unknown as CanvasNodeData;
  return canvas;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function rectOf(canvas: ServerCanvas, id: string) {
  const node = canvas.document.nodes.find((entry) => entry.id === id)!;
  return { x: node.position!.x, y: node.position!.y, width: node.width!, height: node.height! };
}

describe("shrinkToStandardCardSize", () => {
  it("只缩不放：小于标准尺寸的卡片保持原样", () => {
    expect(shrinkToStandardCardSize("image", { width: 200, height: 150 })).toEqual({ width: 200, height: 150 });
  });

  it("过大卡片等比缩回默认卡片尺寸", () => {
    const shrunk = shrinkToStandardCardSize("image", { width: 992, height: 464 });
    expect(shrunk.width).toBeLessThanOrEqual(248);
    expect(shrunk.height).toBeLessThanOrEqual(232);
    expect(Math.abs(shrunk.width / shrunk.height - 992 / 464)).toBeLessThan(0.02);
  });

  it("极端窄长卡片缩完仍不小于该类型最小尺寸", () => {
    const shrunk = shrinkToStandardCardSize("image", { width: 4000, height: 400 });
    expect(shrunk.height).toBeGreaterThanOrEqual(64);
    expect(shrunk.width).toBeGreaterThanOrEqual(180);
  });
});

describe("planTidySelection", () => {
  it("消除重叠并按网格排布，保持选区左上角不动", () => {
    const canvas = canvasWith([
      { id: "a", x: 100, y: 100, width: 248, height: 232 },
      { id: "b", x: 120, y: 120, width: 248, height: 232 },
      { id: "c", x: 140, y: 140, width: 248, height: 232 }
    ]);
    const plan = planTidySelection(canvas, ["a", "b", "c"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);

    const nodes = applied.canvas.document.nodes;
    expect(Math.min(...nodes.map((n) => n.position!.x))).toBe(100);
    expect(Math.min(...nodes.map((n) => n.position!.y))).toBe(100);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        expect(overlaps(rectOf(applied.canvas, nodes[i]!.id), rectOf(applied.canvas, nodes[j]!.id))).toBe(false);
      }
    }
  });

  it("过大卡片被等比缩回，小卡片尺寸不变", () => {
    const canvas = canvasWith([
      { id: "huge", x: 0, y: 0, width: 1200, height: 900 },
      { id: "small", x: 2000, y: 0, width: 200, height: 120 }
    ]);
    const plan = planTidySelection(canvas, ["huge", "small"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const byId = new Map(applied.canvas.document.nodes.map((n) => [n.id, n]));
    expect(byId.get("huge")!.width).toBeLessThanOrEqual(248);
    expect(byId.get("huge")!.height).toBeLessThanOrEqual(232);
    expect(byId.get("small")).toMatchObject({ width: 200, height: 120 });
  });

  it("整理结果可作为一个撤销单元：一次 planCanvasEdit 记录整批", () => {
    const canvas = canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 10, y: 10, width: 248, height: 232 }
    ]);
    const plan = planTidySelection(canvas, ["a", "b"]);
    if (!plan.ok) throw Error(plan.reason);
    const edit = planCanvasEdit(canvas, plan.commands);
    if (!edit.ok) throw Error(edit.reason);
    const moved = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit.forward }]);
    if (!moved.ok) throw Error(moved.rejection.message);
    const undone = applyCanvasCommands(moved.canvas, [{ type: "edit.apply", ...edit.inverse }]);
    if (!undone.ok) throw Error(undone.rejection.message);
    expect(undone.canvas.document.nodes).toEqual(canvas.document.nodes);
  });

  it("已经整理过的选区不再产生命令（不落空历史）", () => {
    const canvas = canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 300, y: 0, width: 248, height: 232 }
    ]);
    const first = planTidySelection(canvas, ["a", "b"]);
    if (!first.ok) throw Error(first.reason);
    const applied = applyCanvasCommands(canvas, first.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const second = planTidySelection(applied.canvas, ["a", "b"]);
    if (!second.ok) throw Error(second.reason);
    expect(second.commands).toEqual([]);
  });

  it("拒绝世界对象与导演区，并给出原因", () => {
    const canvas = canvasWith([
      { id: "card", x: 0, y: 0 },
      { id: "area", type: "scene-area", x: 400, y: 0 }
    ]);
    const plan = planTidySelection(canvas, ["card", "area"]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("世界对象");
  });

  it("拒绝含已删除节点的选区与不足两个对象的选区", () => {
    const canvas = canvasWith([{ id: "a", x: 0, y: 0 }]);
    expect(planTidySelection(canvas, ["a", "gone"]).ok).toBe(false);
    expect(planTidySelection(canvas, ["a"]).ok).toBe(false);
  });

  it("间距可覆盖，且实际间距等于设定值", () => {
    const canvas = canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 0, y: 0, width: 248, height: 232 }
    ]);
    const plan = planTidySelection(canvas, ["a", "b"], { gap: 100 });
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const [a, b] = applied.canvas.document.nodes;
    expect(b!.position!.y - (a!.position!.y + a!.height!)).toBe(100);
  });

  it("默认间距是 TIDY_GAP", () => {
    const canvas = canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 0, y: 0, width: 248, height: 232 }
    ]);
    const plan = planTidySelection(canvas, ["a", "b"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const [a, b] = applied.canvas.document.nodes;
    expect(b!.position!.y - (a!.position!.y + a!.height!)).toBe(TIDY_GAP);
  });
});

describe("2D 组是原子单元", () => {
  /**
   * 组卡片在 (100,100) 620×400，成员在 (120,120) 与 (400,120)（含框外的第二张），
   * 另有一张自由卡片压在组上但排在它前面——整理后组必须整体让位，于是成员必须跟着走。
   */
  function canvasWithGroup() {
    const canvas = canvasWith([
      { id: "free", x: 0, y: 0, width: 248, height: 232 },
      { id: "m1", x: 120, y: 120, width: 200, height: 120 },
      { id: "m2", x: 400, y: 120, width: 200, height: 120 }
    ]);
    return withGroup(canvas, { id: "g", x: 100, y: 100, width: 620, height: 400 }, ["m1", "m2"]);
  }

  it("组成员不产生带尺寸的命令：只随组卡片整体平移", () => {
    const canvas = canvasWithGroup();
    const plan = planTidySelection(canvas, ["g", "free"]);
    if (!plan.ok) throw Error(plan.reason);
    const groupCommand = plan.commands.find((command) => command.type === "node.update" && command.nodeId === "g");
    expect(groupCommand).toBeDefined();
    // 组成员可以出现命令（随组平移），但绝不能带着自己的尺寸变化。
    for (const command of plan.commands) {
      if (command.type !== "node.update") continue;
      if (command.nodeId === "m1" || command.nodeId === "m2") {
        expect(command.width).toBeUndefined();
        expect(command.height).toBeUndefined();
      }
    }
  });

  it("成员与组卡片的相对位置在整理后完全不变（没有被拆出去）", () => {
    const canvas = canvasWithGroup();
    const before = {
      group: rectOf(canvas, "g"),
      m1: rectOf(canvas, "m1"),
      m2: rectOf(canvas, "m2")
    };
    const plan = planTidySelection(canvas, ["g", "free"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const after = {
      group: rectOf(applied.canvas, "g"),
      m1: rectOf(applied.canvas, "m1"),
      m2: rectOf(applied.canvas, "m2")
    };
    const dx = after.group.x - before.group.x;
    const dy = after.group.y - before.group.y;
    // 成员相对组的位移必须与组自身位移完全一致。
    expect(after.m1.x - before.m1.x).toBe(dx);
    expect(after.m1.y - before.m1.y).toBe(dy);
    expect(after.m2.x - before.m2.x).toBe(dx);
    expect(after.m2.y - before.m2.y).toBe(dy);
    // 相对关系不变。
    expect(after.m1.x - after.group.x).toBe(before.m1.x - before.group.x);
    expect(after.m2.y - after.group.y).toBe(before.m2.y - before.group.y);
  });

  it("组卡片尺寸不被缩放：缩它会让人溢出框外", () => {
    const canvas = canvasWithGroup();
    // 组卡片本身很大（620×400），若按普通卡片处理会被缩到 248×232。
    const plan = planTidySelection(canvas, ["g", "free"]);
    if (!plan.ok) throw Error(plan.reason);
    const groupCommand = plan.commands.find((command) => command.type === "node.update" && command.nodeId === "g");
    expect(groupCommand).toBeDefined();
    if (groupCommand?.type !== "node.update") throw Error("unexpected");
    expect(groupCommand.width).toBeUndefined();
    expect(groupCommand.height).toBeUndefined();
  });

  it("只选组内成员、没选组卡片时拒绝整理，并指出是哪个组", () => {
    const canvas = canvasWithGroup();
    canvas.nodeData.g = { title: "分镜组", workflowGroup2d: canvas.nodeData.g!.workflowGroup2d } as unknown as CanvasNodeData;
    const plan = planTidySelection(canvas, ["m1", "m2"]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain("分镜组");
      expect(plan.reason).toContain("组内成员");
    }
  });

  it("按钮呈现条件与规划可执行条件一致：不可整理时不出现按钮", () => {
    // 只选组成员：规划拒绝，因此按钮也不该出现（否则用户会点到注定失败的按钮并被错误弹窗打断）。
    const canvas = canvasWithGroup();
    expect(planTidySelection(canvas, ["m1", "m2"]).ok).toBe(false);
    expect(tidyAnchorOfSelection(canvas, ["m1", "m2"])).toBeNull();
    // 可整理时按钮出现。
    expect(planTidySelection(canvas, ["g", "free"]).ok).toBe(true);
    expect(tidyAnchorOfSelection(canvas, ["g", "free"])).not.toBeNull();
    // 含导演区：两者都拒绝。
    const withArea = canvasWith([
      { id: "card", x: 0, y: 0 },
      { id: "area", type: "scene-area", x: 600, y: 0 }
    ]);
    expect(planTidySelection(withArea, ["card", "area"]).ok).toBe(false);
    expect(tidyAnchorOfSelection(withArea, ["card", "area"])).toBeNull();
    // 单选：按钮不出现（让位给宿主的节点动作横条）。
    expect(tidyAnchorOfSelection(canvas, ["g"])).toBeNull();
  });

  it("组单元占位取组卡片与成员的并集：整组被当作一个方块参与排布", () => {
    const canvas = canvasWithGroup();
    const plan = planTidySelection(canvas, ["g", "free"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    // 组的占位是「组卡片 ∪ 全部成员」的包围盒；自由卡片不能落进这块里（那会视觉上压住组）。
    const groupParts = ["g", "m1", "m2"].map((id) => rectOf(applied.canvas, id));
    const groupBox = {
      x: Math.min(...groupParts.map((rect) => rect.x)),
      y: Math.min(...groupParts.map((rect) => rect.y)),
      width: Math.max(...groupParts.map((rect) => rect.x + rect.width)) - Math.min(...groupParts.map((rect) => rect.x)),
      height: Math.max(...groupParts.map((rect) => rect.y + rect.height)) - Math.min(...groupParts.map((rect) => rect.y))
    };
    expect(overlaps(groupBox, rectOf(applied.canvas, "free"))).toBe(false);
  });

  it("整理组与卡片后可整体撤销，成员一起回到原位", () => {
    const canvas = canvasWithGroup();
    const plan = planTidySelection(canvas, ["g", "free"]);
    if (!plan.ok) throw Error(plan.reason);
    const edit = planCanvasEdit(canvas, plan.commands);
    if (!edit.ok) throw Error(edit.reason);
    const moved = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit.forward }]);
    if (!moved.ok) throw Error(moved.rejection.message);
    const undone = applyCanvasCommands(moved.canvas, [{ type: "edit.apply", ...edit.inverse }]);
    if (!undone.ok) throw Error(undone.rejection.message);
    expect(undone.canvas.document.nodes).toEqual(canvas.document.nodes);
    // 成员集合本身从未被改写。
    const decoded = decodeWorkflowGroupData(
      (undone.canvas.nodeData.g as Record<string, unknown>).workflowGroup2d
    );
    expect(decoded.ok && decoded.value.memberNodeIds).toEqual(["m1", "m2"]);
  });
});

describe("组内整理入口（tidyGroupTargets）", () => {
  function canvasWithGroup(title?: string) {
    const canvas = canvasWith([
      { id: "m1", x: 20, y: 20, width: 200, height: 120 },
      { id: "m2", x: 300, y: 20, width: 200, height: 120 }
    ]);
    withGroup(canvas, { id: "g", x: 0, y: 0, width: 620, height: 400 }, ["m1", "m2"]);
    if (title) {
      canvas.nodeData.g = { title, workflowGroup2d: canvas.nodeData.g!.workflowGroup2d } as unknown as CanvasNodeData;
    }
    return canvas;
  }

  it("选出选区里带成员的组，默认标题回落到「2D 组」", () => {
    expect(tidyGroupTargets(canvasWithGroup(), ["g"])).toEqual([
      { groupId: "g", title: "2D 组", memberCount: 2 }
    ]);
  });

  it("用组自己的标题命名入口", () => {
    expect(tidyGroupTargets(canvasWithGroup("分镜组"), ["g", "m1"])).toEqual([
      { groupId: "g", title: "分镜组", memberCount: 2 }
    ]);
  });

  it("空组不提供组内整理入口", () => {
    const canvas = canvasWith([{ id: "free", x: 0, y: 0 }]);
    withGroup(canvas, { id: "g", x: 0, y: 0 }, []);
    expect(tidyGroupTargets(canvas, ["g", "free"])).toEqual([]);
  });

  it("没选到组卡片时没有入口（组成员本身不是候选）", () => {
    expect(tidyGroupTargets(canvasWithGroup(), ["m1", "m2"])).toEqual([]);
  });

  it("画布为空时安全返回空数组", () => {
    expect(tidyGroupTargets(null, ["g"])).toEqual([]);
  });
});

describe("组内整理：多个组合并成一条撤销记录", () => {
  function canvasWithTwoGroups() {
    const canvas = canvasWith([
      { id: "a1", x: 20, y: 20, width: 200, height: 120 },
      { id: "a2", x: 400, y: 300, width: 200, height: 120 },
      { id: "b1", x: 1000, y: 20, width: 200, height: 120 },
      { id: "b2", x: 1400, y: 300, width: 200, height: 120 }
    ]);
    withGroup(canvas, { id: "ga", x: 0, y: 0, width: 620, height: 450 }, ["a1", "a2"]);
    withGroup(canvas, { id: "gb", x: 900, y: 0, width: 620, height: 450 }, ["b1", "b2"]);
    return canvas;
  }

  it("两个组的宫格整理命令能合成一个批次，一次撤销全部回原样", () => {
    const canvas = canvasWithTwoGroups();
    const a = readGroupLayout(canvas, "ga");
    const b = readGroupLayout(canvas, "gb");
    if (!a.ok || !b.ok) throw Error("layout");
    const planA = planGroupArrange(a.layout, "grid");
    const planB = planGroupArrange(b.layout, "grid");
    if (!planA.ok || !planB.ok) throw Error("plan");
    const edit = planCanvasEdit(canvas, [...planA.commands, ...planB.commands]);
    if (!edit.ok) throw Error(edit.reason);
    const moved = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit.forward }]);
    if (!moved.ok) throw Error(moved.rejection.message);
    // 两个组都被整理了（成员位置与本组左上角对齐后重新起排）。
    expect(moved.canvas.document.nodes).not.toEqual(canvas.document.nodes);
    const undone = applyCanvasCommands(moved.canvas, [{ type: "edit.apply", ...edit.inverse }]);
    if (!undone.ok) throw Error(undone.rejection.message);
    expect(undone.canvas.document.nodes).toEqual(canvas.document.nodes);
    // 成员集合两端都未被改写。
    const decodedA = decodeWorkflowGroupData((undone.canvas.nodeData.ga as Record<string, unknown>).workflowGroup2d);
    expect(decodedA.ok && decodedA.value.memberNodeIds).toEqual(["a1", "a2"]);
  });

  it("两个组都出现在组内整理候选里", () => {
    expect(tidyGroupTargets(canvasWithTwoGroups(), ["ga", "gb"]).map(target => target.groupId)).toEqual(["ga", "gb"]);
  });
});

describe("按连线分层（而不是压成一行）", () => {
  /** 给画布连一条边 source → target。 */
  function connect(canvas: ServerCanvas, source: string, target: string) {
    canvas.document.edges.push({ id: `${source}->${target}`, source, target, data: {} });
    return canvas;
  }

  it("A→B→C 的链排成三列：每层更靠右，且不是同一行的并列", () => {
    const canvas = connect(connect(canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 300, y: 0, width: 248, height: 232 },
      { id: "c", x: 600, y: 0, width: 248, height: 232 }
    ]), "a", "b"), "b", "c");
    const plan = planTidySelection(canvas, ["a", "b", "c"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const x = (id: string) => rectOf(applied.canvas, id).x;
    // 依赖方向即左右方向：a 在 b 左，b 在 c 左。
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("无连线的卡片不会被排进流程列里", () => {
    const canvas = connect(canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 300, y: 0, width: 248, height: 232 },
      { id: "loose", x: 600, y: 400, width: 248, height: 232 }
    ]), "a", "b");
    const plan = planTidySelection(canvas, ["a", "b", "loose"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const flowBottom = Math.max(rectOf(applied.canvas, "a").y + rectOf(applied.canvas, "a").height,
      rectOf(applied.canvas, "b").y + rectOf(applied.canvas, "b").height);
    // 孤立卡片整体落在流程下方，不会被读成链条的最后一环。
    expect(rectOf(applied.canvas, "loose").y).toBeGreaterThanOrEqual(flowBottom);
  });

  it("分支：一个源连两个目标时，两个目标同列上下并列", () => {
    const canvas = connect(connect(canvasWith([
      { id: "src", x: 0, y: 0, width: 248, height: 232 },
      { id: "t1", x: 300, y: 0, width: 248, height: 232 },
      { id: "t2", x: 300, y: 300, width: 248, height: 232 }
    ]), "src", "t1"), "src", "t2");
    const plan = planTidySelection(canvas, ["src", "t1", "t2"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    const src = rectOf(applied.canvas, "src");
    const t1 = rectOf(applied.canvas, "t1");
    const t2 = rectOf(applied.canvas, "t2");
    expect(t1.x).toBe(t2.x);
    expect(t1.y).not.toBe(t2.y);
    expect(t1.x).toBeGreaterThan(src.x);
  });

  it("跨层直达连线不被中间层的卡片挡住", () => {
    // A→B、A→C、B→C：A→C 是跨层边，必须穿过 B 所在的列。
    const canvas = connect(connect(connect(canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 400, y: 0, width: 248, height: 232 },
      { id: "c", x: 800, y: 0, width: 248, height: 232 }
    ]), "a", "b"), "a", "c"), "b", "c");
    const plan = planTidySelection(canvas, ["a", "b", "c"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);

    const a = rectOf(applied.canvas, "a");
    const b = rectOf(applied.canvas, "b");
    const c = rectOf(applied.canvas, "c");
    // 三条水平方向的相对关系：a 最左、b 中间、c 最右。
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    // A→C 的直线会经过 B 的列；B 必须在纵向让开这条线（用中心线的插值位置判断）。
    const channelY = ((a.y + a.height / 2) + (c.y + c.height / 2)) / 2;
    const clearAbove = b.y + b.height <= channelY;
    const clearBelow = b.y >= channelY;
    expect(clearAbove || clearBelow).toBe(true);
  });

  it("连线指向选区外的节点不产生约束", () => {
    const canvas = connect(canvasWith([
      { id: "a", x: 0, y: 0, width: 248, height: 232 },
      { id: "b", x: 300, y: 0, width: 248, height: 232 },
      { id: "outside", x: 900, y: 900, width: 248, height: 232 }
    ]), "a", "outside");
    const plan = planTidySelection(canvas, ["a", "b"]);
    if (!plan.ok) throw Error(plan.reason);
    const applied = applyCanvasCommands(canvas, plan.commands);
    if (!applied.ok) throw Error(applied.rejection.message);
    // 只有 a→outside 这条边，选区内部的 a 与 b 之间没有依赖，按孤立项同行排布。
    expect(rectOf(applied.canvas, "a").y).toBe(rectOf(applied.canvas, "b").y);
  });
});

describe("世界对象守卫", () => {
  it("共享世界模型的节点即使有遗留 position 也被拒绝", () => {
    const canvas = canvasWith([{ id: "card", x: 0, y: 0 }, { id: "world", type: "model3d", x: 100, y: 100 }]);
    canvas.nodeData.world = {
      sharedWorldInstance: {
        schemaVersion: 1,
        instanceId: "inst",
        transform: { position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0], scale: 1 }
      }
    } as unknown as CanvasNodeData;
    expect(planTidySelection(canvas, ["card", "world"]).ok).toBe(false);
  });
});
