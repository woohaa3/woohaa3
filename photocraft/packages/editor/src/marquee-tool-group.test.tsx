/** @vitest-environment jsdom */
// 验证指针时序、选择和弹层状态；不创建渲染上下文或截图。
import {act,useState,type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {MarqueeToolGroup} from "./marquee-tool-group.js";
vi.mock("./ui/Popover.js",()=>({Popover:({open,children,onOpenChange}:{open:boolean;children:ReactNode;onOpenChange:(open:boolean)=>void})=>
  open?<div data-group-menu onKeyDown={event=>{if(event.key==="Escape") {event.stopPropagation();onOpenChange(false);}}}>{children}</div>:null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("短按选择记忆子工具，长按/右键展开；取消、只读、隐藏和卸载清理计时器",()=>{
  vi.useFakeTimers();const chosen=vi.fn();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  function Harness({disabled=false,hidden=false}:{disabled?:boolean;hidden?:boolean}) {
    const [ellipse,setEllipse]=useState(false);
    return <MarqueeToolGroup active ellipse={ellipse} disabled={disabled} hidden={hidden} onChoose={value=>{setEllipse(value);chosen(value);}}/>;
  }
  const render=(disabled=false,hidden=false)=>act(()=>root.render(<Harness disabled={disabled} hidden={hidden}/>));
  const pointer=(type:string,button=0)=>{const event=new Event(type==="pointerleave"?"pointerout":type,{bubbles:true,cancelable:true});Object.defineProperty(event,"button",{value:button});act(()=>container.querySelector("button")!.dispatchEvent(event));};
  try {
    render();pointer("pointerdown");act(()=>vi.advanceTimersByTime(349));pointer("pointerup");
    act(()=>container.querySelector<HTMLButtonElement>("button")!.click());
    expect(chosen.mock.calls).toEqual([[false]]);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer("pointerdown");act(()=>vi.advanceTimersByTime(350));
    expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    pointer("pointerup");act(()=>container.querySelector<HTMLButtonElement>("button")!.click());
    expect(chosen).toHaveBeenCalledTimes(1);
    act(()=>Array.from(container.querySelectorAll<HTMLButtonElement>("[data-group-menu] button")).find(button=>button.textContent?.includes("椭圆"))!.click());
    expect(chosen).toHaveBeenLastCalledWith(true);expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("椭圆选框");
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
    act(()=>root.render(<MarqueeToolGroup active ellipse={false} disabled={false} onChoose={chosen}/>));
    const trigger=container.querySelector("button")!;
    pointer(trigger,"pointerdown");pointer(trigger,"pointerout");
    const ellipse=container.querySelector('[data-marquee-kind="ellipse"]')!;
    expect(ellipse).not.toBeNull();pointer(ellipse,"pointerup");
    expect(chosen.mock.calls).toEqual([[true]]);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer(trigger,"pointerdown");pointer(trigger,"pointerout");pointer(document.body,"pointerup");
    expect(chosen).toHaveBeenCalledTimes(1);expect(container.querySelector("[data-group-menu]")).toBeNull();
    pointer(trigger,"contextmenu");expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    pointer(trigger,"contextmenu");expect(container.querySelector("[data-group-menu]")).toBeNull();
  } finally {act(()=>root.unmount());container.remove();}
});

it("右键子工具菜单包含单行/单列，选择记忆当前线形且不误变成椭圆",()=>{
  const chosen=vi.fn(),container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    act(()=>root.render(<MarqueeToolGroup active ellipse={false} line="row" disabled={false} onChoose={chosen}/>));
    const trigger=container.querySelector("button")!;act(()=>trigger.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true})));
    expect(container.querySelector('[data-marquee-kind="row"]')?.getAttribute("data-selected")).toBe("true");
    act(()=>container.querySelector<HTMLButtonElement>('[data-marquee-kind="column"]')!.click());
    expect(chosen.mock.calls).toEqual([[false,"column"]]);
    act(()=>trigger.click());expect(chosen.mock.lastCall).toEqual([false,"row"]);
  } finally {act(()=>root.unmount());container.remove();}
});
