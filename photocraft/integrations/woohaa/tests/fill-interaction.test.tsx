import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → EditorHandle → 接口替身，只验证命令和状态，不执行填充或合成。
import {act, type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
import {FILL_SHORTCUTS} from "@woohaa3/photocraft-editor";

vi.mock("../../../packages/editor/src/ui/Menu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@woohaa3/photocraft-editor/ui")>();
  const entries = (items: readonly import("@woohaa3/photocraft-editor/ui").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={() => item.onSelect(item.id)}>{item.label}</button>);
  return {...actual, DropdownMenu: ({label, items}: {label: string; items: readonly import("@woohaa3/photocraft-editor/ui").MenuItem[]}) =>
    <div data-menu={label}>{entries(items)}</div>};
});
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("菜单和快捷键将当前色盘送入内核，正式快照刷新历史与原节点端口，失败保留状态",async()=>{
  let revision=1,filled=false,fail=false;
  const ids=[...FILL_SHORTCUTS.map(entry=>entry.id),"edit.undo","edit.redo"];
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:1,editTarget:"mask",hasSelection:true,
    canUndo:filled,canRedo:!filled,history:filled?["打开","填充"]:["打开"],
    layers:[{id:1,name:"图层",kind:"raster",visible:true,opacity:1,blend:"Normal",hasMask:true}]}});
  const execute=vi.fn((id:string,_params:string)=>{
    if(fail) throw JSON.stringify({code:"command-failed",message:"目标已锁定"});
    filled=id!=="edit.undo";revision++;return "null";
  });
  const instance={openImage:stateJson,stateJson,contentHash:()=>(filled?2:1).toString(16).padStart(16,"0"),execute,
    commandsJson:()=>JSON.stringify(ids.map(id=>({id,label:id,menu:["Edit"],shortcut:null,params:"{}",allowed:true,enabled:true,needsDocument:true,disabledReason:null}))),
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([filled?2:1,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  const controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly}
    canvasView={{viewport:{x:0,y:0,zoom:.5},fitZoom:.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  const chord=(target:Element)=>act(()=>target.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",altKey:true,bubbles:true,cancelable:true})));
  try {
    render();const editor=container.querySelector(".photo-editor")!;
    const background=container.querySelector<HTMLInputElement>('.photo-editor__background-swatch input')!;
    act(()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(background,"#804020");
      background.dispatchEvent(new Event("input",{bubbles:true}));
    });
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="edit.fillBackground"]')!.click());
    expect(execute.mock.lastCall).toEqual(["edit.fillBackground",JSON.stringify({color:"#804020"})]);
    expect(controller.isDirty()).toBe(true);
    expect(container.querySelectorAll(".photo-editor__history button")).toHaveLength(2);
    expect(controller.snapshot().view.document?.editTarget).toBe("mask");
    expect(controller.snapshot().view.document?.hasSelection).toBe(true);
    expect(onPreview.mock.lastCall?.[0].pixels[0]).toBe(2);
    act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__history-actions [aria-label="撤销"]')!.click());
    expect(controller.isDirty()).toBe(false);
    fail=true;chord(editor);
    expect(controller.isDirty()).toBe(false);
    expect(container.textContent).toContain("目标已锁定");
    fail=false;chord(editor);
    expect(execute.mock.lastCall).toEqual(["edit.fillForeground",JSON.stringify({color:"#000000"})]);
    expect(controller.isDirty()).toBe(true);
    const calls=execute.mock.calls.length;
    chord(background);render(true);chord(editor);
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="edit.fillForeground"]')!.click());
    expect(execute).toHaveBeenCalledTimes(calls);
  } finally {act(()=>root.unmount());controller.dispose();container.remove();vi.restoreAllMocks();}
});
