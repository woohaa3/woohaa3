/**
 * 受保护编辑 `edit.apply` 的 decoder / reducer / satisfaction 测试
 * （change: 2026-10-09-improve-canvas-workflow，任务 1.1）。
 *
 * 覆盖：结构校验与有界、确定性载荷哈希、字段缺失/null 精确区分、无关变化放行、
 * 同字段/关系变化整批拒绝、删除级联 active run 保护、恢复顺序与幂等。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { isCanvasCommandSatisfied } from "./command-satisfaction.js";
import { isEditApplyCommand } from "./edit-command.js";
import { computeCommandPayloadHash } from "./yjs/commands.js";

const NOW = "2026-10-09T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

function imageAsset(id = "asset-image"): StoredAsset {
  return {
    id,
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: {
      storageKey: `sha256-${"a".repeat(64)}`,
      checksum: "a".repeat(64),
      contentType: "image/png",
      size: 4
    }
  };
}

/** 三个顶层文本节点 + 一个标题的运行前画布。 */
function withNodes(): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "text", position: { x: 100, y: 0 }, width: 260, height: 195 },
    { id: "c", type: "text", position: { x: 200, y: 0 }, width: 260, height: 195 }
  ];
  canvas.nodeData = { a: { title: "作品 A" }, b: {}, c: {} };
  return canvas;
}

describe("edit.apply 结构校验（isEditApplyCommand）", () => {
  it("接受结构合法且有界的载荷", () => {
    expect(isEditApplyCommand({
      type: "edit.apply",
      preconditions: [{ kind: "node-fields", nodeId: "a", fields: [{ field: "position", present: true, value: { x: 0, y: 0 } }] }],
      operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "新名" } }]
    })).toBe(true);
  });

  it("拒绝空操作、超限操作数、非法字段与任意路径", () => {
    expect(isEditApplyCommand({ type: "edit.apply", preconditions: [], operations: [] })).toBe(false);
    expect(isEditApplyCommand({ type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }] })).toBe(true);
    // 未知字段名（任意 path 的伪装）
    expect(isEditApplyCommand({
      type: "edit.apply",
      preconditions: [{ kind: "node-data-fields", nodeId: "a", fields: [{ field: "prompt", present: true, value: "x" }] }],
      operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }]
    })).toBe(false);
    // 超过操作数上限
    expect(isEditApplyCommand({
      type: "edit.apply",
      preconditions: [],
      operations: Array.from({ length: 257 }, () => ({ kind: "node-data-set", nodeId: "a", value: { title: "x" } }))
    })).toBe(false);
  });

  it("拒绝递归包装 edit.apply", () => {
    expect(isEditApplyCommand({
      type: "edit.apply",
      preconditions: [],
      operations: [{ type: "edit.apply", preconditions: [], operations: [] }]
    })).toBe(false);
  });
});

describe("edit.apply 载荷身份哈希", () => {
  it("条件或操作变化产生不同 payload hash", async () => {
    const a = await computeCommandPayloadHash({
      canvasId: "c1",
      commands: [{ type: "edit.apply", preconditions: [{ kind: "node-exists", nodeId: "a" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }] }]
    });
    const b = await computeCommandPayloadHash({
      canvasId: "c1",
      commands: [{ type: "edit.apply", preconditions: [{ kind: "node-exists", nodeId: "a" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "y" } }] }]
    });
    expect(a).not.toBe(b);
  });

  it("键顺序不同但语义相同产生同一哈希", async () => {
    const a = await computeCommandPayloadHash({
      canvasId: "c1",
      commands: [{ type: "edit.apply", preconditions: [{ kind: "node-exists", nodeId: "a" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x", zIndex: 1 } }] }]
    });
    const b = await computeCommandPayloadHash({
      canvasId: "c1",
      commands: [{ type: "edit.apply", preconditions: [{ kind: "node-exists", nodeId: "a" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { zIndex: 1, title: "x" } }] }]
    });
    expect(a).toBe(b);
  });
});

describe("edit.apply reducer 前置条件", () => {
  it("无关节点变化不阻止撤销", () => {
    const canvas = withNodes();
    // 撤销 a 的移动（回到 x:0,y:0），条件只针对 a 的 position。
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-fields", nodeId: "a", fields: [{ field: "position", present: true, value: { x: 0, y: 0 } }] }],
        operations: [{ kind: "node-update", nodeId: "a", position: { x: 0, y: 0 } }]
      }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 0, y: 0 });
  });

  it("同字段变化使整批拒绝，无部分写入", () => {
    const canvas = withNodes();
    canvas.document.nodes.find((n) => n.id === "a")!.position = { x: 20, y: 0 };
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-fields", nodeId: "a", fields: [{ field: "position", present: true, value: { x: 0, y: 0 } }] }],
        operations: [
          { kind: "node-update", nodeId: "a", position: { x: 0, y: 0 } },
          { kind: "node-data-set", nodeId: "b", value: { title: "不应写入" } }
        ]
      }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("edit-precondition-failed");
  });

  it("关系（父子/相关边）变化整批拒绝", () => {
    const canvas = withNodes();
    canvas.document.edges = [{ id: "e1", source: "a", target: "b", sourceHandle: null, targetHandle: null, data: {} }];
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "incident-edge-ids", nodeId: "a", edgeIds: [] }],
        operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }]
      }
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("字段缺失 vs null 精确区分", () => {
    const canvas = withNodes();
    // b 没有 title（字段缺失）
    const ok = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-data-fields", nodeId: "b", fields: [{ field: "title", present: false }] }],
        operations: [{ kind: "node-data-set", nodeId: "b", value: { title: "新名" } }]
      }
    ], { now: NOW });
    expect(ok.ok).toBe(true);

    // a 有 title，用 present:false 条件应失败
    const fail = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-data-fields", nodeId: "a", fields: [{ field: "title", present: false }] }],
        operations: [{ kind: "node-data-unset", nodeId: "a", fields: ["title"] }]
      }
    ], { now: NOW });
    expect(fail.ok).toBe(false);
  });
});

describe("edit.apply 缺省字段精确恢复", () => {
  it("恢复原本不存在的 title：unset 移除键，而非写 null", () => {
    const canvas = withNodes();
    // a 原本有 title，先模拟一次「新增 title」动作把 b 的 title 写入，再撤销。
    const added = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "b", value: { title: "后加标题" } }] }
    ], { now: NOW });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const reverted = applyCanvasCommands(added.canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-data-fields", nodeId: "b", fields: [{ field: "title", present: true, value: "后加标题" }] }],
        operations: [{ kind: "node-data-unset", nodeId: "b", fields: ["title"] }]
      }
    ], { now: NOW });
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    expect(Object.prototype.hasOwnProperty.call(reverted.canvas.nodeData.b, "title")).toBe(false);
    // 不触碰 a 的名称
    expect(reverted.canvas.nodeData.a.title).toBe("作品 A");
  });
});

describe("edit.apply 删除保护与恢复", () => {
  it("进行中任务的节点删除被整批拒绝", () => {
    const canvas = withNodes();
    canvas.nodeData.b = { activeRunId: "run-1", taskStatus: "processing" };
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "no-active-run", nodeIds: ["a", "b", "c"] }],
        operations: [{ kind: "node-remove", nodeIds: ["a", "b", "c"] }]
      }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("edit-active-run");
  });

  it("原生 node.remove 也对进行中任务原子拒绝", () => {
    const canvas = withNodes();
    canvas.nodeData.b = { taskStatus: "processing" };
    const result = applyCanvasCommands(canvas, [{ type: "node.remove", nodeIds: ["b"] }], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("edit-active-run");
  });

  it("已终态（仅保留 activeRunId）的节点可以删除", () => {
    const canvas = withNodes();
    canvas.nodeData.b = { activeRunId: "run-1", taskStatus: "successed" };
    const result = applyCanvasCommands(canvas, [{ type: "node.remove", nodeIds: ["b"] }], { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("级联后代中隐藏的进行中任务同样被拒绝", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 300, height: 300 },
      { id: "child", type: "text", position: { x: 20, y: 20 }, parentId: "g" }
    ];
    canvas.nodeData = { child: { activeRunId: "run-x", taskStatus: "processing" } };
    const result = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-remove", nodeIds: ["g"] }] }
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("级联删除后按稳定 ID 完整恢复（父先于子、节点先于边）", () => {
    const canvas = withNodes();
    canvas.document.edges = [{ id: "e1", source: "a", target: "b", sourceHandle: null, targetHandle: null, data: {} }];
    const deleted = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [{ kind: "no-active-run", nodeIds: ["a"] }], operations: [{ kind: "node-remove", nodeIds: ["a", "b"] }] }
    ], { now: NOW });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.canvas.document.nodes.some((n) => n.id === "a")).toBe(false);

    const restored = applyCanvasCommands(deleted.canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-missing", nodeId: "a" }, { kind: "node-missing", nodeId: "b" }],
        operations: [
          { kind: "node-add", node: { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 }, nodeData: { title: "作品 A" } },
          { kind: "node-add", node: { id: "b", type: "text", position: { x: 100, y: 0 }, width: 260, height: 195 } },
          { kind: "edge-add", edge: { id: "e1", source: "a", target: "b" } }
        ]
      }
    ], { now: NOW });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.canvas.document.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(restored.canvas.document.edges.some((e) => e.id === "e1")).toBe(true);
    expect(restored.canvas.nodeData.a.title).toBe("作品 A");
  });

  it("ID 复用造成恢复冲突时整批拒绝", () => {
    const canvas = withNodes();
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-missing", nodeId: "a" }],
        operations: [{ kind: "node-add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
      }
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("恢复引用资产缺失时整批拒绝", () => {
    const canvas = withNodes();
    const result = applyCanvasCommands(canvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "assets-present", assetIds: ["missing-asset"] }],
        operations: [{ kind: "node-add", node: { id: "new", type: "image", position: { x: 0, y: 0 } } }]
      }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("edit-asset-missing");
  });

  it("asset-ready 条件检查资产就绪", () => {
    const canvas = withNodes();
    canvas.assets = [imageAsset("ok"), { ...imageAsset("bad"), status: "missing" }];
    const ok = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [{ kind: "asset-ready", assetId: "ok" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }] }
    ], { now: NOW });
    expect(ok.ok).toBe(true);
    const bad = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [{ kind: "asset-ready", assetId: "bad" }], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "x" } }] }
    ], { now: NOW });
    expect(bad.ok).toBe(false);
  });
});

describe("edit.apply 创建撤销保护后续新增关联", () => {
  it("创建后他人新增子节点，撤销创建时 child-ids 条件拒绝", () => {
    const canvas = base();
    const created = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-add", node: { id: "created", type: "text", position: { x: 0, y: 0 } } }] }
    ], { now: NOW });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 另一操作为 created 新增子节点
    const withChild = applyCanvasCommands(created.canvas, [
      { type: "node.add", node: { id: "child", type: "text", position: { x: 0, y: 0 }, parentId: undefined } }
    ], { now: NOW });
    expect(withChild.ok).toBe(true);
    // 直接改写为父子以模拟「后来新增关联」
    if (!withChild.ok) return;
    const childCanvas = withChild.canvas;
    childCanvas.document.nodes.find((n) => n.id === "child")!.parentId = "created";
    // 但 created 必须是 group 才能挂 child；这里改用 incident-edge 关联验证
    childCanvas.document.edges = [{ id: "later", source: "child", target: "created", sourceHandle: null, targetHandle: null, data: {} }];
    const undo = applyCanvasCommands(childCanvas, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "child-ids", nodeId: "created", childIds: [] }, { kind: "incident-edge-ids", nodeId: "created", edgeIds: [] }],
        operations: [{ kind: "node-remove", nodeIds: ["created"] }]
      }
    ], { now: NOW });
    expect(undo.ok).toBe(false);
  });
});

describe("edit.apply satisfaction", () => {
  it("重命名效果被判定为已生效", () => {
    const canvas = withNodes();
    const result = applyCanvasCommands(canvas, [
      { type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "a", value: { title: "改名" } }] }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const command = { type: "edit.apply" as const, preconditions: [], operations: [{ kind: "node-data-set" as const, nodeId: "a", value: { title: "改名" } }] };
    expect(isCanvasCommandSatisfied(result.canvas, command)).toBe(true);
    expect(isCanvasCommandSatisfied(canvas, command)).toBe(false);
  });
});
