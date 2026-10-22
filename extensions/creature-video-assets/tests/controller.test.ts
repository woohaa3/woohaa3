// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, type CanvasCommand } from "@woohaa3/contracts";
import { WorkflowController } from "../src/integration/browser/controller.js";
import type { WorkflowContext } from "../src/integration/browser/context.js";
import { cardOwner } from "../src/preview/shared/projection.js";
import { createRun } from "../src/state/shared/workflow.js";

const active: WorkflowController[] = [];
afterEach(() => { active.splice(0).forEach(controller => controller.dispose()); localStorage.clear(); });
function harness(configureRun?: (run: ReturnType<typeof createRun>) => void) {
  let canvas = createEmptyWoohaa3ServerCanvas("canvas");
  canvas.document.nodes.push({ id: "workflow", type: "composite-asset", position: { x: 500, y: 200 } });
  canvas.nodeData.workflow = { extensionId: "creature-video-assets", extensionContentRef: { schemaVersion: 1, instanceId: "instance-123" } };
  const subscriptions = new Set<() => void>();
  const selection = { nodeIds: ["workflow"], primaryNodeId: "workflow", editingFocus: false, keyboardActive: true };
  const authoritative = createRun(canvas.id, "workflow", "instance-123");
  configureRun?.(authoritative);
  const request = vi.fn(async (_input: { path: string }) => ({ ok: true, data: { ok: true, run: structuredClone(authoritative) } }));
  let release: (() => void) | undefined, hold = false;
  const mutate = (commands: CanvasCommand[]) => {
    const result = applyCanvasCommands(canvas, commands);
    if (!result.ok) throw new Error(result.rejection.message);
    canvas = result.canvas; subscriptions.forEach(listener => listener());
  };
  const ctx = {
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas, subscribe: (listener: () => void) => { subscriptions.add(listener); return () => subscriptions.delete(listener); } },
    selection: { subscribe: () => () => {}, getSnapshot: () => selection, setFromRuntime: (value: typeof selection) => Object.assign(selection, value) },
    canvasNavigation: { closePanel: vi.fn() },
    applicationRemote: { transport: { request } }, mediaRemote: { urlFor: (key: string) => `/media/${key}` }, taskCatalog:{getState:()=>({status:"ready",catalog:{models:[]}})},
    canvasCommands: { isWritable: () => true, submit(commands: CanvasCommand[]) {
      mutate(commands);
      return { ok: true, handle: { settled: hold ? new Promise(resolve => { release = () => { hold = false; resolve({ state: "committed" }); }; }) : Promise.resolve({ state: "committed" }) } };
    } }
  } as unknown as WorkflowContext;
  const controller = new WorkflowController(ctx); active.push(controller);
  return { controller, canvas: () => canvas, mutate, selection, request, hold: () => { hold = true; }, release: () => release?.() };
}

describe("画布工作流控制器", () => {
  it("sends the selected slot on an output execute request",async()=>{
    const h=harness(run=>{run.version=1;});
    await vi.waitFor(()=>expect(h.controller.get("workflow")?.run.version).toBe(1));
    const view=h.controller.get("workflow")!;
    h.controller.updateOutput(view,h.controller.outputSlots(view)[0]!,{prompt:"creature",modelKey:"chosen"});
    await h.controller.execute(view,"main");
    const request=h.request.mock.calls.find(([input])=>input.path.endsWith("/start"))?.[0] as unknown as {body:{outputKey:string;input:{prompt:string}}};
    expect(request.body.outputKey).toBe("main");expect(request.body.input.prompt).toBe("creature");
  });
  it("刷新页面后定位到服务端记录的最新步骤", async () => {
    const h = harness(run => { run.activeStage = "05_direction_stills"; run.version = 9; });
    await vi.waitFor(() => expect(h.controller.get("workflow")?.run.version).toBe(9));
    expect(h.controller.get("workflow")?.stageId).toBe("05_direction_stills");
  });
  it("首步拖图冻结引用，收起保留草稿；后续无输入容器且调试不提交任务", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.canvas().document.nodes).toHaveLength(3));
    const view = h.controller.get("workflow")!;
    h.mutate([{ type: "node.add", node: { id: "source", type: "image", position: { x: 40, y: 60 } }, nodeData: { outputAssetId: "source-asset" } }]);
    h.canvas().assets.push({ id: "source-asset", nodeId: "source", mediaKind: "image", title: "参考", status: "ready", source: "uploaded", createdAt: new Date().toISOString(), metadata: { storageKey: "images/sha.png", checksum: "sha256", contentType: "image/png", size: 24 } });
    const target = h.canvas().document.nodes.find(node => cardOwner(h.canvas().nodeData[node.id])?.role === "input")!;
    expect(target.type).toBe("composite-asset");
    expect(h.controller.referenceContainerNodeId(view)).toBe(target.id);
    expect(h.controller.all()).toHaveLength(1);
    h.selection.nodeIds = [target.id];
    expect(h.controller.selected()).toBe("workflow");
    expect(h.controller.drop(h.canvas(), target.id, ["source"])).toBe(true);
    expect(h.controller.input(view).referenceImages[0]?.storageKey).toBe("images/sha.png");
    expect(h.canvas().document.nodes.find(node => node.id === "source")!.position).toEqual({ x: 40, y: 60 });
    h.canvas().assets.find(asset => asset.id === "source-asset")!.metadata!.storageKey = "changed";
    expect(h.controller.input(view).referenceImages[0]?.storageKey).toBe("images/sha.png");
    h.controller.updateInput(view, { prompt: "保留需求" }); h.controller.collapse(view); h.controller.collapse(view);
    expect(h.controller.input(view).prompt).toBe("保留需求");
    h.controller.preview(view, "05_direction_stills", "ready");
    await h.controller.execute(view);
    await vi.waitFor(() => expect(h.canvas().document.nodes.filter(node => cardOwner(h.canvas().nodeData[node.id])?.role === "input")).toHaveLength(0));
    expect(h.request.mock.calls.every(args => (args[0] as unknown as { path: string } | undefined)?.path?.endsWith("/status"))).toBe(true);
    expect(view.run.activeStage).toBe("01_brief");
  });
  it("提交等待期间切换多次步骤，最终展示最新一步，并清理删除主体留下的卡片", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.canvas().document.nodes).toHaveLength(3));
    h.hold();
    const view = h.controller.get("workflow")!;
    h.controller.preview(view, "02_identity_board", "review");
    await vi.waitFor(() => expect(h.canvas().document.nodes.some(node => cardOwner(h.canvas().nodeData[node.id])?.slot.startsWith("02_identity_board:"))).toBe(true));
    h.controller.preview(view, "04_action_design", "review");
    h.controller.preview(view, "08_matting", "review"); h.release();
    await vi.waitFor(() => {
      const outputs = h.canvas().document.nodes.filter(node => cardOwner(h.canvas().nodeData[node.id])?.role === "output");
      expect(outputs).toHaveLength(1); expect(cardOwner(h.canvas().nodeData[outputs[0]!.id])?.slot).toMatch(/^08_matting:/);
    });
    h.mutate([{ type: "node.remove", nodeIds: ["workflow"] }]);
    await vi.waitFor(() => expect(h.canvas().document.nodes).toHaveLength(0));
    expect(h.canvas().document.edges).toHaveLength(0);
  });
  it("多选外部节点时不把任意工作流当成执行目标", async () => {
    const h = harness();
    expect(h.controller.selected()).toBe("workflow");
    h.selection.nodeIds = ["workflow", "external"];
    expect(h.controller.selected()).toBeNull();
  });
  it("只把当前步骤的失败原因归到对应产物节点", async () => {
    const h = harness(run => {
      const stage = run.stages["01_brief"];
      stage.status = "failed";
      stage.error = "提示词触发了生成服务的内容安全检查。";
      run.version = 3;
    });
    await vi.waitFor(() => expect(h.controller.outputErrors()).toHaveLength(1));
    expect(h.controller.outputErrors()[0]).toMatchObject({ title: "生物设计说明与结构化设计", message: "提示词触发了生成服务的内容安全检查。", kind: "failed" });
    expect(h.canvas().nodeData[h.controller.outputErrors()[0]!.nodeId]).toMatchObject({ taskStatus: "failed", status: "failed" });
  });
});
