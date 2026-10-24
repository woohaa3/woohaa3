/** @vitest-environment jsdom */
import {act,type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {ScreenModeButton} from "./screen-mode-button.js";
vi.mock("./ui/Popover.js",()=>({Popover:({open,children}:{open:boolean;children:ReactNode})=>open?<div data-modes>{children}</div>:null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("点按循环，350ms长按和右键列表选择；释放不再次循环，取消/隐藏清计时",()=>{
  vi.useFakeTimers();const change=vi.fn(),container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const render=(disabled=false,hidden=false)=>act(()=>root.render(<ScreenModeButton mode="standard" disabled={disabled} hidden={hidden} onChange={change}/>));
  const pointer=(type:string,target:Element=container.querySelector("button")!)=>{const event=new MouseEvent(type,{button:0,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:7});act(()=>target.dispatchEvent(event));};
  try{
    render();pointer("pointerdown");act(()=>vi.advanceTimersByTime(349));pointer("pointerup");act(()=>container.querySelector<HTMLButtonElement>("button")!.click());expect(change.mock.calls).toEqual([["fullScreenWithMenuBar"]]);
    pointer("pointerdown");act(()=>vi.advanceTimersByTime(350));expect(container.querySelector("[data-modes]")).not.toBeNull();pointer("pointerup");act(()=>container.querySelector<HTMLButtonElement>("button")!.click());expect(change).toHaveBeenCalledTimes(1);expect(container.querySelector("[data-modes]")).not.toBeNull();
    act(()=>Array.from(container.querySelectorAll<HTMLButtonElement>("[data-modes] button")).find(button=>button.textContent==="全屏模式")!.click());expect(change).toHaveBeenLastCalledWith("fullScreen");expect(container.querySelector("[data-modes]")).toBeNull();
    pointer("contextmenu");expect(container.querySelector("[data-modes]")).not.toBeNull();render(true);expect(container.querySelector("[data-modes]")).toBeNull();
    render();pointer("pointerdown");pointer("pointercancel");act(()=>vi.advanceTimersByTime(400));expect(container.querySelector("[data-modes]")).toBeNull();
    pointer("pointerdown");render(false,true);act(()=>vi.advanceTimersByTime(400));expect(vi.getTimerCount()).toBe(0);
    render();pointer("pointerdown");pointer("pointerup",document.body);act(()=>vi.advanceTimersByTime(400));expect(container.querySelector("[data-modes]")).toBeNull();
    pointer("pointerdown");act(()=>root.unmount());expect(vi.getTimerCount()).toBe(0);
  }finally{act(()=>root.unmount());container.remove();vi.useRealTimers();}
});
