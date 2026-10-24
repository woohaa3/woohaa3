/** @vitest-environment jsdom */
// 验证指针时序、选择和弹层状态；不创建渲染上下文或截图。
import {act,useState,type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {TextToolGroup} from "./text-tool-group.js";
vi.mock("./ui/Popover.js",()=>({Popover:({open,children,onOpenChange}:{open:boolean;children:ReactNode;onOpenChange:(open:boolean)=>void})=>
  open?<div data-group-menu onKeyDown={event=>{if(event.key==="Escape") {event.stopPropagation();onOpenChange(false);}}}>{children}</div>:null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("短按选择记忆子工具，长按/右键展开；取消、只读、隐藏和卸载清理计时器",()=>{
  vi.useFakeTimers();const chosen=vi.fn();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  function Harness({disabled=false,hidden=false}:{disabled?:boolean;hidden?:boolean}) {
    const [orientation,setOrientation]=useState<"horizontal"|"vertical">("horizontal");
    return <TextToolGroup active orientation={orientation} disabled={disabled} hidden={hidden} onChoose={value=>{setOrientation(value);chosen(value);}}/>;
  }
  const render=(disabled=false,hidden=false)=>act(()=>root.render(<Harness disabled={disabled} hidden={hidden}/>));
  const pointer=(type:string,button=0)=>{const event=new Event(type==="pointerleave"?"pointerout":type,{bubbles:true,cancelable:true});Object.defineProperty(event,"button",{value:button});act(()=>container.querySelector("button")!.dispatchEvent(event));};
  try {
    render();pointer("pointerdown");act(()=>vi.advanceTimersByTime(349));pointer("pointerup");
    act(()=>container.querySelector<HTMLButtonElement>("button")!.click());
    expect(chosen.mock.calls).toEqual([["horizontal"]]);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer("pointerdown");act(()=>vi.advanceTimersByTime(350));
    expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    pointer("pointerup");act(()=>container.querySelector<HTMLButtonElement>("button")!.click());
    expect(chosen).toHaveBeenCalledTimes(1);
    act(()=>Array.from(container.querySelectorAll<HTMLButtonElement>("[data-group-menu] button")).find(button=>button.textContent?.includes("竖排"))!.click());
    expect(chosen).toHaveBeenLastCalledWith("vertical");expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("竖排文字");
    expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer("contextmenu",2);expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    act(()=>container.querySelector("[data-group-menu]")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(container.querySelector("[data-group-menu]")).toBeNull();
    for(const cancel of ["pointercancel"]) {
      pointer("pointerdown");pointer(cancel);act(()=>vi.advanceTimersByTime(400));
      expect(container.querySelector("[data-group-menu]")).toBeNull();
    }
    pointer("pointerdown");render(true);act(()=>vi.advanceTimersByTime(400));expect(container.querySelector("[data-group-menu]")).toBeNull();
    render();pointer("pointerdown");render(false,true);act(()=>vi.advanceTimersByTime(400));expect(container.querySelector("[data-group-menu]")).toBeNull();
    render();pointer("pointerdown");act(()=>root.unmount());act(()=>vi.advanceTimersByTime(400));expect(vi.getTimerCount()).toBe(0);
  } finally {act(()=>root.unmount());container.remove();vi.useRealTimers();}
});

it("按下拖出立即展开，释放在子工具上直接选择；外部释放取消，重复右键关闭",()=>{
  const chosen=vi.fn(),container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const pointer=(target:Element,type:string)=>act(()=>target.dispatchEvent(new MouseEvent(type,{button:0,bubbles:true,cancelable:true})));
  try {
    act(()=>root.render(<TextToolGroup active orientation="horizontal" disabled={false} onChoose={chosen}/>));
    const trigger=container.querySelector("button")!;
    pointer(trigger,"pointerdown");pointer(trigger,"pointerout");
    const ellipse=container.querySelector('[data-text-orientation="vertical"]')!;
    expect(ellipse).not.toBeNull();pointer(ellipse,"pointerup");
    expect(chosen.mock.calls).toEqual([["vertical"]]);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer(trigger,"pointerdown");pointer(trigger,"pointerout");pointer(document.body,"pointerup");
    expect(chosen).toHaveBeenCalledTimes(1);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer(trigger,"contextmenu");expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    pointer(trigger,"contextmenu");expect(container.querySelector("[data-group-menu]")).toBeNull();
  } finally {act(()=>root.unmount());container.remove();}
});


it("其它指针不接管长按，失焦后不选择，跨编辑器子工具不被误选",()=>{
 vi.useFakeTimers();const chosen=vi.fn(),node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const pointer=(target:Element,type:string,id:number)=>{const event=new MouseEvent(type,{button:0,bubbles:true});Object.defineProperty(event,"pointerId",{value:id});act(()=>target.dispatchEvent(event));};
 try{
  act(()=>root.render(<><TextToolGroup active disabled={false} onChoose={chosen}/><TextToolGroup active disabled={false} onChoose={()=>{}}/></>));
  const triggers=node.querySelectorAll("button");pointer(triggers[0],"pointerdown",1);pointer(triggers[0],"pointerdown",2);pointer(triggers[0],"pointerup",2);act(()=>vi.advanceTimersByTime(350));
  expect(node.querySelector('[data-group-menu]')).not.toBeNull();act(()=>window.dispatchEvent(new Event("blur")));expect(node.querySelector('[data-group-menu]')).toBeNull();
  pointer(triggers[1],"contextmenu",2);const other=node.querySelector('[data-text-orientation="vertical"]')!;
  pointer(triggers[0],"pointerdown",1);pointer(triggers[0],"pointerout",1);pointer(other,"pointerup",1);expect(chosen).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());node.remove();vi.useRealTimers();}
});
