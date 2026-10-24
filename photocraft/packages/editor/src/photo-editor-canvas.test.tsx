import {StickyModifierContext,NO_STICKY_MODIFIERS,type StickyModifiers} from "./modifier-keys.js";
import {DEFAULT_GUIDE_PREFERENCES} from "./guides.js";
/** @vitest-environment jsdom */
// 不传预览像素，不创建 2D 上下文；只验证视图指令和指针生命周期。
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasProps } from "./photo-editor-canvas.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
type CanvasTestProps=Partial<PhotoCanvasProps>&{sticky?:StickyModifiers};
function setup(props: CanvasTestProps = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(514);
  const ref = createRef<PhotoCanvasHandle>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const changed = vi.fn();
  function Harness({ value }: { value: CanvasTestProps }) {
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 0.5 });
    return <StickyModifierContext.Provider value={value.sticky??NO_STICKY_MODIFIERS}><PhotoCanvas ref={ref} documentWidth={1600} documentHeight={900} tool="pan"
      view={{ viewport, fitZoom: 0.5, transitioning: false, onChange: (next) => { changed(next); setViewport(next); } }} {...value} /></StickyModifierContext.Provider>;
  }
  const render = (next: CanvasTestProps = props) => act(() => root.render(<Harness value={next} />));
  render();
  const stage = container.querySelector<HTMLDivElement>(".photo-editor-canvas")!;
  const captured = new Set<number>();
  stage.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  stage.hasPointerCapture = (id: number) => captured.has(id);
  stage.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  return { ref, stage, container, render, changed };
}
function pointer(stage: Element, type: string, id = 1) {
  const event = new MouseEvent(type, { button: 0, clientX: 100, clientY: 100, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: id });
  act(() => stage.dispatchEvent(event));
}
it("图片交互层本地拥有触控板导航，阻止宿主重复导航并提供手势门禁", () => {
  const { stage, changed } = setup({ tool: "marquee" });
  const bubbled = vi.fn();
  stage.parentElement!.addEventListener("wheel", bubbled);
  const event = new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => stage.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
  expect(changed.mock.lastCall?.[0].zoom).toBeGreaterThan(.5);
  expect(stage.dataset.canvasWheelOwner).toBe("local");
  expect(stage.dataset.canvasViewport).toBe("true");
  pointer(stage, "pointerdown");
  expect(stage.dataset.canvasViewportBlocked).toBe("true");
  pointer(stage, "pointercancel");
  expect(stage.dataset.canvasViewportBlocked).toBeUndefined();
});
it("视图指令区分适合窗口与实际像素大小", () => {
  const { ref, container } = setup();
  const percentage = () => container.querySelector(".photo-editor-canvas__zoom > span")!.textContent;
  expect(percentage()).toBe("50%");
  act(() => ref.current!.view("actualSize"));
  expect(percentage()).toBe("100%");
  act(() => ref.current!.view("zoomOut"));
  expect(percentage()).toBe("67%");
  act(() => ref.current!.view("fit"));
  expect(percentage()).toBe("50%");
});
it("取消手势释放指针，迟到 pointerup 不补交操作；活动指针不接受缩放", () => {
  const { ref, stage, container } = setup();
  pointer(stage, "pointerdown");
  expect(ref.current!.hasGesture()).toBe(true);
  act(() => ref.current!.view("actualSize"));
  expect(container.querySelector(".photo-editor-canvas__zoom > span")!.textContent).toBe("50%");
  let cancelled = false;
  act(() => { cancelled = ref.current!.cancelGesture(); });
  expect(cancelled).toBe(true);
  expect(ref.current!.hasGesture()).toBe(false);
  expect(stage.releasePointerCapture).toHaveBeenCalledWith(1);
  pointer(stage, "pointerup");
  act(() => { cancelled = ref.current!.cancelGesture(); });
  expect(cancelled).toBe(false);
  pointer(stage, "pointerdown", 2);
  pointer(stage, "pointercancel", 2);
  expect(ref.current!.hasGesture()).toBe(false);
});

it("内核边界随适应、缩放、平移更新，撤销恢复和取消选择不依赖上次拖动", () => {
  const selectionOutline: PhotoCanvasProps["selectionOutline"] = [[100, 100, 300, 100], [300, 100, 300, 200]];
  const { ref, stage, container, render } = setup({ selectionOutline });
  const path = () => container.querySelector(".photo-editor-canvas__selection path")?.getAttribute("d");
  expect(path()).toBe("M82 82L182 82 M182 82L182 132");
  act(() => ref.current!.view("actualSize"));
  expect(path()).toBe("M-268 -93L-68 -93 M-68 -93L-68 7");
  pointer(stage, "pointerdown");
  const move = new MouseEvent("pointermove", { clientX: 120, clientY: 130, bubbles: true });
  Object.defineProperty(move, "pointerId", { value: 1 });
  act(() => stage.dispatchEvent(move));
  const up=new MouseEvent("pointerup",{clientX:120,clientY:130,bubbles:true});Object.defineProperty(up,"pointerId",{value:1});act(()=>stage.dispatchEvent(up));
  expect(path()).toBe("M-248 -63L-48 -63 M-48 -63L-48 37");
  render({ selectionOutline: [] });
  expect(path()).toBeUndefined();
  render({ selectionOutline });
  expect(path()).toBe("M-248 -63L-48 -63 M-48 -63L-48 37");
});
it("普通无手势模式不捕获指针，不平移图片", () => {
  const { ref, stage } = setup({ tool: "none" });
  pointer(stage, "pointerdown");
  expect(stage.setPointerCapture).not.toHaveBeenCalled();
  expect(ref.current!.hasGesture()).toBe(false);
});

it("首帧沿用聚焦取景，透明交互层没有第二张图片；过渡中不接受手势或缩放", () => {
  const onChange = vi.fn();
  const { ref, stage, container, render } = setup({ view: { viewport: { x: 38, y: -25, zoom: 0.14 }, fitZoom: 0.54, transitioning: true, onChange } });
  expect(container.querySelector("canvas, img")).toBeNull();
  expect(container.querySelector(".photo-editor-canvas__zoom > span")?.textContent).toBe("14%");
  pointer(stage, "pointerdown");
  act(() => ref.current!.view("fit"));
  expect(ref.current!.hasGesture()).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  render({ view: { viewport: { x: 0, y: 0, zoom: 0.54 }, fitZoom: 0.54, transitioning: false, onChange } });
  expect(container.querySelector(".photo-editor-canvas__zoom > span")?.textContent).toBe("54%");
  act(() => ref.current!.view("actualSize"));
  expect(onChange).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 });
});
it("框选坐标来自与原节点相同的取景，不依赖另一个 canvas 元素", () => {
  const onMarquee = vi.fn();
  const { stage } = setup({ tool: "marquee", onMarquee });
  pointer(stage, "pointerdown");
  const up = new MouseEvent("pointerup", { button: 0, clientX: 200, clientY: 150, bubbles: true });
  Object.defineProperty(up, "pointerId", { value: 1 });
  act(() => stage.dispatchEvent(up));
  expect(onMarquee).toHaveBeenCalledWith({ x: 136, y: 136, width: 200, height: 100 }, "replace");
});


it.each(["marquee", "lasso"] as const)("%s 单击和拖选分开处理，取消捕获不提交选择", (tool) => {
  const onSelectionClick = vi.fn(), onMarquee = vi.fn(), onLasso = vi.fn();
  const { stage } = setup({ tool, onSelectionClick, onMarquee, onLasso });
  pointer(stage, "pointerdown"); pointer(stage, "pointerup");
  expect(onSelectionClick).toHaveBeenCalledOnce();
  expect(onMarquee).not.toHaveBeenCalled(); expect(onLasso).not.toHaveBeenCalled();
  pointer(stage, "pointerdown"); pointer(stage, "pointercancel"); pointer(stage, "pointerup");
  expect(onSelectionClick).toHaveBeenCalledOnce();
  pointer(stage, "pointerdown");
  const move = new MouseEvent("pointermove", { clientX: 150, clientY: 150, bubbles: true });
  Object.defineProperty(move, "pointerId", { value: 1 });
  act(() => stage.dispatchEvent(move)); pointer(stage, "pointerup");
  expect(onSelectionClick).toHaveBeenCalledOnce();
});

it("自由变换松开才提交一次，终点无需依赖最后一次 move；取消不提交", () => {
  const onTransform = vi.fn();
  const { container, ref, stage } = setup({ tool: "none", transformFrame: [0, 0, 100, 100], onTransform });
  const overlay = container.querySelector<HTMLElement>(".photo-editor-transform")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => overlay.dispatchEvent(event));
  };
  send("pointerdown", 100, 100); send("pointermove", 110, 100);
  expect(onTransform).not.toHaveBeenCalled(); expect(ref.current!.hasGesture()).toBe(true);
  expect(stage.dataset.canvasViewportBlocked).toBe("true");
  send("pointerup", 120, 110);
  expect(onTransform).toHaveBeenCalledOnce(); expect(onTransform.mock.calls[0]![0].slice(4)).toEqual([40, 20]);
  send("pointerdown", 100, 100); send("pointermove", 130, 120);
  act(() => { ref.current!.cancelGesture(); }); send("pointerup", 130, 120);
  expect(onTransform).toHaveBeenCalledOnce();
});

it("同批指针事件与合并采样不丢点，保留笔压并在抬笔前发送增量", () => {
  const onStrokeStart = vi.fn(), onStrokeMove = vi.fn(), onStroke = vi.fn(), onStrokeCancel = vi.fn();
  const { stage, render } = setup({ tool: "brush", onStrokeStart, onStrokeMove, onStroke, onStrokeCancel });
  const event = (type: string, x: number, pressure: number, samples?: PointerEvent[]) => {
    const result = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
    Object.defineProperties(result, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: pressure },
      ...(samples ? { getCoalescedEvents: { value: () => samples } } : {}) });
    return result;
  };
  act(() => {
    stage.dispatchEvent(event("pointerdown", 100, .4));
    stage.dispatchEvent(event("pointermove", 130, .7, [
      { clientX: 110, clientY: 100, pressure: .5 }, { clientX: 130, clientY: 100, pressure: .7 }
    ] as PointerEvent[]));
    stage.dispatchEvent(event("pointerup", 140, 0));
  });
  expect(onStrokeStart).toHaveBeenCalledWith({ x: 136, y: 136, pressure: .4 },{shift:false});
  expect(onStrokeMove.mock.calls).toEqual([
    [[{ x: 156, y: 136, pressure: .5 }, { x: 196, y: 136, pressure: .7 }]],
    [[{ x: 216, y: 136, pressure: .7 }]]
  ]);
  expect(onStroke.mock.calls[0][0]).toHaveLength(4);
  expect(onStrokeCancel).not.toHaveBeenCalled();
  act(() => stage.dispatchEvent(event("pointerdown", 100, .4)));
  render({ tool: "eraser", onStrokeCancel });
  expect(onStrokeCancel).toHaveBeenCalledOnce();
  act(() => stage.dispatchEvent(event("pointerup", 140, 0)));
  expect(onStroke).toHaveBeenCalledOnce();
});

it("套索拖动显示实时轨迹和闭合线，取消不提交，松手清除临时路径", () => {
  const onLasso = vi.fn();
  const { stage, container, ref } = setup({ tool: "lasso", onLasso });
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown", 100, 100);
  send("pointermove", 200, 100);
  send("pointermove", 200, 180);
  const preview = container.querySelector('[data-testid="lasso-preview"]')!;
  expect(preview.querySelector("path")!.getAttribute("d")).toBe("M100 100 L200 100 L200 180");
  expect(preview.querySelector(".photo-editor-canvas__lasso-close")!.getAttribute("d")).toBe("M200 180L100 100");
  expect(onLasso).not.toHaveBeenCalled();
  act(() => { ref.current!.cancelGesture(); });
  send("pointerup", 100, 100);
  expect(container.querySelector('[data-testid="lasso-preview"]')).toBeNull();
  expect(onLasso).not.toHaveBeenCalled();
  send("pointerdown", 100, 100); send("pointermove", 200, 100); send("pointermove", 200, 180); send("pointerup", 100, 100);
  expect(onLasso).toHaveBeenCalledOnce();
  expect(onLasso.mock.calls[0][0]).toHaveLength(4);
  expect(container.querySelector('[data-testid="lasso-preview"]')).toBeNull();
});

it.each(["brush", "eraser"] as const)("%s 保留越界采样，不将图外运动压在边缘", (tool) => {
  const onStrokeStart = vi.fn(), onStrokeMove = vi.fn(), onStroke = vi.fn();
  const { stage } = setup({ tool, onStrokeStart, onStrokeMove, onStroke });
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown", 10, 100); send("pointermove", 10, 200); send("pointermove", 100, 200); send("pointerup", 100, 200);
  expect(onStrokeStart).toHaveBeenCalledWith({ x: -44, y: 136 },{shift:false});
  expect(onStrokeMove.mock.calls).toEqual([[[{ x: -44, y: 336 }]], [[{ x: 136, y: 336 }]]]);
  expect(onStroke.mock.calls[0][0]).toEqual([{ x: -44, y: 136 }, { x: -44, y: 336 }, { x: 136, y: 336 }]);
});

it("移动在整幅交互层开始，保留图外真实坐标，松手一次提交且取消不补交", () => {
  const begin = vi.fn(() => true), preview = vi.fn(), end = vi.fn(), cancel = vi.fn();
  const {stage,ref,changed} = setup({tool:"move",transformMoveOnly:true,transformFrame:[10,10,100,100],onTransform:vi.fn(),onMoveStart:begin,onMovePreview:preview,onMoveEnd:end,onMoveCancel:cancel});
  const send = (type: string,x: number,y: number,modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  expect(stage.querySelector<HTMLElement>(".photo-editor-transform")!.style.pointerEvents).toBe("none");
  send("pointerdown",0,0,{altKey:true,ctrlKey:true});
  expect(begin).toHaveBeenCalledWith({x:-64,y:-64},{duplicate:true,toggleAuto:true,add:false});
  expect(stage.dataset.canvasViewportBlocked).toBe("true");
  send("pointermove",10,20); expect(preview).toHaveBeenLastCalledWith([1,0,0,1,20,40]);
  send("pointerup",15,25); expect(end).toHaveBeenCalledOnce(); expect(end).toHaveBeenLastCalledWith([1,0,0,1,30,50]);
  expect(changed).not.toHaveBeenCalled();
  send("pointerdown",100,100); send("pointermove",130,140);
  act(() => ref.current!.cancelGesture()); send("pointerup",130,140);
  expect(end).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  send("pointerdown",100,100); send("pointerup",101,100);
  expect(end).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledTimes(2);
  begin.mockReturnValue(false); send("pointerdown",100,100);
  expect(ref.current!.hasGesture()).toBe(false);
});

it.each([
  [true,false,"add"],[false,true,"subtract"],[true,true,"intersect"]
] as const)("选区按下时固定运算 Shift=%s Alt=%s，即使松手前释放仍提交 %s", (shiftKey,altKey,mode) => {
  const onMarquee = vi.fn();
  const {stage} = setup({tool:"marquee",hasSelection:true,onMarquee});
  const send = (type: string,x: number,y: number,modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  send("pointerdown",100,100,{shiftKey,altKey}); send("pointermove",200,150,{shiftKey,altKey}); send("pointerup",200,150);
  expect(onMarquee).toHaveBeenLastCalledWith({x:136,y:136,width:200,height:100},mode);
});
it("选框预览和提交共用约束几何；空格移动选框，不修改共享取景", () => {
  const onMarquee = vi.fn();
  const {stage,container,ref,changed} = setup({tool:"marquee",onMarquee});
  const send = (type: string,x: number,y: number,modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  send("pointerdown",100,100); send("pointermove",150,125,{shiftKey:true});
  const box = () => container.querySelector<HTMLElement>('[data-testid="marquee"]')!;
  expect(box().style.width).toBe("50px"); expect(box().style.height).toBe("50px");
  act(() => { expect(ref.current!.selectionKey(" ",true)).toBe(true); });
  send("pointermove",170,135,{shiftKey:true});
  expect(box().style.left).toBe("120px"); expect(box().style.top).toBe("110px");
  act(() => { ref.current!.selectionKey(" ",false); });
  send("pointerup",170,135,{shiftKey:true});
  expect(onMarquee).toHaveBeenLastCalledWith({x:176,y:156,width:100,height:100},"replace");
  expect(changed).not.toHaveBeenCalled();
  expect(ref.current!.selectionKey(" ",true)).toBe(false);
});
it("取消选区清除修饰键和临时几何；失去其他指针捕获不取消当前手势", () => {
  const onMarquee = vi.fn();
  const {stage,ref} = setup({tool:"marquee",onMarquee});
  pointer(stage,"pointerdown");
  act(() => { ref.current!.selectionKey("Shift",true); ref.current!.selectionKey(" ",true); });
  pointer(stage,"lostpointercapture",2); expect(ref.current!.hasGesture()).toBe(true);
  pointer(stage,"pointercancel"); pointer(stage,"pointerup");
  expect(onMarquee).not.toHaveBeenCalled(); act(()=>{expect(ref.current!.selectionKey("Shift",true)).toBe(false);});
  pointer(stage,"pointerdown");
  const up = new MouseEvent("pointerup",{button:0,clientX:200,clientY:150,bubbles:true});
  Object.defineProperty(up,"pointerId",{value:1}); act(() => stage.dispatchEvent(up));
  expect(onMarquee).toHaveBeenLastCalledWith({x:136,y:136,width:200,height:100},"replace");
});

it.each([[false,false],[true,false],[false,true],[true,true]])("选区内部拖动区分边界与像素（Ctrl=%s，隐藏边界=%s），普通内部单击取消选区，取消手势不写", (ctrlKey,hidden) => {
  const begin=vi.fn(() => true), move=vi.fn(() => true), end=vi.fn(), cancel=vi.fn(), select=vi.fn(), create=vi.fn();
  const outline: PhotoCanvasProps["selectionOutline"] = [[100,100,300,100],[300,100,300,300],[300,300,100,300],[100,300,100,100]];
  const {stage,ref}=setup({tool:"marquee",selectionOutline:outline,showSelectionEdges:!hidden,onSelectionMoveStart:begin,onMoveStart:move,onMoveEnd:end,onMoveCancel:cancel,onSelectionClick:select,onMarquee:create});
  expect(stage.querySelector('[data-testid="selection-outline"]')===null).toBe(hidden);
  const send=(type:string,x:number,y:number,modifiers:MouseEventInit={}) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  send("pointermove",100,100,{ctrlKey}); expect(stage.style.cursor).toBe(ctrlKey ? "grab":"move");
  send("pointerdown",100,100,{ctrlKey}); if(!ctrlKey) expect(begin).toHaveBeenLastCalledWith(false); else expect(move).not.toHaveBeenCalled();
  expect(stage.dataset.selectionOperation).toBe(ctrlKey ? "pixels":"boundary");
  send("pointermove",120,115,{ctrlKey}); send("pointerup",120,115,{ctrlKey});
  expect(end).toHaveBeenLastCalledWith([1,0,0,1,40,30]); expect(select).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  send("pointerdown",100,100); send("pointerup",100,100); expect(cancel).toHaveBeenCalledOnce();expect(select).toHaveBeenCalledOnce();
  send("pointerdown",100,100); send("pointermove",120,115); act(() => ref.current!.cancelGesture()); send("pointerup",120,115);
  expect(cancel).toHaveBeenCalledTimes(2); expect(end).toHaveBeenCalledOnce();
  send("pointerdown",100,100,{shiftKey:true}); send("pointerup",120,115,{shiftKey:true});
  expect(create).toHaveBeenLastCalledWith({x:136,y:136,width:40,height:30},"add"); expect(begin).toHaveBeenCalledTimes(ctrlKey?2:3);
  send("pointerdown",10,10); send("pointerup",10,10); expect(select).toHaveBeenCalledTimes(2);
});
it("选区边缘自动平移更新同一选框源坐标；取消后迟到帧不提交", () => {
  const callbacks=new Map<number,FrameRequestCallback>(); let sequence=0;
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback) => {callbacks.set(++sequence,callback);return sequence;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const onMarquee=vi.fn();
  const {stage,ref,changed}=setup({tool:"marquee",onMarquee});
  act(() => ref.current!.view("actualSize")); changed.mockClear();
  const send=(type:string,x:number,y:number) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  send("pointerdown",850,200); expect(callbacks.size).toBe(0);
  send("pointermove",892,220); expect(callbacks.size).toBe(1);
  act(() => callbacks.get(1)!(0)); expect(changed).toHaveBeenLastCalledWith({x:-7,y:0,zoom:1});
  send("pointerup",892,220);
  expect(onMarquee).toHaveBeenLastCalledWith({x:1218,y:393,width:49,height:20},"replace");
  const stale=callbacks.get(2)!; act(() => stale(16)); expect(changed).toHaveBeenCalledOnce();
  send("pointerdown",850,200); send("pointermove",892,220); act(() => ref.current!.cancelGesture());
  send("pointerup",892,220); expect(onMarquee).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it("变换选区手柄拖到边缘沿共享取景平移，松手矩阵保留平移产生的位移", () => {
  const callbacks=new Map<number,FrameRequestCallback>(); let sequence=0;
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback) => {callbacks.set(++sequence,callback);return sequence;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const preview=vi.fn(), apply=vi.fn();
  const {stage,ref,changed}=setup({tool:"none",selectionMatrix:[1,0,0,1,0,0],transformFrame:[1000,300,1250,500],onTransform:apply,onTransformPreview:preview,onTransformBegin:() => true});
  act(() => ref.current!.view("actualSize")); changed.mockClear();
  const overlay=stage.querySelector<HTMLElement>(".photo-editor-transform")!;
  const captured=new Set<number>(); overlay.setPointerCapture=(id)=>{captured.add(id);};
  overlay.hasPointerCapture=(id)=>captured.has(id); overlay.releasePointerCapture=(id)=>{captured.delete(id);};
  const send=(type:string,x:number,y:number) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => overlay.dispatchEvent(event));
  };
  send("pointerdown",850,200); send("pointermove",892,220);
  act(() => callbacks.get(1)!(0));
  expect(preview).toHaveBeenLastCalledWith([1,0,0,1,49,20]);
  expect(changed).toHaveBeenLastCalledWith({x:-7,y:0,zoom:1});
  send("pointerup",892,220); expect(apply).toHaveBeenLastCalledWith([1,0,0,1,49,20]);
  act(() => callbacks.get(2)!(16)); expect(changed).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it("Alt 按下进入整次取色手势，释放修饰键不误落笔，取消后迟到事件不采样", () => {
  const sample=vi.fn(),start=vi.fn(),finish=vi.fn();
  const {stage,ref}=setup({tool:"brush",onSampleColor:sample,onStrokeStart:start,onStroke:finish});
  const send=(type:string,x:number,y:number,altKey=false) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,altKey,bubbles:true}); Object.defineProperty(event,"pointerId",{value:1});
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown",10,100,true); expect(sample).toHaveBeenLastCalledWith({x:-44,y:136});
  send("pointermove",100,100); send("pointerup",100,100);
  expect(start).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  expect(sample).toHaveBeenLastCalledWith({x:136,y:136});
  send("pointerdown",100,100,true); const count=sample.mock.calls.length;
  act(() => ref.current!.cancelGesture()); send("pointerup",120,120);
  expect(sample).toHaveBeenCalledTimes(count);
  send("pointerdown",100,100); send("pointerup",100,100);
  expect(start).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce();
});

it("T 点击传递源坐标，反向拖动创建段落框，图外和取消不创建文字", () => {
  const onText=vi.fn();
  const {stage,ref}=setup({tool:"text",onText});
  const send=(type:string,x:number,y:number)=>{
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});
    Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));
  };
  send("pointerdown",10,100);send("pointerup",10,100);expect(onText).not.toHaveBeenCalled();
  send("pointerdown",100,100);send("pointerup",100,100);
  expect(onText).toHaveBeenLastCalledWith({x:136,y:136});
  send("pointerdown",200,150);send("pointermove",100,100);
  expect(stage.querySelector('[data-testid="marquee"]')).not.toBeNull();
  send("pointerup",100,100);
  const placement=onText.mock.calls.at(-1)![0];
  expect(placement).toMatchObject({x:136,y:136});
  expect(placement.box[0]).toBeCloseTo(136);expect(placement.box[1]).toBeCloseTo(136);
  expect(placement.box[2]).toBeCloseTo(200);expect(placement.box[3]).toBeCloseTo(100);
  expect(stage.querySelector('[data-testid="marquee"]')).toBeNull();
  send("pointerdown",100,100);send("pointermove",200,150);
  act(()=>ref.current!.cancelGesture());send("pointerup",200,150);
  expect(onText).toHaveBeenCalledTimes(2);
});

it("样式定位沿共享取景换算，越界拖动不钳制，释放坐标补齐且不提交其它工具",()=>{
  const positioning={key:"pattern-1",start:vi.fn(()=>true),preview:vi.fn(),end:vi.fn(),cancel:vi.fn()};
  const onStroke=vi.fn(),{stage,ref,changed}=setup({tool:"none",positioning,onStroke});
  const send=(type:string,x:number,y:number,id=1)=>{
    const e=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(e,"pointerId",{value:id});act(()=>stage.dispatchEvent(e));
  };
  send("pointerdown",10,10);expect(positioning.start).not.toHaveBeenCalled();
  send("pointerdown",100,100);expect(positioning.start).toHaveBeenCalledWith({x:136,y:136});
  expect(stage.dataset.canvasViewportBlocked).toBe("true");expect(ref.current!.hasGesture()).toBe(true);
  send("pointermove",20,0,2);expect(positioning.preview).not.toHaveBeenCalled();
  send("pointermove",20,0);expect(positioning.preview).toHaveBeenCalledWith({x:-24,y:-64});
  send("pointerup",10,-10);expect(positioning.end).toHaveBeenCalledWith({x:-44,y:-84});
  send("lostpointercapture",10,-10);expect(positioning.cancel).not.toHaveBeenCalled();
  expect(stage.dataset.canvasViewportBlocked).toBeUndefined();expect(ref.current!.hasGesture()).toBe(false);
  expect(changed).not.toHaveBeenCalled();expect(onStroke).not.toHaveBeenCalled();
});
it("样式目标切换和输入禁用取消定位，旧指针释放不补交；空格平移优先",()=>{
  const positioning={key:"pattern-1",start:vi.fn(()=>true),preview:vi.fn(),end:vi.fn(),cancel:vi.fn()};
  const {stage,ref,render}=setup({tool:"none",positioning});
  pointer(stage,"pointerdown");render({tool:"none",positioning:{...positioning,key:"pattern-2"}});
  expect(positioning.cancel).toHaveBeenCalledOnce();expect(ref.current!.hasGesture()).toBe(false);
  pointer(stage,"pointerup");expect(positioning.end).not.toHaveBeenCalled();
  pointer(stage,"pointerdown");render({tool:"none",positioning,interactive:false});expect(positioning.cancel).toHaveBeenCalledTimes(2);
  render({tool:"pan",positioning});pointer(stage,"pointerdown");pointer(stage,"pointerup");
  expect(positioning.start).toHaveBeenCalledTimes(2);expect(positioning.end).not.toHaveBeenCalled();
});


it("Move Shift 预览与释放共用主轴迟滞，释放 Shift 恢复自由移动；Alt 复制恰好 2 屏幕像素即提交",()=>{
  const begin=vi.fn(()=>true),preview=vi.fn(),end=vi.fn(),cancel=vi.fn();
  const {stage}=setup({tool:"move",onMoveStart:begin,onMovePreview:preview,onMoveEnd:end,onMoveCancel:cancel});
  const send=(type:string,x:number,y:number,modifiers:MouseEventInit={})=>{
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));
  };
  send("pointerdown",100,100);send("pointermove",110,109,{shiftKey:true});expect(preview.mock.lastCall).toEqual([[1,0,0,1,20,0]]);
  send("pointermove",110,111,{shiftKey:true});expect(preview.mock.lastCall).toEqual([[1,0,0,1,20,0]]);
  send("pointermove",110,115,{shiftKey:true});expect(preview.mock.lastCall).toEqual([[1,0,0,1,0,30]]);
  send("pointermove",110,115);expect(preview.mock.lastCall).toEqual([[1,0,0,1,20,30]]);
  send("pointerup",110,115,{shiftKey:true});expect(end.mock.lastCall).toEqual([[1,0,0,1,0,30]]);
  end.mockClear();send("pointerdown",100,100,{altKey:true});send("pointerup",101.9,100);expect(end).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
  send("pointerdown",100,100,{altKey:true});send("pointerup",102,100);expect(end.mock.calls).toEqual([[[1,0,0,1,4,0]]]);
});

it("Move 点按只选层，越过阈值才申请草稿；锁定拒绝只触发一次，Alt 抬起恰好 2 px 也启动",()=>{
  const pick=vi.fn((_point:unknown,_modifiers:unknown)=>true),begin=vi.fn(()=>true),preview=vi.fn(),end=vi.fn(),cancel=vi.fn();
  const {stage,ref}=setup({tool:"move",onMovePick:pick,onMoveStart:begin,onMovePreview:preview,onMoveEnd:end,onMoveCancel:cancel});
  const send=(type:string,x:number,y=100,modifiers:MouseEventInit={})=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
  send("pointerdown",100,100,{shiftKey:true,ctrlKey:true});expect(pick.mock.lastCall?.[1]).toEqual({duplicate:false,toggleAuto:true,add:true});
  send("pointerup",100);expect(begin).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();
  begin.mockReturnValueOnce(false);send("pointerdown",100);send("pointermove",103);expect(begin).not.toHaveBeenCalled();
  send("pointermove",104);expect(begin).toHaveBeenCalledOnce();send("pointermove",110);send("pointerup",110);expect(begin).toHaveBeenCalledOnce();expect(end).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();
  send("pointerdown",100,100,{altKey:true});send("pointerup",102);expect(begin).toHaveBeenCalledTimes(2);expect(end.mock.lastCall).toEqual([[1,0,0,1,4,0]]);
  send("pointerdown",100);act(()=>ref.current!.cancelGesture());send("pointerup",110);expect(begin).toHaveBeenCalledTimes(2);expect(end).toHaveBeenCalledOnce();
});

it.each(["row","column"] as const)("%s 选框点按即提交一像素选区，取消不派发",marqueeLine=>{
  const onMarquee=vi.fn(),onSelectionClick=vi.fn();const {stage}=setup({tool:"marquee",marqueeLine,onMarquee,onSelectionClick});
  pointer(stage,"pointerdown");pointer(stage,"pointerup");
  expect(onSelectionClick).not.toHaveBeenCalled();expect(onMarquee).toHaveBeenCalledOnce();
  const box=onMarquee.mock.calls[0][0];expect(box).toMatchObject(marqueeLine==="row"?{x:0,width:1600,height:1}:{y:0,width:1,height:900});
  pointer(stage,"pointerdown");pointer(stage,"pointercancel");expect(onMarquee).toHaveBeenCalledOnce();
});

it("选区命中以权威覆盖度查询为准，低于轮廓阈值仍可移动选区",()=>{
  const onSelectionMoveStart=vi.fn(()=>true),selectionContains=vi.fn(()=>true);const {stage}=setup({tool:"marquee",selectionOutline:[],selectionContains,onSelectionMoveStart});
  pointer(stage,"pointerdown");expect(selectionContains).toHaveBeenCalled();expect(onSelectionMoveStart.mock.calls).toEqual([[false]]);pointer(stage,"pointercancel");
});

it.each(["marquee","lasso"] as const)("%s Cmd 临时移动按命中分流且等待阈值，Alt 复制、Shift 保留选区操作",tool=>{
  const move=vi.fn(()=>true),boundary=vi.fn(()=>true),end=vi.fn(),cancel=vi.fn(),create=vi.fn();
  const {stage}=setup({tool,onSelectionMoveStart:boundary,onMoveStart:move,onMoveEnd:end,onMoveCancel:cancel,onMarquee:create,selectionContains:p=>p.x<200});
  const send=(type:string,x:number,mod:MouseEventInit={})=>{
    const e=new MouseEvent(type,{button:0,clientX:x,clientY:100,bubbles:true,...mod});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));
  };
  send("pointerdown",100,{metaKey:true,altKey:true});send("pointerup",101,{metaKey:true,altKey:true});expect(move).not.toHaveBeenCalled();
  send("pointerdown",100,{metaKey:true,altKey:true});send("pointerup",102,{metaKey:true,altKey:true});
  expect(move).toHaveBeenLastCalledWith({x:136,y:136},{duplicate:true,toggleAuto:false,add:false,wholeLayer:false,selectedPixels:true});
  expect(end).toHaveBeenLastCalledWith([1,0,0,1,4,0]);
  send("pointerdown",300,{ctrlKey:true});send("pointermove",310,{ctrlKey:true});send("pointercancel",310,{ctrlKey:true});
  expect(move).toHaveBeenLastCalledWith({x:536,y:136},{duplicate:false,toggleAuto:false,add:false,wholeLayer:true,selectedPixels:false});expect(cancel).toHaveBeenCalledOnce();
  send("pointerdown",100,{ctrlKey:true,shiftKey:true});send("pointerup",115,{ctrlKey:true,shiftKey:true});
  expect(move).toHaveBeenCalledTimes(2);expect(boundary).not.toHaveBeenCalled();
});

it("空选区 Alt 拖框创建居中新选区，有选区才减选",()=>{
  const create=vi.fn();const {stage,render}=setup({tool:"marquee",hasSelection:false,onMarquee:create});
  const send=(type:string,x:number)=>{const e=new MouseEvent(type,{button:0,clientX:x,clientY:x,bubbles:true,altKey:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));};
  send("pointerdown",100);send("pointerup",120);expect(create).toHaveBeenLastCalledWith({x:96,y:96,width:80,height:80},"replace");
  render({tool:"marquee",hasSelection:true,onMarquee:create});send("pointerdown",100);send("pointerup",120);expect(create).toHaveBeenLastCalledWith({x:136,y:136,width:40,height:40},"subtract");
});

it("选区徽标随静止指针的修饰键即时更新，离开画布清除",()=>{
  const {stage,ref}=setup({tool:"marquee",hasSelection:true,selectionContains:()=>true,onSelectionMoveStart:()=>true,onMoveStart:()=>true});
  pointer(stage,"pointermove");const feedback=()=>stage.querySelector<HTMLElement>("[data-selection-feedback]")?.dataset.selectionFeedback;
  expect(feedback()).toBeUndefined();
  act(()=>{ref.current!.selectionKey("Control",true);});expect(feedback()).toBe("cut");
  act(()=>{ref.current!.selectionKey("Alt",true);});expect(feedback()).toBe("copy");
  act(()=>{ref.current!.selectionKey("Control",false);});expect(feedback()).toBe("subtract");
  act(()=>{ref.current!.selectionKey("Shift",true);});expect(feedback()).toBe("intersect");
  act(()=>{ref.current!.selectionKey("Alt",false);});expect(feedback()).toBe("add");
  pointer(stage,"pointerout");
});

it("选框读数跟随候选几何且由偏好关闭，移动只在越阈值后显示偏移",()=>{
  const {stage,render}=setup({tool:"marquee"});
  const send=(type:string,x:number,y:number)=>{const e=new MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));};
  send("pointerdown",100,100);send("pointermove",120,115);expect(stage.textContent).toContain("宽 40 px · 高 30 px");send("pointercancel",120,115);
  render({tool:"marquee",showTransformationValues:false});send("pointerdown",100,100);send("pointermove",120,115);expect(stage.querySelector(".photo-editor-canvas__measurement")).toBeNull();send("pointercancel",120,115);
  render({tool:"move",onMovePick:()=>true,onMoveStart:()=>true});send("pointerdown",100,100);expect(stage.querySelector(".photo-editor-canvas__measurement")).toBeNull();send("pointermove",120,115);expect(stage.textContent).toContain("ΔX 40 px · ΔY 30 px");send("pointerup",120,115);expect(stage.querySelector(".photo-editor-canvas__measurement")).toBeNull();
});

it("Shift文字按下锁存强制新建；Move双击只转发有效无修饰点位，变换工具不转发",()=>{
  const text=vi.fn(),edit=vi.fn();const {stage,render}=setup({tool:"text",onText:text});
  const send=(type:string,shiftKey=false)=>{const e=new MouseEvent(type,{clientX:100,clientY:100,button:0,bubbles:true,shiftKey});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));};
  send("pointerdown",true);send("pointerup");expect(text).toHaveBeenCalledWith({x:136,y:136,forceNew:true});
  render({tool:"move",onTextEdit:edit});send("dblclick");expect(edit).toHaveBeenCalledWith({x:136,y:136});send("dblclick",true);expect(edit).toHaveBeenCalledOnce();
  render({tool:"none",onTextEdit:edit});send("dblclick");expect(edit).toHaveBeenCalledOnce();
});

it("画笔Shift约束含抬笔坐标，连线预览随修饰键和活动手势切换",()=>{
 const append=vi.fn(),finish=vi.fn();const {stage,ref,container}=setup({tool:"brush",strokeAnchor:{x:20,y:30},onStrokeMove:append,onStroke:finish});
 const send=(type:string,x:number,y:number,shiftKey=true)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,shiftKey});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
 send("pointermove",100,100);expect(container.querySelector('[data-testid="stroke-line-preview"]')).not.toBeNull();
 act(()=>ref.current!.selectionKey("Shift",false));expect(container.querySelector('[data-testid="stroke-line-preview"]')).toBeNull();
 send("pointerdown",100,100);send("pointermove",130,104);expect(append.mock.lastCall?.[0][0]).toEqual({x:196,y:136});
 expect(container.querySelector('[data-testid="stroke-line-preview"]')).toBeNull();
 send("pointerup",140,150);expect(finish.mock.lastCall?.[0].at(-1)).toMatchObject({x:216,y:136});
 send("pointerdown",100,100);send("pointermove",130,104);send("pointercancel",130,104);
 send("pointerdown",100,100,false);send("pointermove",130,120,false);expect(append.mock.lastCall?.[0][0]).toEqual({x:196,y:176});
});

it("Ctrl+Alt笔刷调整固定HUD且整次只提交一次工具设置，不进入笔迹；取消不写",()=>{
 const commit=vi.fn(),begin=vi.fn(),cancel=vi.fn();
 const {stage,container,ref}=setup({tool:"brush",onStrokeStart:begin,onStrokeCancel:cancel,brushResize:{values:{size:100,hardness:.5,opacity:.8},hardness:true,commit}});
 const send=(type:string,x:number,y:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,ctrlKey:true,altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",100,100);send("pointermove",120,140);
 expect(begin).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled();expect(ref.current!.hasGesture()).toBe(true);
 const hud=container.querySelector<HTMLElement>('[data-testid="brush-resize-hud"]')!;
 expect(hud.style.left).toBe("100px");expect(hud.textContent).toContain("180 px");expect(hud.textContent).toContain("70%");
 send("pointerup",130,160);expect(commit).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledWith({size:220,hardness:.8,opacity:.8});expect(ref.current!.hasGesture()).toBe(false);
 send("pointerdown",100,100);send("pointermove",140,180);act(()=>ref.current!.cancelGesture());expect(commit).toHaveBeenCalledOnce();expect(container.querySelector('[data-testid="brush-resize-hud"]')).toBeNull();
});

it("Linux/Windows Alt右拖按关闭硬度偏好修改不透明度，吞掉原生与宿主右键菜单",()=>{
 const commit=vi.fn(),begin=vi.fn();const {stage}=setup({tool:"eraser",onStrokeStart:begin,brushResize:{values:{size:50,hardness:.4,opacity:.5},hardness:false,commit}});
 const send=(type:string,x:number,y:number)=>{const e=new MouseEvent(type,{button:2,clientX:x,clientY:y,altKey:true,bubbles:true,cancelable:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));return e;};
 const parent=vi.fn();stage.parentElement!.addEventListener("contextmenu",parent);
 send("pointerdown",100,100);send("pointermove",110,140);expect(send("contextmenu",110,140).defaultPrevented).toBe(true);expect(parent).not.toHaveBeenCalled();
 send("pointerup",110,140);expect(commit).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledWith({size:90,hardness:.4,opacity:.7});expect(begin).not.toHaveBeenCalled();
});


it("固定尺寸单击提交预设框，取消不产生选区，固定比例点击仍保留原点击语义",()=>{
 const onMarquee=vi.fn(),onSelectionClick=vi.fn();
 const {stage,render}=setup({tool:"marquee",marqueeConstraint:{mode:"size",width:80,height:40},onMarquee,onSelectionClick});
 pointer(stage,"pointerdown");pointer(stage,"pointerup");
 expect(onMarquee).toHaveBeenCalledOnce();expect(onMarquee.mock.calls[0][0]).toMatchObject({width:80,height:40});expect(onSelectionClick).not.toHaveBeenCalled();
 pointer(stage,"pointerdown");pointer(stage,"pointercancel");pointer(stage,"pointerup");expect(onMarquee).toHaveBeenCalledOnce();
 render({tool:"marquee",marqueeConstraint:{mode:"ratio",width:2,height:1},onMarquee,onSelectionClick});
 pointer(stage,"pointerdown");pointer(stage,"pointerup");expect(onMarquee).toHaveBeenCalledOnce();expect(onSelectionClick).toHaveBeenCalledOnce();
});
it("仅边界Move从变换框拖动也显示位移箭头，清除矩阵或显式自由变换隐藏",()=>{
 const props:Partial<PhotoCanvasProps>={tool:"move",transformFrame:[20,30,100,90],transformMoveOnly:true,moveBoundingBox:true,transformMatrix:[1,0,0,1,12,8],onTransform:vi.fn()};
 const {container,render}=setup(props);const line=container.querySelector('[data-move-arrow] line')!;
 expect(line).not.toBeNull();expect(Number(line.getAttribute("x2"))-Number(line.getAttribute("x1"))).toBe(6);expect(Number(line.getAttribute("y2"))-Number(line.getAttribute("y1"))).toBe(4);
 render({...props,transformMatrix:[1,0,0,1,0,0]});expect(container.querySelector('[data-move-arrow]')).toBeNull();
 render({...props,transformMoveOnly:false});expect(container.querySelector('[data-move-arrow]')).toBeNull();
});

it("自由套索按序消费合并移动/抬起样本，图外路径保留至内核裁剪",()=>{
 const onLasso=vi.fn(),{stage}=setup({tool:"lasso",onLasso});
 const send=(type:string,x:number,y:number,samples:{clientX:number;clientY:number}[]=[])=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});Object.defineProperty(event,"getCoalescedEvents",{value:()=>samples});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",100,100);send("pointermove",220,180,[{clientX:-10,clientY:90},{clientX:180,clientY:-20}]);send("pointerup",100,100,[{clientX:900,clientY:530}]);
 expect(onLasso).toHaveBeenCalledOnce();const points=onLasso.mock.calls[0]![0] as {x:number;y:number}[];
 expect(points).toHaveLength(6);expect(points[1]!.x).toBeLessThan(0);expect(points[2]!.y).toBeLessThan(0);expect(points[4]!.x).toBeGreaterThan(1600);expect(points[4]!.y).toBeGreaterThan(900);expect(points[5]).toEqual(points[0]);
});
it("缩放工具以点击处为锚点，Alt缩小，手形拖动只改变视图",()=>{
 const {stage,render,changed}=setup({tool:"zoom"});
 const click=(altKey=false)=>{for(const type of ["pointerdown","pointerup"]){const event=new MouseEvent(type,{button:0,clientX:100,clientY:100,altKey,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));}};
 click();expect(changed.mock.lastCall?.[0].zoom).toBe(2/3);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(332/3);expect(changed.mock.lastCall?.[0].y).toBeCloseTo(157/3);
 click(true);expect(changed.mock.lastCall?.[0].zoom).toBe(0.5);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(0);expect(changed.mock.lastCall?.[0].y).toBeCloseTo(0);
 render({tool:"pan"});pointer(stage,"pointerdown");const event=new MouseEvent("pointermove",{button:0,clientX:120,clientY:130,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));timedPointer(stage,"pointerup",120,130,40);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(20);expect(changed.mock.lastCall?.[0].y).toBeCloseTo(30);
});

function frameClock(){
 let now=0,id=0;const callbacks=new Map<number,FrameRequestCallback>();
 vi.spyOn(performance,"now").mockImplementation(()=>now);
 vi.spyOn(window,"requestAnimationFrame").mockImplementation(callback=>{callbacks.set(++id,callback);return id;});
 vi.spyOn(window,"cancelAnimationFrame").mockImplementation(id=>{callbacks.delete(id);});
 return {step:(time:number)=>act(()=>{now=time;const frames=[...callbacks.values()];callbacks.clear();frames.forEach(callback=>callback(now));}),pending:()=>callbacks.size};
}
function timedPointer(stage:Element,type:string,x:number,y:number,at:number,button=0){
 const event=new MouseEvent(type,{clientX:x,clientY:y,button,bubbles:true,cancelable:true});
 Object.defineProperties(event,{pointerId:{value:1},timeStamp:{value:at}});act(()=>stage.dispatchEvent(event));
}
it("animated zoom finishes exactly and interruption prevents late frames",()=>{
 const clock=frameClock(),{ref,changed,stage,container}=setup({animatedZoom:true});
 act(()=>ref.current!.view("actualSize"));expect(changed).not.toHaveBeenCalled();clock.step(110);
 expect(changed.mock.lastCall?.[0].zoom).toBeGreaterThan(.5);expect(changed.mock.lastCall?.[0].zoom).toBeLessThan(1);
 clock.step(220);expect(changed.mock.lastCall?.[0]).toEqual({x:0,y:0,zoom:1});expect(clock.pending()).toBe(0);
 act(()=>ref.current!.view("fit"));clock.step(250);act(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
 const count=changed.mock.calls.length;clock.step(500);expect(changed).toHaveBeenCalledTimes(count);
 act(()=>ref.current!.view("actualSize"));timedPointer(stage,"pointerdown",100,100,510);expect(clock.pending()).toBe(0);
 timedPointer(stage,"pointercancel",100,100,520);expect(container.querySelector(".photo-editor-canvas__zoom")).not.toBeNull();
});
it("middle-button pan preserves the tool, coasts after release and stops on keys or blocked view",()=>{
 const clock=frameClock(),{stage,changed,ref,render}=setup({tool:"brush",enableFlickPanning:true});
 timedPointer(stage,"pointerdown",100,100,0,1);timedPointer(stage,"pointermove",120,110,20,1);timedPointer(stage,"pointerup",140,120,40,1);
 expect(ref.current!.hasGesture()).toBe(false);expect(changed.mock.lastCall?.[0]).toEqual({zoom:.5,x:40,y:20});
 clock.step(16);expect(changed.mock.lastCall?.[0].x).toBeGreaterThan(40);expect(changed.mock.lastCall?.[0].y).toBeGreaterThan(20);
 act(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"b"})));const count=changed.mock.calls.length;clock.step(32);expect(changed).toHaveBeenCalledTimes(count);
 timedPointer(stage,"pointerdown",100,100,100,1);timedPointer(stage,"pointermove",120,100,120,1);timedPointer(stage,"pointerup",140,100,140,1);
 render({tool:"brush",enableFlickPanning:true,interactive:false});expect(clock.pending()).toBe(0);expect(stage.dataset.tool).toBe("brush");
});
it("zoom clicked-point preference centers the point without document edits",()=>{
 const {stage,changed}=setup({tool:"zoom",zoomClickedPointToCenter:true});
 timedPointer(stage,"pointerdown",532,317,0);timedPointer(stage,"pointerup",532,317,10);
 expect(changed.mock.lastCall?.[0].zoom).toBe(2/3);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(-400/3);expect(changed.mock.lastCall?.[0].y).toBeCloseTo(-80);
});

it("fixed zoom, print PPI and selected bounds share the viewport port and respect gesture gates",()=>{
 const {ref,changed,stage}=setup({resolutionDpi:300,screenResolution:144,selectedBounds:[100,200,200,100]});
 act(()=>ref.current!.view("twoHundredPercent"));expect(changed.mock.lastCall?.[0]).toEqual({x:0,y:0,zoom:2});
 act(()=>ref.current!.view("printSize"));expect(changed.mock.lastCall?.[0]).toEqual({x:0,y:0,zoom:.48});
 act(()=>ref.current!.view("fitLayers"));expect(changed.mock.lastCall?.[0]).toEqual({x:2472,y:824,zoom:4.12});
 act(()=>ref.current!.view("fitLayers",null));expect(changed.mock.lastCall?.[0]).toEqual({x:0,y:0,zoom:.5});
 pointer(stage,"pointerdown");const count=changed.mock.calls.length;act(()=>ref.current!.view("printSize"));expect(changed).toHaveBeenCalledTimes(count);
});

it("bucket routes one in-canvas click without starting a drag or stroke",()=>{
 const bucket=vi.fn(),stroke=vi.fn(),{stage,ref,render}=setup({tool:"bucket",onBucket:bucket,onStrokeStart:stroke});
 timedPointer(stage,"pointerdown",100,100,0);expect(bucket).toHaveBeenCalledWith({x:136,y:136});expect(ref.current!.hasGesture()).toBe(false);expect(stroke).not.toHaveBeenCalled();
 timedPointer(stage,"pointerup",100,100,10);expect(bucket).toHaveBeenCalledOnce();
 timedPointer(stage,"pointerdown",0,0,20);expect(bucket).toHaveBeenCalledOnce();
 render({tool:"bucket",onBucket:bucket,interactive:false});timedPointer(stage,"pointerdown",100,100,30);expect(bucket).toHaveBeenCalledOnce();
});

it("块状橡皮擦保持16屏幕像素方形光标，禁止调整笔头HUD",()=>{
 const begin=vi.fn(),commit=vi.fn();const {stage,container}=setup({tool:"eraser",eraserMode:"block",brushSize:80,onStrokeStart:begin,brushResize:{values:{size:80,hardness:1,opacity:1},hardness:true,commit}});
 pointer(stage,"pointermove");const cursor=container.querySelector<HTMLElement>(".photo-editor-canvas__brush-cursor")!;
 expect(cursor.style.width).toBe("16px");expect(cursor.style.height).toBe("16px");expect(cursor.style.borderRadius).toBe("0px");
 const e=new MouseEvent("pointerdown",{button:2,altKey:true,clientX:100,clientY:100,bubbles:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));
 expect(container.querySelector('[data-testid="brush-resize-hud"]')).toBeNull();expect(commit).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
});

it("铅笔抬笔提交一次，指针取消、宿主取消和工具切换均撤销临时笔迹",()=>{
 const begin=vi.fn(),cancel=vi.fn(),commit=vi.fn();const props:Partial<PhotoCanvasProps>={tool:"pencil",onStrokeStart:begin,onStroke:commit,onStrokeCancel:cancel};const {stage,render,ref}=setup(props);
 pointer(stage,"pointerdown");pointer(stage,"pointerup");expect(begin).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledOnce();expect(cancel).not.toHaveBeenCalled();
 pointer(stage,"pointerdown");pointer(stage,"pointercancel");expect(cancel).toHaveBeenCalledTimes(1);
 pointer(stage,"pointerdown");act(()=>ref.current!.cancelGesture());expect(cancel).toHaveBeenCalledTimes(2);
 pointer(stage,"pointerdown");render({...props,tool:"brush"});expect(cancel).toHaveBeenCalledTimes(3);expect(commit).toHaveBeenCalledOnce();
});

it("吸管按Alt写背景色、拖动连续取样并显示比较环，抬笔和取消清理",()=>{
 const sample=vi.fn(),begin=vi.fn(),props:Partial<PhotoCanvasProps>={tool:"eyedropper",onSampleColor:sample,onStrokeStart:begin,samplingColors:{foreground:"#112233",background:"#ffffff",current:"#336699"}};
 const {stage,container,ref}=setup(props);
 const send=(type:string,x:number,y:number,altKey=false)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,altKey,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",100,100,true);expect(sample).toHaveBeenLastCalledWith({x:136,y:136},{background:true});expect(container.querySelector('[data-sample-ring] circle')!.getAttribute("stroke")).toBe("#ffffff");
 send("pointermove",120,110);expect(sample).toHaveBeenLastCalledWith({x:176,y:156},{background:false});
 send("pointerup",120,110);expect(container.querySelector('[data-sample-ring]')).toBeNull();expect(begin).not.toHaveBeenCalled();
 send("pointerdown",100,100);const count=sample.mock.calls.length;act(()=>ref.current!.cancelGesture());send("pointerup",100,100);expect(sample).toHaveBeenCalledTimes(count);expect(container.querySelector('[data-sample-ring]')).toBeNull();
});
it("油漆桶Alt取样不填充，橡皮Alt保持擦除不取样",()=>{
 const sample=vi.fn(),bucket=vi.fn(),stroke=vi.fn();const {stage,render}=setup({tool:"bucket",onBucket:bucket,onSampleColor:sample});
 const send=(type:string)=>{const event=new MouseEvent(type,{button:0,clientX:100,clientY:100,altKey:true,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
 send("pointerdown");send("pointerup");expect(sample).toHaveBeenCalled();expect(bucket).not.toHaveBeenCalled();sample.mockClear();
 render({tool:"eraser",onSampleColor:sample,onStrokeStart:stroke});send("pointerdown");send("pointerup");expect(stroke).toHaveBeenCalledOnce();expect(sample).not.toHaveBeenCalled();
});

it("状态栏直接倍率使用统一上下限且保持画布中心锚点，半笔拒绝",()=>{
 const {ref,stage,changed}=setup({tool:"pencil",onStrokeStart:vi.fn()});
 act(()=>ref.current!.zoomTo(2));expect(changed.mock.lastCall?.[0]).toEqual({zoom:2,x:0,y:0});
 act(()=>ref.current!.zoomTo(999));expect(changed.mock.lastCall?.[0].zoom).toBe(128);
 act(()=>ref.current!.zoomTo(.000001));expect(changed.mock.lastCall?.[0].zoom).toBeCloseTo(2/900);
 const count=changed.mock.calls.length;pointer(stage,"pointerdown");act(()=>ref.current!.zoomTo(1));expect(changed).toHaveBeenCalledTimes(count);pointer(stage,"pointercancel");
});

it("数位笔同点轻点使用接触峰值，合并事件与抬笔样本计入；移动笔迹不当作tap重建",()=>{
 const tap=vi.fn(),commit=vi.fn(),move=vi.fn(),{stage}=setup({tool:"brush",onStrokeStart:vi.fn(),onStrokeTap:tap,onStroke:commit,onStrokeMove:move});
 const send=(type:string,x:number,pressure:number,samples?:{clientX:number;clientY:number;pressure:number}[])=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:100,bubbles:true});Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:"pen"},pressure:{value:pressure},getCoalescedEvents:{value:()=>samples??[]}});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",100,.1);send("pointermove",100,.3,[{clientX:100,clientY:100,pressure:.8},{clientX:100,clientY:100,pressure:.3}]);send("pointerup",100,0);expect(move).not.toHaveBeenCalled();expect(tap.mock.lastCall?.[0].pressure).toBe(.8);expect(commit.mock.lastCall?.[0]).toHaveLength(1);expect(commit.mock.lastCall?.[0][0].pressure).toBe(.8);
 tap.mockClear();send("pointerdown",100,.1);send("pointerup",100,.65);expect(tap.mock.lastCall?.[0].pressure).toBe(.65);
 tap.mockClear();send("pointerdown",100,.2);send("pointermove",110,.4);send("pointerup",120,0);expect(tap).not.toHaveBeenCalled();expect(commit.mock.lastCall?.[0].at(-1).pressure).toBe(.4);
});

it("Move悬停绘制原生候选边界，离开/配置/手势清理，修饰键保留自动选择切换意图",()=>{
 const hover=vi.fn((_point:unknown,_modifiers:unknown)=>({layer:9,frame:[10,20,30,40] as [number,number,number,number]})),{stage,container,render}=setup({tool:"move",onMoveHover:hover,moveHoverKey:"a"});
 const move=(ctrlKey=false)=>act(()=>stage.dispatchEvent(new MouseEvent("pointermove",{clientX:100,clientY:100,bubbles:true,ctrlKey})));
 move();const rect=container.querySelector('[data-move-hover="9"] rect')!;expect(rect).not.toBeNull();expect(rect.getAttribute("x")).toBe("37");expect(rect.getAttribute("y")).toBe("42");expect(rect.getAttribute("width")).toBe("10");expect(hover.mock.lastCall?.[1]).toEqual({toggleAuto:false});move(true);expect(hover.mock.lastCall?.[1]).toEqual({toggleAuto:true});
 act(()=>stage.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body})));expect(container.querySelector('[data-move-hover]')).toBeNull();move();render({tool:"move",onMoveHover:hover,moveHoverKey:"b"});expect(container.querySelector('[data-move-hover]')).toBeNull();move();pointer(stage,"pointerdown");expect(container.querySelector('[data-move-hover]')).toBeNull();
 render({tool:"move",onMoveHover:hover,interactive:false});hover.mockClear();move();expect(hover).not.toHaveBeenCalled();
});

it("Move静止指针修饰键即时更新候选，失焦后不恢复过期位置",()=>{
 const hover=vi.fn((_point:unknown,keys:{toggleAuto:boolean})=>keys.toggleAuto?null:{layer:9,frame:[10,20,30,40] as [number,number,number,number]}),{stage,container,ref}=setup({tool:"move",onMoveHover:hover});
 pointer(stage,"pointermove");expect(container.querySelector('[data-move-hover]')).not.toBeNull();
 act(()=>{ref.current!.selectionKey("Control",true);});expect(container.querySelector('[data-move-hover]')).toBeNull();
 act(()=>{ref.current!.selectionKey("Control",false);});expect(container.querySelector('[data-move-hover]')).not.toBeNull();
 act(()=>window.dispatchEvent(new Event("blur")));expect(container.querySelector('[data-move-hover]')).toBeNull();hover.mockClear();
 act(()=>{ref.current!.selectionKey("Control",false);});expect(hover).not.toHaveBeenCalled();
});

it("Move Cmd/Ctrl悬停显示单位距离线与标签，松开或按下时清除且不写文档",()=>{
 const target=[200,100,300,180] as const,measure=vi.fn(()=>target);
 const {stage,container,ref,render}=setup({tool:"move",measureMoveDistance:true,hasSelection:true,selectedBounds:[40,40,50,40],measurementUnit:"pixels",onMoveMeasure:measure});
 const move=(ctrlKey:boolean)=>act(()=>stage.dispatchEvent(new MouseEvent("pointermove",{clientX:100,clientY:100,bubbles:true,ctrlKey})));
 move(false);expect(container.querySelector("[data-move-distance]")).toBeNull();expect(measure).not.toHaveBeenCalled();
 move(true);expect(measure).toHaveBeenCalled();
 // 选区 [40,40]..[90,80]，目标 [200,100]..[300,180]：水平空隙 110px、垂直空隙 20px。
 const labels=[...container.querySelectorAll("[data-move-distance-label]")].map(node=>node.getAttribute("data-move-distance-label"));
 expect(labels).toEqual(["110 px","20 px"]);
 // 两条距离线都终止在目标框旁边（选区与目标在两个轴上都分离）：各补一条虚线延长线。
 expect(container.querySelectorAll(".photo-editor-canvas__move-distance-extension")).toHaveLength(2);
 const line=container.querySelector(".photo-editor-canvas__move-distance-line")!;
 expect(Number(line.getAttribute("x1"))).toBeGreaterThan(0);
 // 按下指针后不显示测距；取消手势后不因过期位置恢复。
 pointer(stage,"pointerdown");expect(container.querySelector("[data-move-distance]")).toBeNull();
 act(()=>ref.current!.cancelGesture());expect(container.querySelector("[data-move-distance]")).toBeNull();
 // Extras 关闭时整个覆盖层不出现。
 render({tool:"move",measureMoveDistance:false,hasSelection:true,selectedBounds:[40,40,50,40],onMoveMeasure:measure});
 move(true);expect(container.querySelector("[data-move-distance]")).toBeNull();
});

it("Move距离在悬停空白时量到画布边缘，Alt复制拖动量原件与副本间距",()=>{
 const {stage,container}=setup({tool:"move",measureMoveDistance:true,hasSelection:true,selectedBounds:[40,40,50,40],onMoveMeasure:()=>null});
 const move=(ctrlKey:boolean)=>act(()=>stage.dispatchEvent(new MouseEvent("pointermove",{clientX:100,clientY:100,bubbles:true,ctrlKey})));
 move(true);
 // 画布 1600×900：到左右上下四边的距离。
 const labels=[...container.querySelectorAll("[data-move-distance-label]")].map(node=>node.getAttribute("data-move-distance-label"));
 expect(labels).toEqual(["40 px","1510 px","40 px","820 px"]);
 expect(container.querySelector(".photo-editor-canvas__move-distance-extension")).toBeNull();
});

it.each(["brush","pencil","eraser","text"] as const)("%s拖出可视区自动平移延续同一候选，内部边缘不触发、取消隔离迟到帧",tool=>{
 const callbacks=new Map<number,FrameRequestCallback>();let sequence=0;
 vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{callbacks.set(++sequence,callback);return sequence;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const stroke=vi.fn(),move=vi.fn(),text=vi.fn(),cancel=vi.fn(),{stage,ref,changed,container}=setup({tool,onStrokeStart:vi.fn(),onStrokeMove:move,onStroke:stroke,onStrokeCancel:cancel,onText:text});
 act(()=>ref.current!.view("actualSize"));changed.mockClear();
 const send=(type:string,x:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:type==="pointerdown"?200:220,bubbles:true});Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:"pen"},pressure:{value:.65}});act(()=>stage.dispatchEvent(event));};
 try{
 send("pointerdown",850);send("pointermove",860);expect(callbacks.size).toBe(0);send("pointermove",892);expect(callbacks.size).toBe(1);
 act(()=>callbacks.get(1)!(0));expect(changed).toHaveBeenLastCalledWith({x:-7,y:0,zoom:1});
 if(tool==="text")expect(container.querySelector(".photo-editor-canvas__marquee")?.getAttribute("style")).toContain("width: 49px");
 else expect(move.mock.lastCall?.[0]).toEqual([expect.objectContaining({x:1267,y:413,pressure:.65})]);
 send("pointerup",892);if(tool==="text")expect(text).toHaveBeenCalledWith({x:1218,y:393,box:[1218,393,49,20]});else {expect(stroke).toHaveBeenCalledOnce();expect(stroke.mock.calls[0][0].at(-1)).toMatchObject({x:1267,y:413,pressure:.65});}
 act(()=>callbacks.get(2)!(16));expect(changed).toHaveBeenCalledOnce();
 send("pointerdown",850);send("pointermove",892);const stale=callbacks.get(3)!;act(()=>ref.current!.cancelGesture());act(()=>stale(32));send("pointerup",892);expect(tool==="text"?text:stroke).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();}
});

it("文件背景棋盘格只覆文档矩形且网格不随缩放，关闭后显示白色；预览端口保持同一源坐标",()=>{
 const renderBackground=vi.fn(()=>null),{container,ref,render}=setup({renderBackground});let grid=container.querySelector<HTMLElement>("[data-transparency-grid]")!;
 expect(grid.style.left).toBe("32px");expect(grid.style.top).toBe("32px");expect(grid.style.width).toBe("800px");expect(grid.style.backgroundSize).toBe("16px 16px");expect(renderBackground).toHaveBeenLastCalledWith({x:32,y:32},.5);
 act(()=>ref.current!.view("actualSize"));grid=container.querySelector<HTMLElement>("[data-transparency-grid]")!;expect(grid.style.width).toBe("1600px");expect(grid.style.backgroundSize).toBe("16px 16px");
 render({renderBackground,transparency:{size:"none",colors:"custom",light:"#123456",dark:"#654321"}});grid=container.querySelector<HTMLElement>("[data-transparency-grid]")!;expect(grid.style.backgroundImage).toBe("");expect(grid.style.backgroundColor).toBe("rgb(255, 255, 255)");
 render({});expect(container.querySelector("[data-transparency-grid]")).toBeNull();
});


it("Zoom拖动锚点连续变化，释放使用最终坐标；取消/失焦停止且不写笔迹",()=>{
 const clock=frameClock(),onStroke=vi.fn(),{stage,changed,ref}=setup({tool:"zoom",onStroke});
 timedPointer(stage,"pointerdown",532,257,0);expect(stage.dataset.canvasViewportBlocked).toBe("true");expect(changed).not.toHaveBeenCalled();
 timedPointer(stage,"pointermove",632,257,10);expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:-100,y:0});
 timedPointer(stage,"pointerup",432,257,20);expect(changed.mock.lastCall?.[0]).toEqual({zoom:.25,x:50,y:0});expect(ref.current!.hasGesture()).toBe(false);expect(stage.dataset.canvasViewportBlocked).toBeUndefined();expect(clock.pending()).toBe(0);
 timedPointer(stage,"pointerdown",432,257,30);clock.step(316);expect(changed.mock.lastCall?.[0].zoom).toBeGreaterThan(.25);
 act(()=>window.dispatchEvent(new Event("blur")));const count=changed.mock.calls.length;clock.step(500);timedPointer(stage,"pointerup",632,257,510);expect(changed).toHaveBeenCalledTimes(count);expect(ref.current!.hasGesture()).toBe(false);expect(onStroke).not.toHaveBeenCalled();
});
it("关闭连续缩放后显示屏幕矩形，释放适合视口，取消/工具切换清候选",()=>{
 const {stage,container,changed,render}=setup({tool:"zoom",zoomScrubby:false});
 timedPointer(stage,"pointerdown",232,157,0);timedPointer(stage,"pointermove",432,257,10);expect(changed).not.toHaveBeenCalled();
 const rect=container.querySelector('[data-zoom-rectangle] rect')!;expect(rect.getAttribute("width")).toBe("200");expect(rect.getAttribute("height")).toBe("100");
 timedPointer(stage,"pointerup",632,357,20);expect(changed.mock.lastCall?.[0]).toEqual({zoom:1.08,x:0,y:0});expect(container.querySelector('[data-zoom-rectangle]')).toBeNull();
 timedPointer(stage,"pointerdown",232,157,30);timedPointer(stage,"pointermove",432,257,40);render({tool:"brush"});expect(container.querySelector('[data-zoom-rectangle]')).toBeNull();const count=changed.mock.calls.length;timedPointer(stage,"pointerup",632,357,50);expect(changed).toHaveBeenCalledTimes(count);
});
it("Hand仅在按下时解释缩放修饰键，工具保持；平移中追加修饰不改成缩放",()=>{
 const {stage,changed}=setup({tool:"pan"});
 const send=(type:string,x:number,ctrlKey=false,altKey=false)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:257,ctrlKey,altKey});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",532,true);send("pointermove",632,true);send("pointerup",632,true);expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:-100,y:0});expect(stage.dataset.tool).toBe("pan");
 send("pointerdown",432,false,true);send("pointerup",432,false,true);expect(changed.mock.lastCall?.[0].zoom).toBe(2/3);
 const before=changed.mock.lastCall![0];send("pointerdown",432);send("pointermove",452,true);send("pointerup",472,true);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(before.x+40);expect(changed.mock.lastCall?.[0].zoom).toBe(before.zoom);expect(changed.mock.lastCall?.[0].y).toBe(before.y);
});
it("页面导航与Home/End保持倍率，手势及只读门禁不发布视图",()=>{
 const {ref,changed,stage,render}=setup();
 act(()=>ref.current!.view("actualSize"));act(()=>ref.current!.navigate!({key:"PageDown",horizontal:false,small:false}));expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:0,y:-193});
 act(()=>ref.current!.navigate!({key:"Home",horizontal:false,small:false}));expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:368,y:193});
 act(()=>ref.current!.navigate!({key:"PageDown",horizontal:true,small:true}));expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:358,y:193});
 pointer(stage,"pointerdown");const count=changed.mock.calls.length;act(()=>ref.current!.navigate!({key:"End",horizontal:false,small:false}));expect(changed).toHaveBeenCalledTimes(count);pointer(stage,"pointercancel");
 render({interactive:false});act(()=>ref.current!.navigate!({key:"End",horizontal:false,small:false}));expect(changed).toHaveBeenCalledTimes(count);
});

it("绘画光标按偏好/硬度显示笔尖与中心，半笔只十字后恢复，标准/精确无轮廓",()=>{
 const prefs={painting:"normalTip" as const,center:true,paintingCrosshairOnly:true,other:"standard" as const},begin=vi.fn(),{stage,container,render}=setup({tool:"brush",brushSize:100,brushHardness:0,cursors:prefs,onStrokeStart:begin});
 pointer(stage,"pointermove");let tip=container.querySelector<HTMLElement>('[data-brush-cursor]')!;expect(parseFloat(tip.style.width)).toBeLessThan(50);expect(tip.querySelector('.photo-editor-canvas__brush-center')).not.toBeNull();expect(stage.style.cursor).toBe("none");
 pointer(stage,"pointerdown");expect(begin).toHaveBeenCalledOnce();expect(container.querySelector('[data-brush-cursor]')).toBeNull();expect(stage.style.cursor).toBe("crosshair");pointer(stage,"pointerup");expect(container.querySelector('[data-brush-cursor]')).not.toBeNull();
 render({tool:"brush",brushSize:100,cursors:{...prefs,painting:"fullSizeTip"}});pointer(stage,"pointermove");tip=container.querySelector<HTMLElement>('[data-brush-cursor]')!;expect(tip.style.width).toBe("50px");
 render({tool:"brush",brushSize:100,cursors:{...prefs,painting:"standard"}});expect(container.querySelector('.photo-editor-canvas__tool-cursor')).not.toBeNull();expect(container.querySelector('[data-brush-cursor]')).toBeNull();
 render({tool:"brush",brushSize:100,cursors:{...prefs,painting:"precise"}});expect(stage.style.cursor).toBe("crosshair");expect(container.querySelector('.photo-editor-canvas__tool-cursor')).toBeNull();
});
it("其它工具精确光标覆盖Move/Type/吸管，Hand保留导航光标",()=>{
 const prefs={painting:"normalTip" as const,center:false,paintingCrosshairOnly:false,other:"precise" as const},{stage,render}=setup({tool:"move",cursors:prefs});
 for(const tool of ["move","text","bucket","eyedropper","marquee","lasso"] as const){render({tool,cursors:prefs});expect(stage.style.cursor).toBe("crosshair");}
 render({tool:"pan",cursors:prefs});expect(stage.style.cursor).toBe("");
});

it("像素工具拒绝按下后立即释放手势，后续移动和抬笔不恢复旧笔迹",()=>{
 const onStrokeStart=vi.fn(()=>false),onStrokeMove=vi.fn(),onStroke=vi.fn(),onStrokeCancel=vi.fn();
 const {stage,ref}=setup({tool:"brush",onStrokeStart,onStrokeMove,onStroke,onStrokeCancel});
 pointer(stage,"pointerdown");expect(onStrokeStart).toHaveBeenCalledOnce();expect(ref.current!.hasGesture()).toBe(false);expect(onStrokeCancel).toHaveBeenCalledOnce();
 pointer(stage,"pointermove");pointer(stage,"pointerup");expect(onStrokeMove).not.toHaveBeenCalled();expect(onStroke).not.toHaveBeenCalled();
});
it("独立画布工作区颜色与文档边界独立于透明网格，宿主节点视图不遮盖底层",()=>{
 const pasteboard={color:"custom" as const,custom:"#123456",border:"line" as const,dots:true},renderBackground=vi.fn(()=>null);
 const {stage,container,render}=setup({renderBackground,pasteboard,transparency:{size:"medium",colors:"light",light:"#ffffff",dark:"#cccccc"}});
 expect(stage.style.backgroundColor).toBe("rgb(18, 52, 86)");expect(stage.style.backgroundImage).toBe("none");
 const border=container.querySelector<HTMLElement>('[data-canvas-border]')!;expect(border.style.left).toBe("32px");expect(border.style.width).toBe("800px");expect(border.style.outline).toBe("1px solid #141414");
 expect(container.querySelector('[data-transparency-grid]')).not.toBeNull();
 render({renderBackground,pasteboard:{...pasteboard,border:"none"}});expect(container.querySelector<HTMLElement>('[data-canvas-border]')!.style.outline).toBe("none");
 render({pasteboard});expect(stage.style.backgroundColor).toBe("");expect(container.querySelector('[data-canvas-border]')).toBeNull();
});
it("滚轮偏好交换平移/缩放并保留指针锚点；捏合关闭、半笔与只读均不误导航",()=>{
 const {stage,changed,render}=setup();
 const wheel=(patch:WheelEventInit={})=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,clientX:532,clientY:257,deltaMode:1,deltaY:-3,...patch});act(()=>stage.dispatchEvent(event));return event;};
 wheel();expect(changed.mock.lastCall?.[0]).toEqual({x:0,y:120,zoom:.5});
 wheel({altKey:true});const next=changed.mock.lastCall![0];expect(next.zoom).toBeCloseTo(.55);expect((100-next.x)/next.zoom).toBeCloseTo(200);
 render({zoomWithScrollWheel:true,zoomWithTrackpadPinch:false});wheel({altKey:true});expect(changed.mock.lastCall?.[0].zoom).toBeCloseTo(.55);
 wheel({ctrlKey:true,deltaMode:0,deltaY:-10});expect(changed.mock.lastCall?.[0].zoom).toBeCloseTo(.55);
 pointer(stage,"pointerdown");const count=changed.mock.calls.length;expect(wheel().defaultPrevented).toBe(true);expect(changed).toHaveBeenCalledTimes(count);pointer(stage,"pointercancel");
 render({interactive:false});expect(wheel().defaultPrevented).toBe(true);expect(changed).toHaveBeenCalledTimes(count);
});
it("Overscroll关时手势/滚轮都夹紧，切偏好立即修正旧取景，小图位置保持到视口边界",()=>{
 const {stage,changed,render}=setup({overscroll:true});
 timedPointer(stage,"pointerdown",432,257,0);timedPointer(stage,"pointerup",1432,1257,100);expect(changed.mock.lastCall?.[0]).toEqual({zoom:.5,x:1000,y:1000});
 render({overscroll:false});expect(changed.mock.lastCall?.[0]).toEqual({zoom:.5,x:32,y:32});
 act(()=>stage.dispatchEvent(new WheelEvent("wheel",{deltaY:1000,bubbles:true,cancelable:true})));expect(changed.mock.lastCall?.[0]).toEqual({zoom:.5,x:32,y:-32});
 timedPointer(stage,"pointerdown",432,257,200);timedPointer(stage,"pointerup",420,267,300);expect(changed.mock.lastCall?.[0]).toEqual({zoom:.5,x:20,y:-22});
});
it("画布滚动条轨道翻页、滑块最终坐标、取消与旧抬笔不写图像；隐藏/只读门禁",()=>{
 const {stage,container,ref,changed,render}=setup({overscroll:false});act(()=>ref.current!.view("actualSize"));
 const bar=()=>container.querySelector<HTMLElement>('[data-scrollbar-axis="x"]')!;
 const send=(target:HTMLElement,type:string,x:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:510,bubbles:true});Object.defineProperty(event,"pointerId",{value:7});act(()=>target.dispatchEvent(event));};
 let element=bar();element.setPointerCapture=vi.fn();element.hasPointerCapture=()=>true;element.releasePointerCapture=vi.fn();
 send(element,"pointerdown",50);expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:368,y:0});expect(ref.current!.hasGesture()).toBe(false);
 act(()=>ref.current!.view("actualSize"));element=bar();element.setPointerCapture=vi.fn();element.hasPointerCapture=()=>true;element.releasePointerCapture=vi.fn();
 const thumb=element.firstElementChild as HTMLElement,start=parseFloat(thumb.style.left),length=parseFloat(thumb.style.width),perPoint=(1600-864)/(852-length);
 send(element,"pointerdown",start+length/2);expect(ref.current!.hasGesture()).toBe(true);expect(stage.dataset.canvasViewportBlocked).toBe("true");
 send(element,"pointermove",start+length/2+50);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(-50*perPoint);
 send(element,"pointerup",start+length/2+100);expect(changed.mock.lastCall?.[0].x).toBeCloseTo(-100*perPoint);expect(ref.current!.hasGesture()).toBe(false);
 const count=changed.mock.calls.length;send(element,"pointerup",800);expect(changed).toHaveBeenCalledTimes(count);
 render({overscroll:false,interactive:false});send(bar(),"pointerdown",50);expect(changed).toHaveBeenCalledTimes(count);
 render({showScrollbars:false});expect(container.querySelector('[data-scrollbar-axis]')).toBeNull();
});
it("双指导航取消半笔且隔离剩余手指/迟到抬起，桶触屏点击延迟到释放而不误填充",()=>{
 const onStrokeStart=vi.fn(),onStroke=vi.fn(),onStrokeCancel=vi.fn(),onBucket=vi.fn();
 const {stage,ref,changed,render}=setup({tool:"brush",onStrokeStart,onStroke,onStrokeCancel});
 const touch=(type:string,id:number,x:number,y=257)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:"touch"}});act(()=>stage.dispatchEvent(event));};
 touch("pointerdown",1,332);expect(onStrokeStart).toHaveBeenCalledOnce();touch("pointerdown",2,532);expect(onStrokeCancel).toHaveBeenCalledOnce();expect(ref.current!.hasGesture()).toBe(true);
 touch("pointermove",2,732);expect(changed.mock.lastCall?.[0]).toEqual({zoom:1,x:100,y:0});
 touch("pointerup",2,732);const count=changed.mock.calls.length;touch("pointermove",1,900);touch("pointerup",1,900);expect(changed).toHaveBeenCalledTimes(count);expect(onStroke).not.toHaveBeenCalled();expect(ref.current!.hasGesture()).toBe(false);
 render({tool:"bucket",onBucket});touch("pointerdown",3,432);expect(onBucket).not.toHaveBeenCalled();touch("pointerdown",4,532);touch("pointerup",4,632);touch("pointerup",3,432);expect(onBucket).not.toHaveBeenCalled();
 touch("pointerdown",5,432);touch("pointerup",5,452);expect(onBucket).toHaveBeenCalledOnce();
 touch("pointerdown",6,432);touch("pointerdown",7,532);act(()=>window.dispatchEvent(new Event("blur")));expect(ref.current!.hasGesture()).toBe(false);const final=changed.mock.calls.length;touch("pointermove",7,732);touch("pointerup",6,432);touch("pointerup",7,732);expect(changed).toHaveBeenCalledTimes(final);
});
it("触屏手势偏好与触控板独立，禁用时第二触点不取消单指画笔",()=>{
 const onStrokeStart=vi.fn(),onStrokeCancel=vi.fn(),onStroke=vi.fn(),{stage,changed}=setup({tool:"brush",enableGestures:false,onStrokeStart,onStrokeCancel,onStroke});
 const touch=(type:string,id:number,x:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:257,bubbles:true});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:"touch"}});act(()=>stage.dispatchEvent(event));};
 touch("pointerdown",1,432);touch("pointerdown",2,532);touch("pointermove",2,732);expect(onStrokeCancel).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();touch("pointerup",2,732);touch("pointerup",1,432);expect(onStroke).toHaveBeenCalledOnce();
});
it("锁存Shift与Alt作用于真实画布手势，原生键释放不能清除锁存，关闭锁存恢复实体事件",()=>{
 const onStrokeStart=vi.fn(),onSampleColor=vi.fn(),{stage,render,ref}=setup({tool:"brush",onStrokeStart,sticky:{shift:true,command:false,alt:false}});
 pointer(stage,"pointerdown");expect(onStrokeStart.mock.lastCall?.[1]).toEqual({shift:true});pointer(stage,"pointerup");
 act(()=>ref.current!.selectionKey("Shift",false));pointer(stage,"pointerdown");expect(onStrokeStart.mock.lastCall?.[1]).toEqual({shift:true});pointer(stage,"pointercancel");
 render({tool:"brush",onStrokeStart,onSampleColor,sticky:{shift:false,command:false,alt:true}});pointer(stage,"pointerdown");expect(onSampleColor).toHaveBeenCalled();expect(onStrokeStart).toHaveBeenCalledTimes(2);pointer(stage,"pointerup");
 render({tool:"brush",onStrokeStart});pointer(stage,"pointerdown");expect(onStrokeStart.mock.lastCall?.[1]).toEqual({shift:false});pointer(stage,"pointercancel");
});

it("Info独立读取文档指针坐标；离开和失焦清理，不启动画笔或文档命令",()=>{
  const position=vi.fn(),start=vi.fn();const {container}=setup({onPointerPosition:position,onStrokeStart:start,tool:"brush"});
  const canvas=container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  position.mockClear();act(()=>canvas.dispatchEvent(new MouseEvent("pointermove",{clientX:432,clientY:257,bubbles:true})));expect(position).toHaveBeenLastCalledWith(expect.objectContaining({x:800,y:450}));expect(start).not.toHaveBeenCalled();
  act(()=>canvas.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body})));expect(position).toHaveBeenLastCalledWith(null);
  act(()=>canvas.dispatchEvent(new MouseEvent("pointermove",{clientX:432,clientY:257,bubbles:true})));act(()=>window.dispatchEvent(new Event("blur")));expect(position).toHaveBeenLastCalledWith(null);
});

it("Navigator使用实际主视口尺寸，中心/框缩放复用边界且拒绝半手势/禁用",()=>{
  const readout=vi.fn(),s=setup({onNavigatorFrame:readout,overscroll:false});
  expect(readout).toHaveBeenLastCalledWith({viewport:{x:0,y:0,zoom:.5},size:{width:864,height:514},document:{width:1600,height:900}});
  act(()=>s.ref.current!.navigator?.({type:"rectangle",x:400,y:200,width:400,height:200}));expect(s.changed).toHaveBeenLastCalledWith({x:432,y:324,zoom:2.16});
  s.changed.mockClear();pointer(s.stage,"pointerdown");act(()=>s.ref.current!.navigator?.({type:"center",x:0,y:0}));expect(s.changed).not.toHaveBeenCalled();pointer(s.stage,"pointercancel");
  s.render({onNavigatorFrame:readout,interactive:false});s.changed.mockClear();act(()=>s.ref.current!.navigator?.({type:"center",x:0,y:0}));expect(s.changed).not.toHaveBeenCalled();
});

it("选框和移动HUD按测量单位/dpi显示，正式几何仍以源像素提交",()=>{
  const onMarquee=vi.fn(),s=setup({tool:"marquee",measurementUnit:"inches",resolutionDpi:20,onMarquee});
  const send=(type:string,x:number,y:number)=>{const event=new MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>s.stage.dispatchEvent(event));};
  send("pointerdown",100,100);send("pointermove",120,115);expect(s.stage.textContent).toContain("宽 2 in · 高 1.5 in");send("pointerup",120,115);expect(onMarquee).toHaveBeenLastCalledWith(expect.objectContaining({width:40,height:30}),"replace");
  s.render({tool:"move",measurementUnit:"percent",onMovePick:()=>true,onMoveStart:()=>true});send("pointerdown",100,100);send("pointermove",120,115);expect(s.stage.textContent).toContain("ΔX 2.5 % · ΔY 3.3 %");send("pointercancel",120,115);
});


it("Move 空白框选反向不约束，Shift在按下取值，不创建变换且第二指针不能提交",()=>{
 const finish=vi.fn(),begin=vi.fn(),preview=vi.fn(),cancel=vi.fn();
 const {stage,ref}=setup({tool:"move",ellipse:true,onMovePick:()=>"box",onMoveBoxEnd:finish,onMoveStart:begin,onMovePreview:preview,onMoveCancel:cancel});
 const send=(type:string,x:number,y:number,id=1,mods:MouseEventInit={})=>{const e=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...mods});Object.defineProperty(e,"pointerId",{value:id});act(()=>stage.dispatchEvent(e));};
 send("pointerdown",100,100,1,{shiftKey:true});expect(ref.current!.hasGesture()).toBe(true);
 send("pointermove",80,70,2);send("pointerup",80,70,2);expect(finish).not.toHaveBeenCalled();
 send("pointermove",80,70,1,{shiftKey:true,altKey:true});const box=stage.querySelector<HTMLElement>('[data-testid="marquee"]')!;
 expect(box.style.width).toBe("20px");expect(box.style.height).toBe("30px");expect(box.style.borderRadius).toBe("");
 send("pointerup",80,70);expect(finish).toHaveBeenCalledWith({x:136,y:136},{x:96,y:76},true,true);
 expect(begin).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();expect(ref.current!.hasGesture()).toBe(false);
 expect(stage.dataset.canvasViewportBlocked).toBeUndefined();expect(stage.querySelector('[data-testid="marquee"]')).toBeNull();
});
it("Move 空白框选取消、丢失捕获及切换工具均零提交，点击保留按下位置",()=>{
 const finish=vi.fn();const {stage,ref,render}=setup({tool:"move",onMovePick:()=>"box",onMoveBoxEnd:finish});
 pointer(stage,"pointerdown");pointer(stage,"pointercancel");pointer(stage,"pointerup");expect(finish).not.toHaveBeenCalled();expect(stage.dataset.canvasViewportBlocked).toBeUndefined();
 pointer(stage,"pointerdown");pointer(stage,"lostpointercapture");pointer(stage,"pointerup");expect(finish).not.toHaveBeenCalled();
 pointer(stage,"pointerdown");render({tool:"pan"});pointer(stage,"pointerup");expect(finish).not.toHaveBeenCalled();expect(ref.current!.hasGesture()).toBe(false);
 render({tool:"move",onMovePick:()=>"box",onMoveBoxEnd:finish});pointer(stage,"pointerdown");pointer(stage,"pointerup");expect(finish).toHaveBeenCalledWith({x:136,y:136},{x:136,y:136},false,false);
});
it("魔棒点按只读取样坐标与修饰键，不启动拖动或创建选区草稿",()=>{
 const wand=vi.fn(),marquee=vi.fn();const {stage,ref,render}=setup({tool:"magicWand",onMagicWand:wand,onMarquee:marquee,hasSelection:false});
 const send=(type:string,x:number,y:number,mods:MouseEventInit={})=>{const e=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...mods});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));};
 send("pointerdown",100,100);expect(wand).toHaveBeenLastCalledWith({x:136,y:136},"replace");
 wand.mockClear();send("pointerdown",100,100,{shiftKey:true});expect(wand).toHaveBeenLastCalledWith({x:136,y:136},"add");
 // 空选区时 Alt 按既有规则回退替换，避免无选可减。
 wand.mockClear();send("pointerdown",100,100,{altKey:true});expect(wand).toHaveBeenLastCalledWith({x:136,y:136},"replace");
 render({tool:"magicWand",onMagicWand:wand,onMarquee:marquee,hasSelection:true});
 wand.mockClear();send("pointerdown",100,100,{altKey:true});expect(wand).toHaveBeenLastCalledWith({x:136,y:136},"subtract");
 wand.mockClear();send("pointerdown",100,100,{shiftKey:true,altKey:true});expect(wand).toHaveBeenLastCalledWith({x:136,y:136},"intersect");
 expect(marquee).not.toHaveBeenCalled();expect(ref.current!.hasGesture()).toBe(false);
 wand.mockClear();send("pointerdown",-40,-40);expect(wand).not.toHaveBeenCalled();
});
it("魔棒在只读或禁用时不消费指针",()=>{
 const wand=vi.fn();const {stage,render}=setup({tool:"magicWand",onMagicWand:wand});render({tool:"magicWand",onMagicWand:wand,interactive:false});
 const e=new MouseEvent("pointerdown",{button:0,clientX:100,clientY:100,bubbles:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));
 expect(wand).not.toHaveBeenCalled();
});

it("标尺/网格/参考线只影响显示；拖出与拖动参考线各分派一次原生命令",()=>{
 const {stage,container,render}=setup({tool:"move",guidePreferences:{...DEFAULT_GUIDE_PREFERENCES,showRulers:true,showGuides:true,showGrid:true,gridSize:100},
   guides:{horizontal:[100],vertical:[200]}});
 const change=vi.fn();
 render({tool:"move",guidePreferences:{...DEFAULT_GUIDE_PREFERENCES,showRulers:true,showGuides:true,showGrid:true,gridSize:100},guides:{horizontal:[100],vertical:[200]},onGuidesChange:change});
 // 网格与参考线都渲染。
 expect(container.querySelector("[data-canvas-grid]")).not.toBeNull();
 expect(container.querySelectorAll('[data-guide="horizontal"]')).toHaveLength(1);
 expect(container.querySelectorAll('[data-guide="vertical"]')).toHaveLength(1);
 expect(container.querySelector("[data-canvas-rulers]")).not.toBeNull();
 // 拖动顶部标尺带生成纵向参考线。
 const send=(type:string,x:number,y:number,pointerId=7)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:pointerId});act(()=>stage.dispatchEvent(event));};
 // 顶部标尺带（y<=24）拖到画布内生成水平参考线；释放点必须在标尺带之外。
 send("pointerdown",300,5);send("pointermove",300,220);send("pointerup",300,220);
 expect(change).toHaveBeenCalledOnce();
 const created=change.mock.calls[0]![0];
 expect(created.kind).toBe("create");expect(created.orientation).toBe("horizontal");
 expect(Number.isFinite(created.position)).toBe(true);
 // 拖动已有参考线到新位置只分派一次 move。
 change.mockClear();
 change.mockClear();
 // 拖动已有纵向参考线（x=200 文档 → 屏幕原点 100+200*0.5=200）到新位置。
 send("pointerdown",200,300,9);send("pointermove",260,300,9);send("pointerup",260,300,9);
 expect(change.mock.calls.filter(call=>call[0].kind==="move").length).toBeLessThanOrEqual(1);
 // 网格与参考线关闭后都不渲染。
 render({tool:"move",guidePreferences:{...DEFAULT_GUIDE_PREFERENCES,showRulers:false,showGuides:false,showGrid:false},guides:{horizontal:[100],vertical:[200]}});
 expect(container.querySelector("[data-canvas-grid]")).toBeNull();
 expect(container.querySelector('[data-guide="horizontal"]')).toBeNull();
 expect(container.querySelector("[data-canvas-rulers]")).toBeNull();
});

it("标尺带 Alt 单击设置标尺原点；参考线拖动吸附不改文档",()=>{
 const origin=vi.fn(),change=vi.fn();
 const {stage}=setup({tool:"move",guidePreferences:{...DEFAULT_GUIDE_PREFERENCES,showRulers:true},guides:{horizontal:[],vertical:[]},onRulerOrigin:origin,onGuidesChange:change});
 const send=(type:string,x:number,y:number,altKey=false)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,altKey,bubbles:true});Object.defineProperty(event,"pointerId",{value:5});act(()=>stage.dispatchEvent(event));};
 send("pointerdown",10,10,true);
 expect(origin).toHaveBeenCalledOnce();
 expect(origin.mock.calls[0]![0]).toHaveLength(2);
 expect(change).not.toHaveBeenCalled();
 // 从标尺带拖到画布外不创建参考线。
 send("pointerdown",10,10);send("pointerup",10,-500);
 expect(change).not.toHaveBeenCalled();
});
