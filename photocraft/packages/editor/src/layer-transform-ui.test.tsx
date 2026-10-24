import {StickyModifierContext,NO_STICKY_MODIFIERS,type StickyModifiers} from "./modifier-keys.js";
/** @vitest-environment jsdom */
// 只验证 DOM 事件与几何状态，不执行像素合成或截图。
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LayerTransformOverlay, TransformOptions, type TransformGesturePort } from "./layer-transform-ui.js";
import { IDENTITY_MATRIX, frameCenter, type TransformFrame } from "./transform-layer.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const frame: TransformFrame = [20,30,120,80];
function setup(initial = IDENTITY_MATRIX,sticky:StickyModifiers=NO_STICKY_MODIFIERS,initialLinked=true) {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const ref = createRef<TransformGesturePort>();
  const begin = vi.fn(() => true), preview = vi.fn(), apply = vi.fn(), cancel = vi.fn(), confirm = vi.fn(), valid = vi.fn(), gesture = vi.fn();
  function Harness() {
    const [matrix,setMatrix] = useState(initial), [reference,setReference] = useState(frameCenter(frame)), [linked,setLinked] = useState(initialLinked);
    const update = (next: number[]) => { preview(next); setMatrix(next); };
    return <StickyModifierContext.Provider value={sticky}><div><TransformOptions frame={frame} matrix={matrix} reference={reference} linked={linked} readonly={false}
      onReferenceChange={setReference} onLinkedChange={setLinked} onPreview={update} onConfirm={confirm} onCancel={cancel} onValidChange={valid} />
      <LayerTransformOverlay ref={ref} frame={frame} matrix={matrix} reference={reference} linked={linked} origin={{x:10,y:15}} zoom={2}
        onReferenceChange={setReference} onBegin={begin} onPreview={update} onApply={apply} onCancel={cancel} onGestureChange={gesture} /></div></StickyModifierContext.Provider>;
  }
  act(() => root.render(<Harness />));
  const overlay = container.querySelector<HTMLElement>(".photo-editor-transform")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  const send = (target: Element, type: string, x: number, y: number, modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type,{ button:0,clientX:x*2+10,clientY:y*2+15,bubbles:true,...modifiers });
    Object.defineProperty(event,"pointerId",{ value:1 }); act(() => target.dispatchEvent(event));
  };
  const handle = (name: string) => overlay.querySelector(`[data-transform-handle="${name}"]`)!;
  const change = (index: number, value: string) => {
    const input = container.querySelectorAll<HTMLInputElement>('input[data-numeric-input]')[index];
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value); input.dispatchEvent(new Event("input",{bubbles:true})); });
  };
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  return {container,ref,overlay,send,handle,change,button,begin,preview,apply,cancel,confirm,valid};
}
it("八个缩放手柄可见，拖动参考点不开始或提交内容，取消恢复参考点", () => {
  const {ref,overlay,send,handle,begin,preview,apply,cancel,button} = setup();
  expect(overlay.querySelectorAll('[data-transform-handle]')).toHaveLength(10);
  send(handle("reference"),"pointerdown",70,55);
  send(overlay,"pointermove",40,40); send(overlay,"pointerup",40,40);
  expect((handle("reference") as HTMLElement).style.left).toBe("35px");
  expect(begin).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  send(handle("reference"),"pointerdown",40,40); send(overlay,"pointermove",80,70);
  act(() => { expect(ref.current!.cancelGesture()).toBe(true); });
  send(overlay,"pointerup",80,70);
  expect((handle("reference") as HTMLElement).style.left).toBe("35px");
  expect(cancel).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  act(() => button("参考点居中").click());
  expect((handle("reference") as HTMLElement).style.left).toBe("95px");
});
it("边中点默认等比、Shift 单轴；Alt 围参考点，松手矩阵与实时预览一致", () => {
  const {overlay,send,handle,preview,apply,begin} = setup();
  send(handle("e"),"pointerdown",120,55);
  send(overlay,"pointermove",170,55,{shiftKey:true});
  expect(preview).toHaveBeenLastCalledWith([1.5,0,0,1,-10,0]);
  send(overlay,"pointerup",170,55,{shiftKey:true});
  expect(apply).toHaveBeenLastCalledWith([1.5,0,0,1,-10,0]); expect(begin).toHaveBeenCalledOnce();
  send(handle("s"),"pointerdown",70,80); send(overlay,"pointerup",70,105,{altKey:true});
  const next = apply.mock.calls.at(-1)![0];
  expect(next[0]).toBeCloseTo(3); expect(next[3]).toBeCloseTo(2);
  expect(next[0]*70+next[4]).toBeCloseTo(95); expect(next[3]*55+next[5]).toBeCloseTo(55);
});
it("比例链接同时更新宽高，解除链接可单轴输入；非法值禁用确认", () => {
  const {container,change,preview,valid,button} = setup();
  change(2,"150"); expect(preview).toHaveBeenLastCalledWith([1.5,0,0,1.5,-35,-27.5]);
  expect(container.querySelectorAll<HTMLInputElement>('input[data-numeric-input]')[3].value).toBe("150");
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  change(3,"200"); expect(preview.mock.calls.at(-1)![0][0]).toBe(1.5); expect(preview.mock.calls.at(-1)![0][3]).toBe(2);
  change(3,""); expect(valid).toHaveBeenLastCalledWith(false); expect(button("确认变换").disabled).toBe(true);
  change(3,"100"); expect(valid).toHaveBeenLastCalledWith(true); expect(button("确认变换").disabled).toBe(false);
});
it("链接后超出另一轴上限不能确认旧矩阵", () => {
  const {change,preview,valid,button} = setup([1,0,0,16,0,0]);
  change(2,"200"); expect(preview).not.toHaveBeenCalled(); expect(valid).toHaveBeenLastCalledWith(false);
  expect(button("确认变换").disabled).toBe(true);
});

it("位移算式在Enter时先刷新矩阵再确认，除零不允许确认旧候选",()=>{
 const h=setup();const input=h.container.querySelector<HTMLInputElement>('input[data-numeric-input]')!;
 h.change(0,"(20+10)*2");expect(h.button("确认变换").disabled).toBe(true);
 act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));expect(h.preview.mock.lastCall?.[0][4]).toBe(60);expect(h.confirm).toHaveBeenCalledOnce();
 h.change(0,"1/0");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));expect(h.confirm).toHaveBeenCalledOnce();expect(h.button("确认变换").disabled).toBe(true);
});

it("锁存Shift与Alt在变换柄中约束比例并围绕中心，释放提交最终坐标",()=>{
 const {handle,overlay,send,apply}=setup(IDENTITY_MATRIX,{shift:true,command:false,alt:true},false);
 send(handle("se"),"pointerdown",120,80);send(overlay,"pointermove",130,81);send(overlay,"pointerup",140,81);
 const matrix=apply.mock.lastCall![0] as number[];expect(matrix[0]).toBeCloseTo(1.4);expect(matrix[3]).toBeCloseTo(1.4);expect(matrix[4]).toBeCloseTo(-28);expect(matrix[5]).toBeCloseTo(-22);expect(apply).toHaveBeenCalledOnce();
});
