/** @vitest-environment jsdom */
// 不传预览像素，不创建 2D 上下文；只验证视图指令和指针生命周期。
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasProps } from "./photo-editor-canvas.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
function setup(props: Partial<PhotoCanvasProps> = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(514);
  const ref = createRef<PhotoCanvasHandle>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const changed = vi.fn();
  function Harness({ value }: { value: Partial<PhotoCanvasProps> }) {
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 0.5 });
    return <PhotoCanvas ref={ref} documentWidth={1600} documentHeight={900} tool="pan"
      view={{ viewport, fitZoom: 0.5, transitioning: false, onChange: (next) => { changed(next); setViewport(next); } }} {...value} />;
  }
  const render = (next: Partial<PhotoCanvasProps> = props) => act(() => root.render(<Harness value={next} />));
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
it("图片交互层不拦截触摸板事件，只向画布入口提供操作区域和拖动状态", () => {
  const { stage, changed } = setup({ tool: "marquee" });
  const bubbled = vi.fn();
  stage.parentElement!.addEventListener("wheel", bubbled);
  const event = new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => stage.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(bubbled).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(stage.dataset.canvasViewport).toBe("true");
  pointer(stage, "pointerdown");
  expect(stage.dataset.canvasViewportBlocked).toBe("true");
  pointer(stage, "pointercancel");
  expect(stage.dataset.canvasViewportBlocked).toBeUndefined();
});
it("视图指令区分适合窗口与实际像素大小", () => {
  const { ref, changed, container } = setup();
  expect(container.querySelector(".photo-editor-canvas__zoom")).toBeNull();
  act(() => ref.current!.view("actualSize"));
  expect(changed).toHaveBeenLastCalledWith({x:0,y:0,zoom:1});
  act(() => ref.current!.view("zoomOut"));
  expect(changed).toHaveBeenLastCalledWith({x:0,y:0,zoom:1/1.2});
  act(() => ref.current!.view("fit"));
  expect(changed).toHaveBeenLastCalledWith({x:0,y:0,zoom:.5});
});
it("取消手势释放指针，迟到 pointerup 不补交操作；活动指针不接受缩放", () => {
  const { ref, stage, changed } = setup();
  pointer(stage, "pointerdown");
  expect(ref.current!.hasGesture()).toBe(true);
  act(() => ref.current!.view("actualSize"));
  expect(changed).not.toHaveBeenCalled();
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
  pointer(stage, "pointerup");
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
  pointer(stage, "pointerdown");
  act(() => ref.current!.view("fit"));
  expect(ref.current!.hasGesture()).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  render({ view: { viewport: { x: 0, y: 0, zoom: 0.54 }, fitZoom: 0.54, transitioning: false, onChange } });
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
  expect(begin).toHaveBeenCalledWith({x:-64,y:-64},{duplicate:true,toggleAuto:true});
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
  const {stage} = setup({tool:"marquee",onMarquee});
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
  expect(onMarquee).not.toHaveBeenCalled(); expect(ref.current!.selectionKey("Shift",true)).toBe(false);
  pointer(stage,"pointerdown");
  const up = new MouseEvent("pointerup",{button:0,clientX:200,clientY:150,bubbles:true});
  Object.defineProperty(up,"pointerId",{value:1}); act(() => stage.dispatchEvent(up));
  expect(onMarquee).toHaveBeenLastCalledWith({x:136,y:136,width:200,height:100},"replace");
});

it.each([[false,false],[true,false],[false,true],[true,true]])("选区内部拖动区分边界与像素（Ctrl=%s，隐藏边界=%s），单击和取消不清除选区", (ctrlKey,hidden) => {
  const begin=vi.fn(() => true), end=vi.fn(), cancel=vi.fn(), select=vi.fn(), create=vi.fn();
  const outline: PhotoCanvasProps["selectionOutline"] = [[100,100,300,100],[300,100,300,300],[300,300,100,300],[100,300,100,100]];
  const {stage,ref}=setup({tool:"marquee",selectionOutline:outline,showSelectionEdges:!hidden,onSelectionMoveStart:begin,onMoveEnd:end,onMoveCancel:cancel,onSelectionClick:select,onMarquee:create});
  expect(stage.querySelector('[data-testid="selection-outline"]')===null).toBe(hidden);
  const send=(type:string,x:number,y:number,modifiers:MouseEventInit={}) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  send("pointermove",100,100,{ctrlKey}); expect(stage.style.cursor).toBe(ctrlKey ? "grab":"move");
  send("pointerdown",100,100,{ctrlKey}); expect(begin).toHaveBeenLastCalledWith(ctrlKey);
  expect(stage.dataset.selectionOperation).toBe(ctrlKey ? "pixels":"boundary");
  send("pointermove",120,115,{ctrlKey}); send("pointerup",120,115,{ctrlKey});
  expect(end).toHaveBeenLastCalledWith([1,0,0,1,40,30]); expect(select).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  send("pointerdown",100,100); send("pointerup",100,100); expect(cancel).toHaveBeenCalledOnce();
  send("pointerdown",100,100); send("pointermove",120,115); act(() => ref.current!.cancelGesture()); send("pointerup",120,115);
  expect(cancel).toHaveBeenCalledTimes(2); expect(end).toHaveBeenCalledOnce();
  send("pointerdown",100,100,{shiftKey:true}); send("pointerup",120,115,{shiftKey:true});
  expect(create).toHaveBeenLastCalledWith({x:136,y:136,width:40,height:30},"add"); expect(begin).toHaveBeenCalledTimes(3);
  send("pointerdown",10,10); send("pointerup",10,10); expect(select).toHaveBeenCalledOnce();
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
  send("pointermove",860,220); expect(callbacks.size).toBe(1);
  act(() => callbacks.get(1)!(0)); expect(changed).toHaveBeenLastCalledWith({x:-7,y:0,zoom:1});
  send("pointerup",860,220);
  expect(onMarquee).toHaveBeenLastCalledWith({x:1218,y:393,width:17,height:20},"replace");
  const stale=callbacks.get(2)!; act(() => stale(16)); expect(changed).toHaveBeenCalledOnce();
  send("pointerdown",850,200); send("pointermove",860,220); act(() => ref.current!.cancelGesture());
  send("pointerup",860,220); expect(onMarquee).toHaveBeenCalledOnce();
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
  send("pointerdown",850,200); send("pointermove",860,220);
  act(() => callbacks.get(1)!(0));
  expect(preview).toHaveBeenLastCalledWith([1,0,0,1,17,20]);
  expect(changed).toHaveBeenLastCalledWith({x:-7,y:0,zoom:1});
  send("pointerup",860,220); expect(apply).toHaveBeenLastCalledWith([1,0,0,1,17,20]);
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
it("单击类工具（油漆桶/魔术橡皮）按下即提交一个事务，不进入拖动轨迹", () => {
  for (const tool of ["bucket", "magicEraser"] as const) {
    const start = vi.fn(), move = vi.fn(), finish = vi.fn();
    const { stage } = setup({ tool, onStrokeStart: start, onStrokeMove: move, onStroke: finish });
    const send = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
      Object.defineProperty(event, "pointerId", { value: 1 });
      act(() => stage.dispatchEvent(event));
    };
    send("pointerdown", 100, 100);
    expect(finish).toHaveBeenCalledOnce();
    expect(finish.mock.calls[0]![0]).toEqual([{ x: 136, y: 136 }]);
    send("pointermove", 200, 200); send("pointerup", 200, 200);
    expect(start).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  }
});

it("吸管不需要 Alt：按下与拖动持续取色，抬笔只多报一次且从不落笔", () => {
  const sample = vi.fn(), start = vi.fn(), finish = vi.fn();
  const { stage } = setup({ tool: "eyedropper", onSampleColor: sample, onStrokeStart: start, onStroke: finish });
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown", 100, 100);
  expect(sample).toHaveBeenLastCalledWith({ x: 136, y: 136 });
  send("pointermove", 140, 120);
  expect(sample).toHaveBeenLastCalledWith({ x: 216, y: 176 });
  const before = sample.mock.calls.length;
  send("pointerup", 140, 120);
  expect(sample).toHaveBeenCalledTimes(before + 1);
  expect(start).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});

it("真笔的倾斜/旋转随 coalesced 采样进入点位，鼠标保持短编码不补零姿态", () => {
  const start = vi.fn(), finish = vi.fn();
  const { stage, render } = setup({ tool: "brush", onStrokeStart: start, onStroke: finish });
  const pen = (type: string, x: number, pressure: number, tiltX: number, twist: number, samples?: PointerEvent[]) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: pressure },
      tiltX: { value: tiltX }, tiltY: { value: tiltX / 2 }, twist: { value: twist },
      ...(samples ? { getCoalescedEvents: { value: () => samples } } : {})
    });
    return event;
  };
  act(() => {
    stage.dispatchEvent(pen("pointerdown", 100, .5, 30, 45, [
      { clientX: 110, clientY: 100, pressure: .6, tiltX: 40, tiltY: 20, twist: 60 }
    ] as PointerEvent[]));
    stage.dispatchEvent(pen("pointerup", 100, 0, 0, 0));
  });
  expect(start).toHaveBeenCalledWith({ x: 136, y: 136, pressure: .5, tiltX: 30, tiltY: 15, rotation: 45 }, { shift: false });
  // 抬笔坐标与起点重合 → 不追加补点；已有点位保留真实姿态而不是抬笔的 0 值。
  expect(finish.mock.calls[0][0]).toEqual([{ x: 136, y: 136, pressure: .5, tiltX: 30, tiltY: 15, rotation: 45 }]);
  render({ tool: "brush", onStrokeStart: start, onStroke: finish });
  const mouse = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 2 });
    return event;
  };
  act(() => { stage.dispatchEvent(mouse("pointerdown", 100, 100)); stage.dispatchEvent(mouse("pointerup", 120, 100)); });
  expect(finish.mock.calls.at(-1)![0]).toEqual([{ x: 136, y: 136 }, { x: 176, y: 136 }]);
});

it("矢量工具把文档坐标交给域内归约器，不再落到平移或笔迹分支", () => {
  const onVectorPointer = vi.fn();
  const onStroke = vi.fn();
  const onPenPoint = vi.fn();
  const { stage, ref, changed } = setup({ tool: "shape-rect", onVectorPointer, onStroke, onPenPoint });
  const send = (type: string, x: number, y: number, extra: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, ...extra });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };

  const last = () => onVectorPointer.mock.calls.at(-1)!;
  send("pointerdown", 100, 100);
  expect(last()[0]).toMatchObject({ type: "down", point: [136, 136] });
  expect(ref.current!.hasGesture()).toBe(true);

  send("pointermove", 200, 150, { shiftKey: true });
  const move = onVectorPointer.mock.calls.at(-1)!;
  expect(move[0]).toMatchObject({ type: "move", shift: true });
  expect(move[0].point[0]).toBeCloseTo(336);
  expect(move[0].point[1]).toBeCloseTo(236);
  // 拖动期间**不**产生笔迹：矢量几何由归约器在松手时提交。
  expect(onStroke).not.toHaveBeenCalled();
  expect(onPenPoint).not.toHaveBeenCalled();

  send("pointerup", 200, 150);
  expect(last()[0].type).toBe("up");
  expect(last()[0].point[0]).toBeCloseTo(336);
  expect(last()[0].point[1]).toBeCloseTo(236);
  expect(ref.current!.hasGesture()).toBe(false);
  // 画布不自己平移：矢量工具拖动不是视图操作。
  expect(changed).not.toHaveBeenCalled();
  expect(onStroke).not.toHaveBeenCalled();
});

it("矢量工具取消手势通知归约器丢弃草稿，且不提交抬笔事件", () => {
  const onVectorPointer = vi.fn();
  const { stage, ref } = setup({ tool: "pen-freeform", onVectorPointer });
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown", 100, 100);
  act(() => { ref.current!.cancelGesture(); });
  expect(onVectorPointer.mock.calls.at(-1)![0]).toMatchObject({ type: "cancel" });
  const calls = onVectorPointer.mock.calls.length;
  send("pointerup", 120, 120);
  expect(onVectorPointer).toHaveBeenCalledTimes(calls);
});

it("矢量路径编辑的抬笔带双击标记，供归约器区分选择与平滑/尖角转换", () => {
  const onVectorPointer = vi.fn();
  const { stage } = setup({ tool: "direct-select", onVectorPointer });
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { button: 0, clientX: 100, clientY: 100, bubbles: true, detail: 2 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  }
  expect(onVectorPointer.mock.calls.at(-1)![0]).toMatchObject({ type: "up", doubleClick: true });
});

it("视图域的参考线拖动优先接管按下，取消不提交", () => {
  const down = vi.fn(() => true);
  const move = vi.fn();
  const up = vi.fn();
  const { stage } = setup({ tool: "brush", onGuideDown: down, onGuideMove: move, onGuideUp: up });

  // 按下：视图域先决定是否接管；接管后画布不当成笔迹。
  pointer(stage, "pointerdown");
  expect(down).toHaveBeenCalledWith([100, 100]);
  expect(stage.hasAttribute("data-view-guide-drag")).toBe(true);

  pointer(stage, "pointermove");
  expect(move).toHaveBeenCalledWith([100, 100]);

  pointer(stage, "pointerup");
  expect(up).toHaveBeenCalledWith([100, 100], false);
  expect(stage.hasAttribute("data-view-guide-drag")).toBe(false);
});

it("视图域不接管时画布行为与之前完全一致", () => {
  const down = vi.fn(() => false);
  const move = vi.fn();
  const up = vi.fn();
  const { stage, changed } = setup({ tool: "marquee", onGuideDown: down, onGuideMove: move, onGuideUp: up });

  pointer(stage, "pointerdown");
  expect(down).toHaveBeenCalledOnce();
  expect(stage.hasAttribute("data-view-guide-drag")).toBe(false);
  // 选框仍然正常开始拖动，端口没有被误触。
  pointer(stage, "pointermove");
  expect(move).not.toHaveBeenCalled();
  expect(up).not.toHaveBeenCalled();
  pointer(stage, "pointerup");
  expect(up).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("拖动中指针被取消时通知视图域丢弃草稿，不提交", () => {
  const down = vi.fn(() => true);
  const up = vi.fn();
  const { stage } = setup({ tool: "brush", onGuideDown: down, onGuideUp: up });
  pointer(stage, "pointerdown");
  pointer(stage, "pointercancel");
  expect(up).toHaveBeenCalledWith([0, 0], true);
  expect(stage.hasAttribute("data-view-guide-drag")).toBe(false);
});

it("拖动预览只画一条临时线，不改画布数据", () => {
  const { stage, container } = setup({ tool: "brush", guidePreview: { vertical: true, position: 200 } });
  const preview = container.querySelector('[data-guide-preview="vertical"]');
  expect(preview).not.toBeNull();
  expect(stage.getAttribute("data-canvas-viewport")).toBe("true");
});

it("落点请求优先于当前工具：一次点击即被消费，不落笔也不起选框", () => {
  const point = vi.fn((_point: { x: number; y: number }) => true);
  const stroke = vi.fn();
  const { stage, changed } = setup({ tool: "brush", onStroke: stroke, onViewPoint: point });

  pointer(stage, "pointerdown");
  pointer(stage, "pointerup");
  // 「点画布放一个标记」是明确的一次性意图，不应先落一笔。
  expect(point).toHaveBeenCalledOnce();
  expect(point.mock.calls[0][0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  expect(stroke).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("没有落点请求时画布行为完全不变", () => {
  const point = vi.fn((_point: { x: number; y: number }) => false);
  const stroke = vi.fn();
  const { stage } = setup({ tool: "brush", onStroke: stroke, onViewPoint: point });
  pointer(stage, "pointerdown");
  pointer(stage, "pointerup");
  expect(point).toHaveBeenCalledOnce();
  expect(stroke).toHaveBeenCalled();
});

it("Info 读数端口只转发客户坐标，离开画布时清空", () => {
  const onProbe = vi.fn();
  const { stage } = setup({ tool: "marquee", onProbe });
  const move = new MouseEvent("pointermove", { clientX: 321, clientY: 123, bubbles: true });
  Object.defineProperty(move, "pointerId", { value: 1 });
  act(() => stage.dispatchEvent(move));
  expect(onProbe).toHaveBeenLastCalledWith([321, 123]);
  // React 用 `pointerout` 合成 `pointerleave`（后者本身不冒泡），所以这里派发 out。
  act(() => stage.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
  // 离开必须是 null：面板据此显示「—」，不能继续显示上一个像素。
  expect(onProbe).toHaveBeenLastCalledWith(null);
});

it("画布上报真实取景（客户坐标原点 + 缩放），值不变不重复上报", () => {
  const onFrame = vi.fn();
  const { render } = setup({ tool: "marquee", onFrame });
  expect(onFrame).toHaveBeenCalled();
  const [origin, zoom] = onFrame.mock.calls.at(-1)!;
  // 864×514 的容器、1600×900 的文档、0.5 缩放 → 居中后的原点，加容器在页面里的位置。
  expect(zoom).toBe(0.5);
  expect(origin).toEqual({ x: (864 - 1600 * 0.5) / 2, y: (514 - 900 * 0.5) / 2 });
  onFrame.mockClear();
  // 重渲染但取景没变：不重复回调（避免每帧写内核）。
  render({ tool: "marquee", onFrame });
  expect(onFrame).not.toHaveBeenCalled();
});

it("缩放工具以点击点为锚，Alt 点击还原缩放且不产生选区", () => {
  const onSelectionClick = vi.fn();
  const { stage, changed } = setup({ tool: "zoom", onSelectionClick });
  pointer(stage, "pointerdown");
  expect(changed).toHaveBeenLastCalledWith({ zoom: .75, x: 166, y: 78.5 });
  const event = new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, altKey: true, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => stage.dispatchEvent(event));
  expect(changed).toHaveBeenLastCalledWith({ zoom: .5, x: 0, y: 0 });
  expect(onSelectionClick).not.toHaveBeenCalled();
});

it("裁剪工具拖框返回文档像素矩形，单击不清空已有选区", () => {
  const onMarquee = vi.fn(), onSelectionClick = vi.fn();
  const { stage, container } = setup({ tool: "crop", ellipse: true, onMarquee, onSelectionClick });
  pointer(stage, "pointerdown");
  pointer(stage, "pointerup");
  expect(onSelectionClick).not.toHaveBeenCalled();
  pointer(stage, "pointerdown");
  for (const type of ["pointermove", "pointerup"]) {
    const event = new MouseEvent(type, { button: 0, clientX: 200, clientY: 180, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
    if (type === "pointermove") expect(container.querySelector<HTMLElement>(".photo-editor-canvas__marquee")?.style.borderRadius).not.toBe("50%");
  }
  expect(onMarquee).toHaveBeenCalledWith({ x: 136, y: 136, width: 200, height: 160 }, "replace");
});
