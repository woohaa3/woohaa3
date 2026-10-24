/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {HistorySnapshots} from "./history-snapshots.js";
import {UiProvider} from "./ui/UiProvider.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
function setup(){
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),run=vi.fn(()=>true);
 const commands=new Map(["newSnapshot","selectSnapshot","renameSnapshot","deleteSnapshot"].map(id=>[`history.${id}`,{allowed:true,enabled:true} as PhotocraftCommand]));
 const render=(key="doc",disabled=false,snapshots=[{id:7,name:"Before"}])=>act(()=>root.render(<UiProvider><HistorySnapshots key={key} snapshots={snapshots} commands={commands} disabled={disabled} onCommand={run}/></UiProvider>));
 const source=()=>host.querySelector<HTMLButtonElement>(".photo-editor__snapshot-name")!;
 const trash=()=>host.querySelector<HTMLElement>("[data-snapshot-trash]")!;
 const dispose=()=>{act(()=>root.unmount());host.remove();};render();return {host,run,commands,render,source,trash,dispose};
}
function transfer(){const data=new Map<string,string>();return {effectAllowed:"none",dropEffect:"none",setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type)??""};}
function dragEvent(target:Element,type:string,dataTransfer:ReturnType<typeof transfer>){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:dataTransfer});act(()=>target.dispatchEvent(event));return event;}
it("双击和右键重命名复用名称草稿；右键删除只分派一次",()=>{
 const s=setup();const context=()=>act(()=>s.source().dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:20,clientY:30})));
 const item=(text:string)=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===text)!;
 try{
  act(()=>s.source().dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));expect(s.host.querySelector("input")!.value).toBe("Before");expect(s.run).not.toHaveBeenCalled();
  act(()=>s.host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  context();expect(item("重命名快照…")).toBeDefined();act(()=>item("重命名快照…").click());expect(s.host.querySelector("input")!.value).toBe("Before");
  act(()=>s.host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  context();act(()=>item("删除快照").click());expect(s.run.mock.calls).toEqual([["history.deleteSnapshot",{snapshot:7}]]);
  s.render("doc",true);context();expect(item("删除快照")).toBeUndefined();
 }finally{s.dispose();}
});
it("仅接受当前文档本次拖动的快照；取消、外部、跨文档、消失或禁用不删除",()=>{
 const s=setup();
 try{
  const data=transfer();dragEvent(s.source(),"dragstart",data);expect(data.effectAllowed).toBe("move");expect(dragEvent(s.trash(),"dragover",data).defaultPrevented).toBe(true);expect(s.trash().dataset.over).toBe("true");dragEvent(s.trash(),"drop",data);expect(s.run.mock.calls).toEqual([["history.deleteSnapshot",{snapshot:7}]]);
  s.run.mockClear();dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
  dragEvent(s.source(),"dragstart",data);dragEvent(s.source(),"dragend",data);dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
  dragEvent(s.source(),"dragstart",data);dragEvent(s.trash(),"drop",transfer());expect(s.run).not.toHaveBeenCalled();
  dragEvent(s.source(),"dragstart",data);s.render("other");dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
  dragEvent(s.source(),"dragstart",data);s.render("other",false,[]);dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
  s.render("other");dragEvent(s.source(),"dragstart",data);s.render("other",true);expect(dragEvent(s.trash(),"dragover",data).defaultPrevented).toBe(false);dragEvent(s.trash(),"drop",data);s.render("other");dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
  s.commands.set("history.deleteSnapshot",{allowed:true,enabled:false} as PhotocraftCommand);s.render("other");expect(s.source().draggable).toBe(false);expect(dragEvent(s.source(),"dragstart",data).defaultPrevented).toBe(true);dragEvent(s.trash(),"drop",data);expect(s.run).not.toHaveBeenCalled();
 }finally{s.dispose();}
});
