/** @vitest-environment jsdom */
import {act,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {LayerBlendField} from "./layer-blend-field.js";
vi.mock("./ui/Popover.js",()=>({Popover:({open,children}:{open:boolean;children:ReactNode})=>open?<div>{children}</div>:null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
it("按下即开、悬停预览、离开恢复，拖动释放一次确认；失焦/取消/禁用无写",()=>{
  const preview=vi.fn(()=>true),finish=vi.fn((_commit:boolean)=>true),node=document.createElement("div");document.body.append(node);root=createRoot(node);
  const render=(disabled=false)=>act(()=>root.render(<LayerBlendField value="Normal" options={["Normal","Multiply","Screen"]} disabled={disabled} editing={{active:false,preview,finish}}/>));render();
  const trigger=()=>node.querySelector("button")!,item=(mode:string)=>node.querySelector(`[data-blend-option="${mode}"]`)!;
  const pointer=(target:Element,type:string)=>act(()=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0})));
  pointer(trigger(),"pointerdown");expect(item("Multiply")).not.toBeNull();pointer(item("Multiply"),"pointerover");expect(preview.mock.lastCall).toEqual(["Multiply"]);expect(finish.mock.calls.filter(([commit])=>commit===true)).toHaveLength(0);
  pointer(item("Multiply"),"pointerup");expect(finish.mock.lastCall).toEqual([true]);expect(node.querySelector('[data-blend-option]')).toBeNull();
  pointer(trigger(),"pointerdown");pointer(item("Screen"),"pointerover");act(()=>window.dispatchEvent(new Event("blur")));expect(finish.mock.lastCall).toEqual([false]);expect(node.querySelector('[data-blend-option]')).toBeNull();
  pointer(trigger(),"pointerdown");pointer(item("Screen"),"pointerover");render(true);expect(finish.mock.lastCall).toEqual([false]);expect(node.querySelector('[data-blend-option]')).toBeNull();
});
it("滚轮每格独立确认、不滚动列表，边界不回绕，失败不关闭候选；Ctrl滚轮保留",()=>{
  const preview=vi.fn(()=>true),finish=vi.fn((_commit:boolean)=>true),node=document.createElement("div");document.body.append(node);root=createRoot(node);
  act(()=>root.render(<LayerBlendField value="Normal" options={["Normal","Multiply","Screen"]} disabled={false} editing={{active:false,preview,finish}}/>));
  const trigger=node.querySelector("button")!;const wheel=(deltaY:number,ctrlKey=false)=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY,ctrlKey});act(()=>trigger.dispatchEvent(event));return event;};
  expect(wheel(-100).defaultPrevented).toBe(true);expect(preview).not.toHaveBeenCalled();
  wheel(100);expect(preview.mock.lastCall).toEqual(["Multiply"]);expect(finish.mock.lastCall).toEqual([true]);wheel(100);expect(preview.mock.lastCall).toEqual(["Screen"]);
  const count=preview.mock.calls.length;wheel(100);expect(preview).toHaveBeenCalledTimes(count);expect(wheel(-100,true).defaultPrevented).toBe(false);
  act(()=>trigger.click());preview.mockReturnValue(false);act(()=>node.querySelector<HTMLButtonElement>('[data-blend-option="Multiply"]')!.click());expect(node.querySelector('[data-blend-option]')).not.toBeNull();
});
