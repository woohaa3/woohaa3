import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, planCanvasEdit } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { collectResidencyCandidates, createResidencyProjector } from "../canvas-runtime/residency/projection.js";
import { CanvasResourceCoordinator } from "../canvas-runtime/residency/coordinator.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";
import type { PointHit } from "../canvas-runtime/bevy-runtime.js";

installSharedSession();

function setup(options: { writable?: boolean; record?: boolean; collapsed?: boolean } = {}) {
  const source = createEmptyWoohaa3ServerCanvas("c1");
  source.document.nodes = [
    { id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
    { id: "m", type: "image", parentId: "g", position: { x: 40, y: 40 } },
  ];
  source.nodeData = { g: { title: "组", ...(options.collapsed ? { groupCollapsed: true } : {}) }, m: {} };
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);
  const dom = harness();
  let hit: PointHit | null = { kind: "node-action", nodeId: "g", actionId: "group-badge-select", menu: false };
  const captured = runtimeCapturing({ pointHit: () => hit });
  const record = vi.fn(async (commands, _label) => {
    const current = workingCanvasOf(woohaa3CanvasStore.getState())!;
    expect(planCanvasEdit(current, commands).ok).toBe(true);
    getSession().submitCommands(commands, "test-badge");
    return { ok: true, entry: { state: "committed" } };
  });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => captured.runtime, getSession: () => getSession() as never,
    isWritable: () => options.writable !== false,
    ...(options.record ? { onEditCommands: record } : {}) });
  const fire = (type: string, extra = {}) => dom.fire(type, { clientX: 300, clientY: 374, ...extra });
  const current = () => workingCanvasOf(woohaa3CanvasStore.getState())!;
  return { ...captured, dom, controller, fire, record, current, setHit: (next: PointHit | null) => { hit = next; } };
}

describe("group badge click", () => {
  it("短点击只选择徽标，不切换收起状态", () => {
    const f = setup({ record: true });
    f.fire("pointerdown");
    expect(submitted).toHaveLength(0);
    f.fire("pointerup");
    expect(f.current().nodeData.g.groupCollapsed).toBeUndefined();
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["g"]);
    expect(f.record).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it.each(["pointercancel", "blur"])("%s 取消按压，不提交折叠", (cancel) => {
    const f = setup();
    f.fire("pointerdown"); f.fire(cancel); f.fire("pointerup");
    expect(submitted).toHaveLength(0);
    f.controller.dispose();
  });

  it("徽标拖动沿用组拖动手势", () => {
    const f = setup();
    f.fire("pointerdown"); f.fire("pointermove", { clientX: 320 });
    f.fire("pointerup", { clientX: 320 });
    expect(f.current().document.nodes.find(n => n.id === "g")?.position.x).toBeGreaterThan(0);
    f.controller.dispose();
  });

  it("只读、命中失效以及并发切换都不提交", () => {
    const readOnly = setup({ writable: false });
    readOnly.fire("pointerdown"); readOnly.fire("pointerup");
    expect(submitted).toHaveLength(0); readOnly.controller.dispose();
    const f = setup();
    f.fire("pointerdown"); f.setHit(null); f.fire("pointerup");
    expect(submitted).toHaveLength(0);
    f.setHit({ kind: "node-action", nodeId: "g", actionId: "group-badge-select", menu: false });
    f.fire("pointerdown");
    const current = structuredClone(f.current()); current.nodeData.g.groupCollapsed = true;
    woohaa3CanvasStore.getState().applyRemoteCanvas(current);
    f.fire("pointerup"); expect(submitted).toHaveLength(0);
    f.controller.dispose();
  });

  it("折叠组仍可拖动，恢复时成员保持相对位置", () => {
    const f = setup({ collapsed: true });
    f.fire("pointerdown", { clientX: 210, clientY: 300 });
    f.fire("pointermove", { clientX: 250, clientY: 320 });
    f.controller.flush();
    f.fire("pointerup", { clientX: 250, clientY: 320 });
    expect(f.current().document.nodes.find(n => n.id === "g")?.position).toEqual({ x: 40, y: 20 });
    expect(f.current().document.nodes.find(n => n.id === "m")?.position).toEqual({ x: 40, y: 40 });
    expect(f.current().nodeData.g.groupCollapsed).toBe(true);
    f.controller.dispose();
  });

  it("折叠成员不获得资源准入，组徽标自身继续准入且不占离屏相机槽", () => {
    const f = setup({ collapsed: true });
    const candidates = collectResidencyCandidates(f.current(), node => `resource:${node.id}`);
    expect(candidates.find(c => c.nodeId === "g")).toMatchObject({ eligible: true, previewSlot: false });
    expect(candidates.find(c => c.nodeId === "m")).toMatchObject({ eligible: false });
    f.controller.dispose();
  });

  it("隐藏成员显式聚焦 pin 后仍能加载，退出聚焦释放需求", () => {
    const f = setup({ collapsed: true });
    const coordinator = new CanvasResourceCoordinator();
    let pins: string[] = [];
    const project = createResidencyProjector({coordinator, getCanvas:f.current,
      candidatesFor: canvas => collectResidencyCandidates(canvas!, node => `resource:${node.id}`),
      viewport:()=>({x:0,y:0,zoom:1}),surface:()=>({width:1000,height:800,pixelRatio:1}),
      interactive:()=>pins,pins:()=>pins,pageVisible:()=>true});
    project();
    expect(coordinator.admittedContentKeys()).not.toContain("resource:m");
    pins = ["m"]; project();
    expect(coordinator.admittedContentKeys()).toContain("resource:m");
    pins = []; project();
    expect(coordinator.admittedContentKeys()).not.toContain("resource:m");
    f.controller.dispose();
  });

  it("远端收起组时清理隐藏成员选择，不让键盘继续操作隐藏节点", () => {
    const f = setup();
    f.controller.selectNode("m");
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m"]);
    const current = structuredClone(f.current());
    current.nodeData.g.groupCollapsed = true;
    woohaa3CanvasStore.getState().applyRemoteCanvas(current);
    f.controller.flush();
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
    f.controller.dispose();
  });
});
