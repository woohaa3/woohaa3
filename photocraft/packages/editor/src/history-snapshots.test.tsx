/** @vitest-environment jsdom */
import {act,type ReactNode} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";
import {HistorySnapshots} from "./history-snapshots.js";import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
vi.mock("./ui/Menu.js",()=>({DropdownMenu:({items,trigger}:{trigger:ReactNode;items:import("./ui/Menu.js").MenuItem[]})=><>{trigger}{items.map(item=><button key={item.id} data-create={item.id} disabled={item.disabled} onClick={()=>item.onSelect(item.id)}>{item.label}</button>)}</>}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("快照三种来源、选择、严格名称确认和删除走单个命令；Escape不分派",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),run=vi.fn(()=>true),commands=new Map(["newSnapshot","selectSnapshot","renameSnapshot","deleteSnapshot"].map(id=>[`history.${id}`,{allowed:true,enabled:true} as PhotocraftCommand]));
 try{act(()=>root.render(<HistorySnapshots snapshots={[{id:7,name:"Before"}]} commands={commands} disabled={false} onCommand={run}/>));
 for(const from of ["fullDocument","mergedLayers","currentLayer"]){act(()=>host.querySelector<HTMLButtonElement>(`[data-create="${from}"]`)!.click());expect(run.mock.lastCall).toEqual(["history.newSnapshot",{from}]);}
 act(()=>host.querySelector<HTMLButtonElement>(".photo-editor__snapshot-name")!.click());expect(run.mock.lastCall).toEqual(["history.selectSnapshot",{snapshot:7}]);
 const begin=()=>act(()=>host.querySelector<HTMLButtonElement>('[aria-label="重命名快照 Before"]')!.click());begin();
 const edit=(value:string)=>act(()=>{const input=host.querySelector("input")!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
 const key=(key:string)=>act(()=>host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true})));
 run.mockClear();edit(" ");key("Enter");expect(run).not.toHaveBeenCalled();expect(host.querySelector("input")!.title).toContain("有效");edit("Edited");key("Enter");expect(run.mock.lastCall).toEqual(["history.renameSnapshot",{snapshot:7,name:"Edited"}]);
 begin();edit("Cancel");key("Escape");expect(run).toHaveBeenCalledOnce();act(()=>host.querySelector<HTMLButtonElement>('[aria-label="删除快照 Before"]')!.click());expect(run.mock.lastCall).toEqual(["history.deleteSnapshot",{snapshot:7}]);
 }finally{act(()=>root.unmount());host.remove();}
});
it("禁用或能力未开放不能创建/选择/删除/改名；文档key变化清掉名称草稿",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),run=vi.fn(()=>true),commands=new Map(["newSnapshot","selectSnapshot","renameSnapshot","deleteSnapshot"].map(id=>[`history.${id}`,{allowed:true,enabled:true} as PhotocraftCommand]));
 const render=(key:string,disabled:boolean)=>act(()=>root.render(<HistorySnapshots key={key} snapshots={[{id:1,name:"A"}]} commands={commands} disabled={disabled} onCommand={run}/>));
 try{render("a",false);act(()=>host.querySelector<HTMLButtonElement>('[aria-label="重命名快照 A"]')!.click());expect(host.querySelector("input")).not.toBeNull();render("b",true);expect(host.querySelector("input")).toBeNull();for(const button of host.querySelectorAll<HTMLButtonElement>("button")){expect(button.disabled).toBe(true);act(()=>button.click());}expect(run).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());host.remove();}
});
