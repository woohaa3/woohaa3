/**
 * 图片聚焦工作区生命周期测试
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，任务 3.4/4.3；
 *   change: 2026-10-16-integrate-photocraft-image-editing 删掉旧标注编辑器后只覆盖取景与预览）。
 *
 * 覆盖：历史 override 保留 direct 取景、面板 resize 不重置取景、退出恢复进入前视口，以及
 * 「已知来源尺寸时立即起跑进入过渡」。内容编辑与净变化由 `project-session`/`editor-workspace`
 * 的测试覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { ImageFocusWorkspace } from "../src/workspace.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  { name: "取消入场", completed: false, reduced: false, duration: 210 },
  { name: "减少动效", completed: true, reduced: true, duration: 0 }
])("$name：界面按实际动画结算显示", async ({ completed, reduced, duration }) => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const run = vi.fn(async (request: import("@woohaa3/frontend/plugin-api").ViewportTransitionRequest) => {
    if (completed) request.apply(request.to, 1);
    return completed;
  });
  const workspace = new ImageFocusWorkspace({
    nodeId: "image",
    target: { canvas: canvasWithNode(), nodeId: "image", asset: { url: "/api/media/test.png", metadata: { width: 1600, height: 900 } } as never, edit: null, project: null },
    rect: { x: 52, y: 152, width: 1000, height: 700 },
    savedViewport: { x: 0, y: 0, zoom: 1 }, restoreViewport: () => {}, setProjection: () => {},
    decode: async () => ({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 }),
    transition: { run, cancel: () => {}, isActive: () => false }
  });
  expect(workspace.isPresentationReady()).toBe(false);
  await workspace.start();
  expect(run.mock.calls[0]?.[0].duration).toBe(duration);
  expect(workspace.isPresentationReady()).toBe(completed);
  workspace.dispose();
});

function canvasWithNode() {
  const canvas = createEmptyWoohaa3ServerCanvas("test", "2026-10-08T00:00:00Z");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 300, y: 400 }, width: 248, height: 232 });
  return canvas;
}

describe("ImageFocusWorkspace 生命周期（任务 3.4/4.3）", () => {
  it.each([false,true])("面板显隐补偿内容矩形中心，适应窗口状态也不重置缩放（手动取景=%s）",async(manual)=>{
    const rect={x:52,y:152,width:1000,height:700};
    const workspace=new ImageFocusWorkspace({nodeId:"image",target:{canvas:canvasWithNode(),nodeId:"image",asset:{url:"/api/media/test.png"} as never,edit:null,project:null},
      rect,savedViewport:{x:0,y:0,zoom:1},restoreViewport:()=>{},setProjection:()=>{},transitionDuration:0,
      decode:async()=>({bitmap:{} as CanvasImageSource,width:1600,height:900})});
    await workspace.start();
    if(manual) workspace.setViewport({x:30,y:-20,zoom:1.4});
    const before=workspace.focus.viewportState();
    const screen=(r:typeof rect,v:typeof before)=>[r.x+r.width/2+v.x,r.y+r.height/2+v.y,v.zoom];
    const hidden={x:0,y:100,width:1332,height:752};
    workspace.preserveNextLayoutViewport();workspace.preserveNextLayoutViewport();workspace.setRect(hidden);
    expect(screen(hidden,workspace.focus.viewportState())).toEqual(screen(rect,before));
    workspace.preserveNextLayoutViewport();workspace.setRect(rect);
    expect(workspace.focus.viewportState()).toEqual(before);
    workspace.preserveNextLayoutViewport();workspace.setViewport({x:10,y:20,zoom:2});
    workspace.setRect(hidden);
    expect(workspace.focus.viewportState()).toEqual({x:10,y:20,zoom:2});
    workspace.dispose();
  });
  it("历史与面板 resize 保留 direct 取景，退出恢复全部视口字段", async () => {
    const canvas = canvasWithNode();
    const saved = { x: -210, y: 325, zoom: 0.65 };
    const restored = vi.fn();
    const workspace = new ImageFocusWorkspace({
      nodeId: "image",
      target: { canvas, nodeId: "image", asset: { url: "/api/media/test.png" } as never, edit: null, project: null },
      rect: { x: 128, y: 56, width: 1000, height: 700 },
      savedViewport: saved,
      restoreViewport: restored,
      setProjection: () => undefined,
      transitionDuration: 0,
      decode: async () => ({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 })
    });
    await workspace.start();
    workspace.focus.setViewport({ x: 30, y: -20, zoom: 1.4 });
    const direct = workspace.focus.viewportState();
    // 面板 resize 不重置取景。
    workspace.setRect({ x: 128, y: 56, width: 680, height: 700 });
    expect(workspace.focus.viewportState()).toEqual(direct);
    // 历史只读预览时保留 direct 取景。
    workspace.setHistoryOverride({ url: "/api/canvas-node-history/c1/n1/e1/preview" });
    await Promise.resolve(); await Promise.resolve();
    expect(workspace.isReadOnlyPreview()).toBe(true);
    workspace.setHistoryOverride(null);
    expect(workspace.focus.viewportState()).toEqual(direct);
    await workspace.animateExit();
    workspace.dispose();
    expect(restored).toHaveBeenCalledWith(saved);
  });

  it("已知来源尺寸时立即起跑进入过渡（不等待原图解码）", async () => {
    const canvas = canvasWithNode();
    let resolveDecode: ((value: { bitmap: CanvasImageSource; width: number; height: number }) => void) | null = null;
    const decode = () => new Promise<{ bitmap: CanvasImageSource; width: number; height: number }>((resolve) => { resolveDecode = resolve; });
    const projections: Array<{ sourceWidth: number } | null> = [];
    const workspace = new ImageFocusWorkspace({
      nodeId: "image",
      target: {
        canvas,
        nodeId: "image",
        // 已知来源尺寸（元数据）：可立即建立首帧；原图尚未解码。
        asset: { url: "/api/media/test.png", metadata: { width: 1600, height: 900 } } as never,
        edit: null,
        project: null
      },
      rect: { x: 128, y: 56, width: 1000, height: 700 },
      savedViewport: { x: 0, y: 0, zoom: 1 },
      restoreViewport: () => undefined,
      setProjection: (projection) => projections.push(projection ? { sourceWidth: projection.sourceWidth } : null),
      transitionDuration: 0,
      decode
    });
    const pending = workspace.start();
    // decode 尚未 resolve：既有纹理 + 已知尺寸已推入首帧投影。
    expect(projections.length).toBeGreaterThan(0);
    expect(projections.at(-1)?.sourceWidth).toBe(1600);
    const finish = resolveDecode as ((value: { bitmap: CanvasImageSource; width: number; height: number }) => void) | null;
    finish?.({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 });
    await expect(pending).resolves.toBe(true);
  });
});

it("编辑预览替换同一节点纹理；历史往返恢复草稿纹理与取景", async () => {
  const canvas = canvasWithNode();
  const texture = vi.fn();
  const projection = vi.fn();
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: { url: "/api/media/base.png" } as never, edit: null, project: null },
    rect: { x: 52, y: 152, width: 1000, height: 700 }, savedViewport: { x: 0, y: 0, zoom: 1 },
    restoreViewport: () => {}, setProjection: projection, onTexture: texture, transitionDuration: 0,
    decode: async () => ({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 })
  });
  await workspace.start();
  const view = { x: 34, y: -18, zoom: 0.8 };
  workspace.setViewport(view);
  const draft = { width: 4, height: 2, pixels: new Uint8Array(32) };
  workspace.setEditorPreview(draft, { width: 1600, height: 900 });
  expect(texture).toHaveBeenLastCalledWith(draft);
  expect(workspace.focus.viewportState()).toEqual(view);
  expect(projection.mock.lastCall?.[0]).toMatchObject({ nodeId: "image", viewport: view, sourceWidth: 1600, sourceHeight: 900 });
  workspace.setHistoryOverride({ url: "/api/canvas-node-history/c1/n1/e1/preview" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(texture.mock.lastCall?.[0]).toHaveProperty("bitmap");
  workspace.setEditorPreview(draft, { width: 1600, height: 900 });
  expect(texture.mock.lastCall?.[0]).toHaveProperty("bitmap");
  workspace.setHistoryOverride(null);
  expect(texture).toHaveBeenLastCalledWith(draft);
  expect(workspace.focus.viewportState()).toEqual(view);
  await workspace.animateExit();
  expect(texture).toHaveBeenLastCalledWith(draft);
  workspace.setEditorPreview(null);
  expect(texture).toHaveBeenLastCalledWith(workspace.loadedImage());
  workspace.dispose();
  workspace.setEditorPreview(draft, { width: 1600, height: 900 });
  expect(texture).toHaveBeenLastCalledWith(null);
});

it("原图解码、编辑预览与工具布局晚到都不打断原节点的进入动画", async () => {
  const canvas = canvasWithNode();
  const requests: import("@woohaa3/frontend/plugin-api").ViewportTransitionRequest[] = [];
  let finish: (completed: boolean) => void = () => {};
  let decode: (value: { bitmap: CanvasImageSource; width: number; height: number }) => void = () => {};
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: { url: "/api/media/base.png", metadata: { width: 1600, height: 900 } } as never, edit: null, project: null },
    rect: { x: 0, y: 56, width: 1280, height: 800 }, savedViewport: { x: -120, y: 50, zoom: 0.8 },
    restoreViewport: () => {}, setProjection: () => {},
    decode: () => new Promise((resolve) => { decode = resolve; }),
    transition: {
      run: (request) => { requests.push(request); return new Promise((resolve) => { finish = resolve; }); },
      cancel: () => finish(false), isActive: () => true
    }
  });
  const pending = workspace.start();
  const request = requests[0]!;
  expect(request.duration).toBe(210);
  expect(workspace.isPresentationReady()).toBe(false);
  expect(request.from.zoom).toBeLessThan(request.to.zoom);
  request.apply({ x: 13, y: -20, zoom: 0.2 }, 0.4);
  const mid = workspace.focus.viewportState();
  workspace.setViewport({ x: 0, y: 0, zoom: 1 });
  expect(workspace.focus.viewportState()).toEqual(mid);
  workspace.setRect({ x: 52, y: 152, width: 948, height: 704 });
  expect(workspace.focus.viewportState()).toEqual(mid);
  decode({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 });
  await pending;
  expect(workspace.isPresentationReady()).toBe(false);
  expect(workspace.focus.viewportState()).toEqual(mid);
  workspace.setEditorPreview({ width: 4, height: 2, pixels: new Uint8Array(32) }, { width: 1600, height: 900 });
  expect(workspace.focus.viewportState()).toEqual(mid);
  workspace.setRect({ x: 52, y: 152, width: 948, height: 704 });
  expect(workspace.focus.viewportState()).toEqual(mid);
  expect(requests).toHaveLength(1);
  request.apply(request.to, 1);
  expect(workspace.isPresentationReady()).toBe(false);
  expect(workspace.focus.viewportState()).toMatchObject({ x: 0, y: 0 });
  expect(workspace.focus.viewportState().zoom).toBeCloseTo(948 / 1600);
  finish(true);
  await Promise.resolve();
  expect(workspace.isTransitioning()).toBe(false);
  expect(workspace.isPresentationReady()).toBe(true);
  workspace.setViewport({ x: 20, y: 30, zoom: 0.8 });
  expect(workspace.focus.viewportState()).toEqual({ x: 20, y: 30, zoom: 0.8 });
  const exit = workspace.animateExit();
  expect(requests[1]?.duration).toBe(210);
  finish(true);
  await exit;
  workspace.dispose();
});

it("裁剪后的文档尺寸用于同一聚焦投影和 fit，预览采样尺寸不决定构图", async () => {
  const canvas = canvasWithNode();
  const projection = vi.fn();
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: { url: "/api/media/base.png" } as never, edit: null, project: null },
    rect: { x: 52, y: 152, width: 1000, height: 700 }, savedViewport: { x: 0, y: 0, zoom: 1 },
    restoreViewport: () => {}, setProjection: projection, transitionDuration: 0,
    decode: async () => ({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 })
  });
  await workspace.start();
  workspace.setEditorPreview({ width: 2, height: 2, pixels: new Uint8Array(16) }, { width: 500, height: 500 });
  expect(projection.mock.lastCall?.[0]).toMatchObject({ sourceWidth: 500, sourceHeight: 500, viewport: { x: 0, y: 0, zoom: 1.4 } });
  workspace.dispose();
});

it("工程打开前沿用节点当前输出入场，稳定原图仍是编辑来源", async () => {
  const canvas = canvasWithNode();
  const output = { id: "output", status: "ready", mediaKind: "image", url: "/api/media/output.png", metadata: { width: 500, height: 300 } };
  canvas.assets.push(output as never);
  canvas.nodeData.image = { outputAssetId: "output" } as never;
  const base = { id: "base", url: "/api/media/base.png", metadata: { width: 1600, height: 900 } };
  const decode = vi.fn(async () => ({ bitmap: {} as CanvasImageSource, width: 500, height: 300 }));
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: base as never, edit: null, project: null },
    rect: { x: 52, y: 152, width: 1000, height: 700 }, savedViewport: { x: 0, y: 0, zoom: 1 },
    restoreViewport: () => {}, setProjection: () => {}, transitionDuration: 0, decode
  });
  expect(workspace.focus.sourceWidth).toBe(500);
  await workspace.start();
  expect(decode).toHaveBeenCalledWith("/api/media/output.png?canvas=test");
  expect(workspace.baseAsset()).toBe(base);
  expect(workspace.displaySize()).toEqual({ width: 500, height: 300 });
  workspace.dispose();
});

it("当前输出迟到解码不覆盖已更新的文档 fit 或历史纹理", async () => {
  const canvas = canvasWithNode();
  const texture = vi.fn();
  let decode: (value: { bitmap: CanvasImageSource; width: number; height: number }) => void = () => {};
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: { url: "/api/media/base.png", metadata: { width: 1600, height: 900 } } as never, edit: null, project: null },
    rect: { x: 52, y: 152, width: 1000, height: 700 }, savedViewport: { x: 0, y: 0, zoom: 1 },
    restoreViewport: () => {}, setProjection: () => {}, onTexture: texture, transitionDuration: 0,
    decode: (url) => url.includes("/api/canvas-node-history/") ? Promise.resolve({ bitmap: {} as CanvasImageSource, width: 400, height: 200 }) : new Promise((resolve) => { decode = resolve; })
  });
  const pending = workspace.start();
  await Promise.resolve();
  const draft = { width: 2, height: 2, pixels: new Uint8Array(16) };
  workspace.setEditorPreview(draft, { width: 500, height: 500 });
  workspace.setHistoryOverride({ url: "/api/canvas-node-history/c1/n1/e1/preview" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const historical = texture.mock.lastCall?.[0];
  decode({ bitmap: {} as CanvasImageSource, width: 1600, height: 900 });
  await pending;
  expect(texture).toHaveBeenLastCalledWith(historical);
  workspace.setHistoryOverride(null);
  expect(texture).toHaveBeenLastCalledWith(draft);
  expect(workspace.focus.currentFitZoom()).toBe(1.4);
  expect(workspace.focus.viewportState().zoom).toBeCloseTo(1.4);
  workspace.dispose();
});

it("细节发布受入场/历史/退出生命周期约束，沿公共内容矩形且释放引用",async()=>{
  vi.stubGlobal("matchMedia",()=>({matches:true}));
  const details=vi.fn();
  const workspace=new ImageFocusWorkspace({nodeId:"image",target:{canvas:canvasWithNode(),nodeId:"image",asset:{url:"/api/media/test.png",metadata:{width:1600,height:900}} as never,edit:null,project:null},
    rect:{x:52,y:152,width:1000,height:700},savedViewport:{x:0,y:0,zoom:1},restoreViewport:()=>{},setProjection:()=>{},onDetails:details,
    decode:async()=>({bitmap:{} as CanvasImageSource,width:1600,height:900})});
  const frame={width:1600,height:900,tiles:[]};
  workspace.setEditorDetails(frame);expect(details).toHaveBeenLastCalledWith(null);
  await workspace.start();workspace.setEditorDetails(frame);expect(details).toHaveBeenLastCalledWith(frame);
  expect(workspace.detailViewportSize()).toEqual({width:1000,height:700});
  workspace.setHistoryOverride({url:"/api/canvas-node-history/c1/n1/e2/preview"});workspace.setEditorDetails(frame);expect(details).toHaveBeenLastCalledWith(null);
  workspace.setHistoryOverride(null);workspace.setEditorDetails(frame);expect(details).toHaveBeenLastCalledWith(frame);
  workspace.dispose();expect(details).toHaveBeenLastCalledWith(null);
  workspace.setEditorDetails(frame);expect(details).toHaveBeenLastCalledWith(null);
});

it("进入动画首帧遇到内容区域变化时，图片屏幕中心仍与原节点重合", () => {
  const before = { x: 0, y: 56, width: 1280, height: 800 };
  const after = { x: 52, y: 152, width: 948, height: 704 };
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas: canvasWithNode(), nodeId: "image", asset: { url: "/api/media/base.png", metadata: { width: 1600, height: 900 } } as never, edit: null, project: null },
    rect: before, savedViewport: { x: -120, y: 50, zoom: 0.8 },
    restoreViewport: () => {}, setProjection: () => {},
    decode: () => new Promise(() => {}),
    transition: { run: () => new Promise(() => {}), cancel: () => {}, isActive: () => true }
  });
  void workspace.start();
  const first = workspace.focus.viewportState();
  const center = { x: before.x + before.width / 2 + first.x, y: before.y + before.height / 2 + first.y };
  workspace.setRect(after);
  const next = workspace.focus.viewportState();
  expect(after.x + after.width / 2 + next.x).toBeCloseTo(center.x);
  expect(after.y + after.height / 2 + next.y).toBeCloseTo(center.y);
  expect(next.zoom).toBeCloseTo(first.zoom);
  workspace.dispose();
});
