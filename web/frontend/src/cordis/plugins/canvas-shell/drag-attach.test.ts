/**
 * 拖动粘连纯逻辑单元测试
 * （change: add-drag-touch-connections，design D2/D3/D4）。
 */
import { describe, expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import {
  activeAttachMode,
  applyDragAttachKey,
  clearDragAttachKeys,
  createDragAttachState,
  dragAttachProjection,
  evaluateDragAttachContact,
  isDragAttachConnectable,
  pruneDragAttachState,
  revalidateDragAttachEdges,
} from "./drag-attach.js";

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: string;
};

function canvas(nodes: NodeSpec[], edges: Array<{ id: string; source: string; target: string }> = [], nodeData: Record<string, unknown> = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type ?? "image",
        position: { x: node.x, y: node.y },
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      })),
      edges: edges.map((edge) => ({ ...edge, sourceHandle: null, targetHandle: null, data: {} })),
    },
    nodeData: nodeData as ServerCanvas["nodeData"],
  };
}

/** 拖动 owner 的 position override，模拟拖拽预览。 */
function sceneFor(canvasState: ServerCanvas, owner: string, at: { x: number; y: number }) {
  return buildCanvasRenderScene({
    canvas: canvasState,
    positionOverrides: new Map([[owner, at]]),
  });
}

describe("Q/E held 键与模式（design D2）", () => {
  it("最近按下且仍保持的键决定模式；keyup 回退到另一保持键", () => {
    const state = createDragAttachState("a");
    expect(state.mode).toBeNull();
    expect(applyDragAttachKey(state, "KeyQ", true)).toBe(true);
    expect(state.mode).toBe("predecessor");
    expect(applyDragAttachKey(state, "KeyE", true)).toBe(true);
    expect(state.mode).toBe("successor");
    // 释放 E → 回退到仍保持的 Q。
    expect(applyDragAttachKey(state, "KeyE", false)).toBe(true);
    expect(state.mode).toBe("predecessor");
    expect(applyDragAttachKey(state, "KeyQ", false)).toBe(true);
    expect(state.mode).toBeNull();
  });

  it("key repeat（重复 keydown）幂等；迟到 keyup 幂等", () => {
    const state = createDragAttachState("a");
    applyDragAttachKey(state, "KeyQ", true);
    const order = state.held[0]!.order;
    expect(applyDragAttachKey(state, "KeyQ", true)).toBe(false);
    expect(state.held).toHaveLength(1);
    expect(state.held[0]!.order).toBe(order);
    expect(applyDragAttachKey(state, "KeyE", false)).toBe(false);
    expect(state.mode).toBe("predecessor");
  });

  it("clearDragAttachKeys 清空全部 held 且幂等", () => {
    const state = createDragAttachState("a");
    applyDragAttachKey(state, "KeyE", true);
    clearDragAttachKeys(state);
    expect(state.held).toHaveLength(0);
    expect(activeAttachMode(state.held)).toBeNull();
    clearDragAttachKeys(state);
    expect(state.mode).toBeNull();
  });
});

describe("可连接性过滤（design D3）", () => {
  it("group / ghost 不可作为粘连 owner 或 target", () => {
    expect(isDragAttachConnectable({ type: "composite-asset" })).toBe(false);
    expect(isDragAttachConnectable({ type: "model", compositeAsset: {} })).toBe(false);
    expect(isDragAttachConnectable({ type: "group" })).toBe(false);
    expect(isDragAttachConnectable({ type: "image", ghost: true })).toBe(false);
    expect(isDragAttachConnectable({ type: "image" })).toBe(true);
    expect(isDragAttachConnectable({ type: "text" })).toBe(true);
  });
});

describe("触须接触求值（design D3）", () => {
  it("后序 E 接触右侧合法节点锁定 owner -> target", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    const canvasState = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 230, y: 0, width: 200, height: 100 },
    ]);
    const scene = sceneFor(canvasState, "a", { x: 0, y: 0 });
    expect(evaluateDragAttachContact(state, scene, canvasState)).toBe(true);
    expect(state.contactNodeId).toBe("b");
    const pending = [...state.pending.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("前序 Q 接触左侧合法节点锁定 target -> owner", () => {
    const state = createDragAttachState("a");
    state.mode = "predecessor";
    const canvasState = canvas([
      { id: "a", x: 600, y: 0, width: 200, height: 100 },
      { id: "c", x: 400, y: 0, width: 200, height: 100 },
    ]);
    const scene = sceneFor(canvasState, "a", { x: 600, y: 0 });
    expect(evaluateDragAttachContact(state, scene, canvasState)).toBe(true);
    expect(state.contactNodeId).toBe("c");
    expect([...state.pending.values()][0]).toMatchObject({ source: "c", target: "a" });
  });

  it("自身 / group / 已有同向边 / 纯备注被排除", () => {
    // group target
    const groupState = createDragAttachState("a");
    groupState.mode = "successor";
    const groupCanvas = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "g", type: "group", x: 260, y: 0, width: 400, height: 200 },
    ]);
    expect(evaluateDragAttachContact(groupState, sceneFor(groupCanvas, "a", { x: 0, y: 0 }), groupCanvas)).toBe(false);
    expect(groupState.pending.size).toBe(0);
    // 已有同向边
    const dupState = createDragAttachState("a");
    dupState.mode = "successor";
    const dupCanvas = canvas(
      [
        { id: "a", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", x: 230, y: 0, width: 200, height: 100 },
      ],
      [{ id: "e1", source: "a", target: "b" }],
    );
    expect(evaluateDragAttachContact(dupState, sceneFor(dupCanvas, "a", { x: 0, y: 0 }), dupCanvas)).toBe(false);
    expect(dupState.pending.size).toBe(0);
    // 纯备注目标
    const noteState = createDragAttachState("a");
    noteState.mode = "successor";
    const noteCanvas = canvas(
      [
        { id: "a", x: 0, y: 0, width: 200, height: 100 },
        { id: "n", type: "text", x: 230, y: 0, width: 200, height: 100 },
      ],
      [],
      { n: { isNote: true } },
    );
    expect(evaluateDragAttachContact(noteState, sceneFor(noteCanvas, "a", { x: 0, y: 0 }), noteCanvas)).toBe(false);
    expect(noteState.pending.size).toBe(0);
  });

  it("多个重叠候选取视觉层级最高者，一次手势可依次锁定多个目标且天然去重", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    // 两个候选都在触须范围内：后绘制者（z 更高）优先。
    const canvasState = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 230, y: 0, width: 200, height: 100 },
      { id: "b2", x: 230, y: 0, width: 200, height: 100 },
    ]);
    const scene = sceneFor(canvasState, "a", { x: 0, y: 0 });
    evaluateDragAttachContact(state, scene, canvasState);
    expect(state.contactNodeId).toBe("b2");
    // 触须离开：contact 清除，pending 保留。
    const moved = sceneFor(canvasState, "a", { x: 0, y: 400 });
    evaluateDragAttachContact(state, moved, canvasState);
    expect(state.contactNodeId).toBeNull();
    expect(state.pending.size).toBe(1);
    // 锁定的 edge id 稳定：重复求值不新增；b2 已锁定后最高合法候选变成 b。
    const again = sceneFor(canvasState, "a", { x: 0, y: 0 });
    evaluateDragAttachContact(state, again, canvasState);
    expect(state.pending.size).toBe(2);
    expect(state.contactNodeId).toBe("b");
  });

  it("模式为 null 时清除 contact 但不移除 pending", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    const canvasState = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 230, y: 0, width: 200, height: 100 },
    ]);
    evaluateDragAttachContact(state, sceneFor(canvasState, "a", { x: 0, y: 0 }), canvasState);
    expect(state.pending.size).toBe(1);
    state.mode = null;
    expect(evaluateDragAttachContact(state, sceneFor(canvasState, "a", { x: 0, y: 0 }), canvasState)).toBe(true);
    expect(state.contactNodeId).toBeNull();
    expect(state.pending.size).toBe(1);
  });
});

describe("释放前重验与局部清理（design D4/D6）", () => {
  it("目标被远端删除后重验排除该边", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    const before = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 230, y: 0, width: 200, height: 100 },
    ]);
    evaluateDragAttachContact(state, sceneFor(before, "a", { x: 0, y: 0 }), before);
    const after = canvas([{ id: "a", x: 0, y: 0, width: 200, height: 100 }]);
    expect(revalidateDragAttachEdges(state, after)).toHaveLength(0);
  });

  it("prune 只移除涉及失效目标的 pending 与 contact", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    const canvasState = canvas([
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 230, y: 0, width: 200, height: 100 },
    ]);
    evaluateDragAttachContact(state, sceneFor(canvasState, "a", { x: 0, y: 0 }), canvasState);
    const pruned = canvas([{ id: "a", x: 0, y: 0, width: 200, height: 100 }]);
    expect(pruneDragAttachState(state, pruned)).toBe(true);
    expect(state.pending.size).toBe(0);
    expect(state.contactNodeId).toBeNull();
    // 幂等：再次 prune 无变化。
    expect(pruneDragAttachState(state, pruned)).toBe(false);
  });
});

describe("render scene 投影（design D5）", () => {
  it("投影携带 nodeId/mode/contactNodeId/pendingEdges", () => {
    const state = createDragAttachState("a");
    state.mode = "successor";
    state.contactNodeId = "b";
    state.pending.set("a>b", { id: "e1", source: "a", target: "b" });
    expect(dragAttachProjection(state)).toEqual({
      nodeId: "a",
      mode: "successor",
      contactNodeId: "b",
      pendingEdges: [{ id: "e1", source: "a", target: "b" }],
    });
    // 无接触时不携带 contactNodeId。
    state.contactNodeId = null;
    expect("contactNodeId" in dragAttachProjection(state)).toBe(false);
  });
});
