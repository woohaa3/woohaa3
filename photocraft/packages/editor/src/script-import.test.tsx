/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {useScriptImport,MAX_SCRIPT_BYTES} from "./script-import.js";
import {decodeEditorState} from "./editor-view-model.js";
import type {EditorSnapshot} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
function setup(){
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),report=vi.fn(),refresh=vi.fn(),listeners=new Set<(snapshot:EditorSnapshot)=>void>();
 let blocked=false,gesture=false,owner="a",mounted=true;
 const snapshot:EditorSnapshot={view:decodeEditorState({document:{documentKey:"doc",revision:1,width:12,height:8,layers:[]}})!,state:{phase:"editing",message:null,dirty:false,retriable:false},commands:new Map([["file.scripts.browse",{id:"file.scripts.browse",allowed:true,enabled:true} as never]])};
 const dispatch=vi.fn(()=>({ok:true as const,value:snapshot.view}));
 const controller={snapshot:()=>snapshot,subscribe:(listener:(snapshot:EditorSnapshot)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},dialogOwner:()=>({canvasId:"c",sessionId:owner}),dispatch};
 function App(){const script=useScriptImport(controller,blocked,()=>gesture,refresh,report);return <>{script.input}<button onClick={script.open}>Open</button></>;}
 const render=()=>act(()=>root.render(<App/>));render();
 const input=()=>host.querySelector<HTMLInputElement>("input")!;
 const open=()=>act(()=>host.querySelector("button")!.click());
 const choose=(file:{name:string;size:number;arrayBuffer:()=>Promise<ArrayBuffer>})=>act(()=>{Object.defineProperty(input(),"files",{configurable:true,value:[file]});input().dispatchEvent(new Event("change",{bubbles:true}));});
 const notify=()=>act(()=>listeners.forEach(listener=>listener(snapshot)));
 return {host,dispatch,report,refresh,input,open,choose,notify,snapshot,render,setBlocked:(value:boolean)=>{blocked=value;render();},setGesture:(value:boolean)=>{gesture=value;},setOwner:(value:string)=>{owner=value;},dispose:()=>{if(mounted){act(()=>root.unmount());mounted=false;host.remove();}}};
}
const bytes=(source:string)=>new TextEncoder().encode(source).buffer;
const settle=()=>act(async()=>{await Promise.resolve();await Promise.resolve();});
function deferred(){let resolve!:(bytes:ArrayBuffer)=>void;const promise=new Promise<ArrayBuffer>(done=>{resolve=done;});return {promise,resolve};}
it("文件字节按UTF-8交付唯一命令，成功刷新，重复选择同文件可再次执行",async()=>{
 const s=setup(),arrayBuffer=vi.fn(async()=>bytes("\uFEFF# example\nlayer.new.layer"));const file={name:"steps.TXT",size:32,arrayBuffer};
 try{
  expect(s.input().accept).toBe(".json,.txt,.pcdroplet");
  s.open();s.choose(file);await settle();expect(s.dispatch.mock.calls).toEqual([["file.scripts.browse",{name:"steps.TXT",source:"# example\nlayer.new.layer"}]]);expect(s.refresh).toHaveBeenCalledOnce();expect(s.report.mock.lastCall).toEqual(["脚本已执行。"]);expect(s.input().value).toBe("");
  s.open();s.choose(file);await settle();expect(s.dispatch).toHaveBeenCalledTimes(2);
 }finally{s.dispose();}
});
it("读前大小/扩展名、读后真实大小和UTF-8严格检查；读取/内核失败展示错误",async()=>{
 const s=setup();
 try{
  const read=vi.fn(async()=>bytes("x"));for(const file of [{name:"x.jsx",size:1,arrayBuffer:read},{name:"x.txt",size:MAX_SCRIPT_BYTES+1,arrayBuffer:read}]){s.open();s.choose(file);await settle();}expect(read).not.toHaveBeenCalled();
  for(const file of [{name:"x.txt",size:1,arrayBuffer:async()=>new Uint8Array([0xff]).buffer},{name:"x.txt",size:1,arrayBuffer:async()=>new ArrayBuffer(MAX_SCRIPT_BYTES+1)},{name:"x.txt",size:1,arrayBuffer:async()=>{throw new Error("Read failed");}}]){s.open();s.choose(file);await settle();}
  expect(s.dispatch).not.toHaveBeenCalled();expect(s.report.mock.calls.some(call=>String(call[0]).includes("UTF-8"))).toBe(true);expect(s.report.mock.lastCall).toEqual(["Read failed"]);
  s.dispatch.mockReturnValueOnce({ok:false,code:"command-failed",message:"第2步失败"} as never);s.open();s.choose({name:"x.json",size:1,arrayBuffer:read});await settle();expect(s.report.mock.lastCall).toEqual(["第2步失败"]);expect(s.refresh).not.toHaveBeenCalled();
 }finally{s.dispose();}
});
it("异步读取拒绝owner/文档/能力/草稿/手势/代次变化；卸载和取消后无发布",async()=>{
 const s=setup();
 const begin=()=>{const wait=deferred();s.open();s.choose({name:"x.txt",size:1,arrayBuffer:()=>wait.promise});return wait;};
 const finish=async(wait:ReturnType<typeof deferred>)=>{wait.resolve(bytes("layer.new.layer"));await settle();};
 try{
  let wait=begin();s.setOwner("b");await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();s.notify();await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();s.setGesture(true);await finish(wait);s.setGesture(false);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();s.setBlocked(true);s.setBlocked(false);await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();(s.snapshot.commands as Map<string,never>).clear();await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();(s.snapshot.commands as Map<string,never>).set("file.scripts.browse",{allowed:true,enabled:true} as never);
  wait=begin();s.open();await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();act(()=>s.input().dispatchEvent(new Event("cancel",{bubbles:true})));await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();
  wait=begin();s.dispose();s.report.mockClear();await finish(wait);expect(s.dispatch).not.toHaveBeenCalled();expect(s.report).not.toHaveBeenCalled();
 }finally{s.dispose();}
});
