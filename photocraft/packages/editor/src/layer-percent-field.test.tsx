/** @vitest-environment jsdom */
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {LayerPercentField} from "./layer-percent-field.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock("./ui/Popover.js",()=>({Popover:({open,children}:{open:boolean;children:import("react").ReactNode})=>open?<div>{children}</div>:null}));
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();vi.useRealTimers();});
it("标题拖动、细调、滑块和滚轮共用候选；释放确认，取消/失焦/只读不确认",()=>{
  vi.useFakeTimers();const update=vi.fn(),finish=vi.fn(()=>true);
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);
  function Harness({disabled=false}:{disabled?:boolean}) {const [value,setValue]=useState("50");return <LayerPercentField label="不透明度" value={value} disabled={disabled} update={next=>{update(next);setValue(next);}} finish={finish}/>;}
  const render=(disabled=false)=>act(()=>root.render(<Harness disabled={disabled}/>));render();
  const scrub=node.querySelector(".photo-editor__percent-scrub")!,input=node.querySelector<HTMLInputElement>('input[data-numeric-input]')!;
  act(()=>node.querySelector<HTMLButtonElement>("button")!.click());const slider=node.querySelector<HTMLInputElement>('input[type="range"]')!;
  const pointer=(target:Element,type:string,x=0,altKey=false)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,altKey});Object.defineProperty(event,"pointerId",{value:1});act(()=>target.dispatchEvent(event));};
  pointer(scrub,"pointerdown",10);pointer(scrub,"pointermove",11);expect(update).not.toHaveBeenCalled();
  pointer(scrub,"pointermove",20);expect(input.value).toBe("60");pointer(scrub,"pointerup",20);expect(finish.mock.calls).toEqual([[true]]);
  pointer(scrub,"pointerdown",20);pointer(scrub,"pointermove",40,true);expect(input.value).toBe("62");pointer(scrub,"pointercancel");expect(finish.mock.lastCall).toEqual([false]);
  pointer(slider,"pointerdown");pointer(slider,"pointerup");expect(finish.mock.lastCall).toEqual([true]);
  act(()=>input.focus());act(()=>input.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-1})));expect(input.value).toBe("63");
  const calls=finish.mock.calls.length;act(()=>vi.advanceTimersByTime(179));expect(finish).toHaveBeenCalledTimes(calls);
  act(()=>vi.advanceTimersByTime(1));expect(finish.mock.lastCall).toEqual([true]);
  pointer(scrub,"pointerdown");pointer(scrub,"pointermove",5);act(()=>window.dispatchEvent(new Event("blur")));expect(finish.mock.lastCall).toEqual([false]);
  pointer(scrub,"pointerdown");pointer(scrub,"pointermove",5);render(true);expect(finish.mock.lastCall).toEqual([false]);expect(input.disabled).toBe(true);
  const before=update.mock.calls.length;pointer(scrub,"pointerdown");pointer(scrub,"pointermove",100);expect(update).toHaveBeenCalledTimes(before);
});

it("聚焦数字时只接管同一编辑器画布的普通滚轮，保留缩放修饰键和其他编辑器",()=>{
  vi.useFakeTimers();const update=vi.fn(),finish=vi.fn(()=>true);
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);
  act(()=>root.render(<><div className="photo-editor"><LayerPercentField label="填充" value="50" disabled={false} update={update} finish={finish}/><div className="photo-editor-canvas" data-local="true"/></div><div className="photo-editor"><div className="photo-editor-canvas" data-foreign="true"/></div></>));
  const input=node.querySelector<HTMLInputElement>('input[data-numeric-input]')!,canvas=node.querySelector('[data-local]')!,foreign=node.querySelector('[data-foreign]')!;
  const wheel=(target:Element,options:WheelEventInit={})=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:-1,...options});act(()=>target.dispatchEvent(event));return event;};
  expect(wheel(canvas).defaultPrevented).toBe(false);expect(update).not.toHaveBeenCalled();
  act(()=>input.focus());expect(wheel(canvas).defaultPrevented).toBe(true);expect(update.mock.lastCall).toEqual(["51"]);
  expect(wheel(canvas,{shiftKey:true}).defaultPrevented).toBe(true);expect(update.mock.lastCall).toEqual(["61"]);
  const count=update.mock.calls.length;
  for(const modifier of [{ctrlKey:true},{metaKey:true},{altKey:true}]) expect(wheel(canvas,modifier).defaultPrevented).toBe(false);
  expect(wheel(foreign).defaultPrevented).toBe(false);expect(update).toHaveBeenCalledTimes(count);
  act(()=>vi.advanceTimersByTime(180));expect(finish.mock.calls).toEqual([[true]]);
});

it("数字字段短按保留键入，拖动才调值；弹出滑块取消关闭且无旧提交",()=>{
  const update=vi.fn(),finish=vi.fn(()=>true),node=document.createElement("div");document.body.append(node);root=createRoot(node);
  act(()=>root.render(<LayerPercentField label="填充" value="50" disabled={false} update={update} finish={finish}/>));
  const input=node.querySelector<HTMLInputElement>('input[data-numeric-input]')!;
  const pointer=(type:string,x:number)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x});Object.defineProperty(event,"pointerId",{value:1});act(()=>input.dispatchEvent(event));};
  pointer("pointerdown",20);pointer("pointerup",20);expect(update).not.toHaveBeenCalled();
  pointer("pointerdown",20);pointer("pointermove",30);expect(update.mock.lastCall).toEqual(["60"]);pointer("pointercancel",30);expect(finish.mock.lastCall).toEqual([false]);
  expect(node.querySelector('input[type="range"]')).toBeNull();act(()=>node.querySelector<HTMLButtonElement>("button")!.click());expect(node.querySelector('input[type="range"]')).not.toBeNull();
  act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"Escape"})));expect(node.querySelector('input[type="range"]')).toBeNull();expect(finish.mock.lastCall).toEqual([false]);
});
