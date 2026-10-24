/** @vitest-environment jsdom */
import {act,useState} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";import {PaintNumberField} from "./paint-number-field.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("绘画数值悬停/聚焦滚轮按1或Shift10步进，修饰键和其它编辑器保留给画布",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),change=vi.fn();function Probe(){const [value,setValue]=useState(50);return <><div className="photo-editor"><PaintNumberField label="平滑" value={value} min={0} max={100} disabled={false} onChange={next=>{change(next);setValue(next);}}/><div className="photo-editor-canvas"/></div><div className="photo-editor"><div className="photo-editor-canvas"/></div></>;}
 try{act(()=>root.render(<Probe/>));const input=host.querySelector("input")!,label=host.querySelector("label")!,canvas=host.querySelectorAll(".photo-editor-canvas");
 const wheel=(target:Element,init:WheelEventInit)=>{const event=new WheelEvent("wheel",{deltaY:-1,bubbles:true,cancelable:true,...init});act(()=>target.dispatchEvent(event));return event;};
 expect(wheel(label,{}).defaultPrevented).toBe(true);expect(input.value).toBe("51");wheel(input,{shiftKey:true});expect(input.value).toBe("61");act(()=>input.focus());wheel(canvas[0],{deltaY:1});expect(input.value).toBe("60");
 const count=change.mock.calls.length;for(const init of [{altKey:true},{ctrlKey:true},{metaKey:true}])expect(wheel(input,init).defaultPrevented).toBe(false);expect(wheel(canvas[1],{}).defaultPrevented).toBe(false);expect(change).toHaveBeenCalledTimes(count);
 }finally{act(()=>root.unmount());host.remove();}
});
it("标签与尺寸文本拖动消费释放坐标，Shift/Alt倍率和取消恢复；禁用不改值",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),change=vi.fn();function Probe({disabled=false}:{disabled?:boolean}){const [value,setValue]=useState(40);return <PaintNumberField label="尺寸" value={value} min={1} max={512} inputScrub disabled={disabled} onChange={next=>{change(next);setValue(next);}}/>;}
 try{act(()=>root.render(<Probe/>));const input=host.querySelector("input")!,scrub=host.querySelector("span")!;
 const send=(target:HTMLElement,type:string,x:number,init:MouseEventInit={})=>{target.setPointerCapture=vi.fn();target.hasPointerCapture=()=>true;target.releasePointerCapture=vi.fn();const event=new MouseEvent(type,{button:0,clientX:x,bubbles:true,cancelable:true,...init});Object.defineProperty(event,"pointerId",{value:1});act(()=>target.dispatchEvent(event));};
 send(scrub,"pointerdown",0);send(scrub,"pointermove",3,{shiftKey:true});send(scrub,"pointerup",5,{altKey:true});expect(Number(input.value)).toBeCloseTo(70.2);
 send(input,"pointerdown",0);send(input,"pointermove",10);send(input,"pointercancel",10);expect(Number(input.value)).toBeCloseTo(70.2);
 send(input,"pointerdown",0);send(input,"pointermove",10);act(()=>window.dispatchEvent(new Event("blur")));expect(Number(input.value)).toBeCloseTo(70.2);
 act(()=>root.render(<Probe disabled/>));const count=change.mock.calls.length;send(scrub,"pointerdown",0);send(scrub,"pointermove",10);expect(change).toHaveBeenCalledTimes(count);expect(input.disabled).toBe(true);
 }finally{act(()=>root.unmount());host.remove();}
});
