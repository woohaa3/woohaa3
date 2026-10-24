/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {publishNotifications} from "@woohaa3/photocraft-editor";
import {WorkspaceNotification,type WorkspaceNotice} from "../src/workspace-notification.js";
import {DocumentWorkspaceStore} from "../src/workspace-store.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined;
afterEach(()=>{act(()=>root?.unmount());root=undefined;localStorage.clear();vi.useRealTimers();vi.restoreAllMocks();});
function setup(){
 vi.useFakeTimers();const node=document.createElement("div"),dismiss=vi.fn();root=createRoot(node);
 const render=(notice:WorkspaceNotice)=>act(()=>root!.render(<WorkspaceNotification notice={notice} onDismiss={dismiss}/>));
 const advance=(ms:number)=>act(()=>vi.advanceTimersByTime(ms));return {node,dismiss,render,advance};
}
it("默认6秒，悬停暂停且离开重计，手动关闭只处理该条一次",()=>{
 const h=setup(),notice={message:"Saved",tone:"info" as const};h.render(notice);h.advance(5000);expect(h.dismiss).not.toHaveBeenCalled();
 const box=h.node.querySelector("[data-workspace-notification]")!;
 act(()=>box.dispatchEvent(new MouseEvent("pointerover",{bubbles:true})));h.advance(9000);expect(h.dismiss).not.toHaveBeenCalled();
 act(()=>box.dispatchEvent(new MouseEvent("pointerout",{bubbles:true})));h.advance(5999);expect(h.dismiss).not.toHaveBeenCalled();h.advance(1);expect(h.dismiss).toHaveBeenCalledOnce();expect(h.dismiss).toHaveBeenLastCalledWith(notice);expect(h.node.textContent).toBe("");
 const next={message:"Failed",tone:"error" as const};h.render(next);act(()=>h.node.querySelector("button")!.click());h.advance(20000);expect(h.dismiss.mock.calls).toEqual([[notice],[next]]);
});
it("新通知替换取消旧计时，同文案新事件重新计时；存储/本窗口偏好即刻生效",()=>{
 const h=setup(),first={message:"Done",tone:"info" as const},second={...first};h.render(first);h.advance(5000);h.render(second);h.advance(1000);expect(h.dismiss).not.toHaveBeenCalled();
 act(()=>publishNotifications({autoHide:false,seconds:1}));h.advance(120000);expect(h.dismiss).not.toHaveBeenCalled();
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({notifications:{autoHide:true,seconds:2}}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:"photocraft.editor-preferences.v1"})));h.advance(1999);expect(h.dismiss).not.toHaveBeenCalled();h.advance(1);expect(h.dismiss).toHaveBeenCalledOnce();expect(h.dismiss).toHaveBeenLastCalledWith(second);
 const store=new DocumentWorkspaceStore(),change=vi.fn();store.subscribe(change);store.setNotice(first);store.setNotice(first);expect(change).toHaveBeenCalledOnce();store.setNotice(second);expect(change).toHaveBeenCalledTimes(2);expect(store.getSnapshot().notice).toBe(second);
});
it("卸载取消计时；已取消/旧事件回调即使迟到也不发布",()=>{
 const h=setup(),first={message:"Old",tone:"info" as const},second={message:"New",tone:"info" as const};const timer=vi.spyOn(globalThis,"setTimeout");h.render(first);const stale=timer.mock.calls.at(-1)![0] as ()=>void;h.render(second);act(()=>stale());expect(h.dismiss).not.toHaveBeenCalled();act(()=>root!.unmount());root=undefined;h.advance(10000);expect(h.dismiss).not.toHaveBeenCalled();
});
