/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {HistoryPanel} from "./photo-editor-panels.js";
import {decodeEditorState} from "./editor-view-model.js";
import {UiProvider} from "./ui/UiProvider.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("删除当前状态单次分派当前原生索引，最早/只读/能力关闭拒绝",()=>{
 const node=document.createElement("div"),root=createRoot(node),run=vi.fn(()=>true),commands=new Map<string,PhotocraftCommand>([["history.deleteState",{allowed:true,enabled:true} as PhotocraftCommand]]);
 const render=(history=["Open","A","B"],readonly=false)=>act(()=>root.render(<UiProvider><HistoryPanel view={decodeEditorState({document:{width:12,height:8,layers:[],history,redoHistory:["Future"],canUndo:history.length>1}})!} readonly={readonly} onUndo={vi.fn()} onRedo={vi.fn()} onGoTo={vi.fn()} commands={commands} onHistoryCommand={run}/></UiProvider>));
 const button=()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="删除当前状态")!;
 try{
  render();act(()=>button().click());expect(run.mock.calls).toEqual([["history.deleteState",{state:2}]]);
  render(["Open"]);expect(button().disabled).toBe(true);act(()=>button().click());render(undefined,true);expect(button().disabled).toBe(true);act(()=>button().click());expect(run).toHaveBeenCalledOnce();
  commands.set("history.deleteState",{allowed:true,enabled:false} as PhotocraftCommand);render();expect(button().disabled).toBe(true);
  commands.clear();render();expect(button()).toBeUndefined();
 }finally{act(()=>root.unmount());}
});

it("只在历史位置/文档改变且当前行不可见时跟随；状态上限同名新步骤、快照与手动滚动隔离",()=>{
 const height=vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockImplementation(function(this:HTMLElement){return this.classList.contains("photo-editor__history")?100:0;});
 let rowTop=100;const bounds=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){const top=this.classList.contains("photo-editor__history")?0:this.classList.contains("is-current")?rowTop:0;const h=this.classList.contains("photo-editor__history")?100:24;return {top,bottom:top+h,left:0,right:200,width:200,height:h,x:0,y:top,toJSON:()=>({})} as DOMRect;});
 const node=document.createElement("div"),root=createRoot(node);let doc="d",follow="1",revision=1,label="Brush";
 const commands=new Map<string,PhotocraftCommand>(["newSnapshot","selectSnapshot"].map(id=>[`history.${id}`,{allowed:true,enabled:true} as PhotocraftCommand]));
 const render=()=>root.render(<UiProvider><HistoryPanel view={decodeEditorState({document:{documentKey:doc,historyFollowKey:follow,revision,width:12,height:8,layers:[],history:["Open",label],redoHistory:[],historySnapshots:[{id:1,name:"Saved"}]}})!} readonly={false} onUndo={vi.fn()} onRedo={vi.fn()} onGoTo={vi.fn()} commands={commands} onHistoryCommand={id=>{if(id==="history.selectSnapshot"){follow="snapshot";label="Saved";render();}return true;}}/></UiProvider>);
 const list=()=>node.querySelector<HTMLOListElement>(".photo-editor__history")!;
 try{
  act(render);expect(list().scrollTop).toBe(24);list().scrollTop=0;revision++;act(render);expect(list().scrollTop).toBe(0);
  follow="2";act(render);expect(list().scrollTop).toBe(24);list().scrollTop=77;rowTop=20;follow="3";act(render);expect(list().scrollTop).toBe(77);
  rowTop=-10;follow="4";act(render);expect(list().scrollTop).toBe(67);
  rowTop=100;list().scrollTop=0;doc="other";act(render);expect(list().scrollTop).toBe(24);
  list().scrollTop=0;act(()=>node.querySelector<HTMLButtonElement>(".photo-editor__snapshot-name")!.click());expect(list().scrollTop).toBe(0);revision++;act(render);expect(list().scrollTop).toBe(0);
  follow="after-snapshot";label="Brush";act(render);expect(list().scrollTop).toBe(24);
 }finally{act(()=>root.unmount());height.mockRestore();bounds.mockRestore();}
});
