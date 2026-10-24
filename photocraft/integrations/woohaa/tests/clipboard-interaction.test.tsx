import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → EditorHandle → 接口替身，只验证命令和状态，不执行有效像素操作或合成。
import {act, type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
import {COMMAND_SHORTCUTS} from "@woohaa3/photocraft-editor";

vi.mock("../../../packages/editor/src/ui/Menu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@woohaa3/photocraft-editor/ui")>();
  const entries = (items: readonly import("@woohaa3/photocraft-editor/ui").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={() => item.onSelect(item.id)}>{item.label}</button>);
  return {...actual, DropdownMenu: (props: import("../../../packages/editor/src/ui/Menu.js").DropdownMenuProps) =>
    props.children ? <actual.DropdownMenu {...props}/> : <div data-menu={props.label}>{entries(props.items ?? [])}</div>};
});
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("内部剪贴板菜单、键盘与原生事件走同一内核入口，输入与只读不误触发",async()=>{
  let revision=1,pasted=false,fail=false;
  let selectionFrame:number[]|null=null;
  const ids=COMMAND_SHORTCUTS.filter(entry=>["edit.copy","edit.copyMerged","edit.cut","edit.paste","edit.pasteSpecial.pasteInPlace"].includes(entry.id)).map(entry=>entry.id);
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:1,editTarget:"pixels",hasSelection:true,selectionFrame,
    canUndo:pasted,canRedo:false,history:pasted?["打开","粘贴"]:["打开"],
    layers:[{id:1,name:"图层",kind:"raster",visible:true,opacity:1,blend:"Normal"}]}});
  const execute=vi.fn((id:string,_params:string)=>{
    if(fail) throw JSON.stringify({code:"command-failed",message:"内部剪贴板为空"});
    if(id.startsWith("edit.paste") || id==="edit.cut") {pasted=true;revision++;}
    return "null";
  });
  const instance={openImage:stateJson,stateJson,contentHash:()=>(pasted?2:1).toString(16).padStart(16,"0"),execute,
    commandsJson:()=>JSON.stringify(ids.map(id=>({id,label:id,menu:["Edit"],shortcut:null,params:"{}",allowed:true,enabled:true,needsDocument:true,disabledReason:null}))),
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([pasted?2:1,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  const controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly}
    canvasView={{viewport:{x:40,y:-30,zoom:.5},fitZoom:.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  const chord=(target:Element,key:string,shiftKey=false)=>act(()=>target.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey:true,shiftKey,bubbles:true,cancelable:true})));
  const native=(target:Element,type:string)=>{const event=new Event(type,{bubbles:true,cancelable:true});act(()=>target.dispatchEvent(event));return event;};
  try {
    render();const editor=container.querySelector(".photo-editor")!;
    chord(editor,"c");expect(execute.mock.lastCall).toEqual(["edit.copy","null"]);
    expect(controller.isDirty()).toBe(false);
    chord(editor,"c",true);expect(execute.mock.lastCall?.[0]).toBe("edit.copyMerged");
    native(editor,"copy");expect(execute.mock.lastCall?.[0]).toBe("edit.copy");
    fail=true;expect(native(editor,"paste").defaultPrevented).toBe(true);
    expect(container.textContent).toContain("内部剪贴板为空");expect(controller.isDirty()).toBe(false);
    expect(execute.mock.lastCall).toEqual(["edit.paste",JSON.stringify({center:[320,360]})]);
    fail=false;selectionFrame=[10,20,50,80];chord(editor,"c");
    native(editor,"paste");expect(execute.mock.lastCall).toEqual(["edit.paste",JSON.stringify({center:[320,360]})]);
    chord(editor,"v",true);expect(execute.mock.lastCall).toEqual(["edit.pasteSpecial.pasteInPlace","null"]);
    expect(controller.isDirty()).toBe(true);expect(onPreview.mock.lastCall?.[0].pixels[0]).toBe(2);
    const menu=container.querySelector('[data-menu="编辑"]')!;
    act(()=>Array.from(menu.querySelectorAll("button")).find(button=>button.textContent?.startsWith("剪切"))!.click());
    expect(execute.mock.lastCall).toEqual(["edit.cut",JSON.stringify({color:"#ffffff"})]);
    const input=container.querySelector("input")!;const calls=execute.mock.calls.length;
    chord(input,"v");expect(native(input,"paste").defaultPrevented).toBe(false);
    render(true);chord(editor,"v");expect(native(editor,"paste").defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledTimes(calls);
  } finally {act(()=>root.unmount());controller.dispose();container.remove();vi.restoreAllMocks();}
});
