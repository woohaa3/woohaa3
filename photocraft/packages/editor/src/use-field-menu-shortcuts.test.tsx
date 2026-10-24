/** @vitest-environment jsdom */
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {useFieldMenuShortcuts} from "./use-field-menu-shortcuts.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
it("数字字段先结算再执行ModJ，文本组合和普通工具键保留输入行为",()=>{
 const owner={},apply=vi.fn(),before=vi.fn(()=>true);let blocked=false;
 function Probe(){const capture=useFieldMenuShortcuts({owner,targetKey:"1",blocked,isMac:false,before,apply});return <div onKeyDownCapture={capture}><input type="number"/><input type="text"/><textarea/></div>;}
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const render=()=>act(()=>root.render(<Probe/>));render();
 const send=(key:string,options:KeyboardEventInit={},target:Element=node.querySelector("input")!)=>{const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options});act(()=>target.dispatchEvent(event));return event;};
 expect(send("j",{ctrlKey:true}).defaultPrevented).toBe(true);expect(before).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledWith({kind:"command",id:"layer.new.layerViaCopy"});
 for(const key of ["a","c","v","x","z"]) expect(send(key,{ctrlKey:true}).defaultPrevented).toBe(false);
 expect(send("b").defaultPrevented).toBe(false);expect(send("j",{ctrlKey:true,isComposing:true}).defaultPrevented).toBe(false);
 expect(send("j",{ctrlKey:true},node.querySelector("textarea")!).defaultPrevented).toBe(false);
 before.mockReturnValue(false);send("j",{ctrlKey:true});expect(apply).toHaveBeenCalledOnce();
 blocked=true;render();send("j",{ctrlKey:true});expect(apply).toHaveBeenCalledOnce();
});
it("确认字段触发重新渲染后使用最新回调，目标变化时丢弃排队命令",()=>{
 const owner={},apply=vi.fn();let changeTarget=false;
 function Probe(){const [draft,setDraft]=useState(true),[target,setTarget]=useState("1");const capture=useFieldMenuShortcuts({owner,targetKey:target,blocked:false,isMac:true,
   before:()=>{setDraft(false);if(changeTarget) setTarget("2");return true;},apply:action=>apply(action,draft)});return <input onKeyDownCapture={capture}/>;}
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));
 const send=()=>act(()=>node.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"j",metaKey:true,bubbles:true,cancelable:true})));
 send();expect(apply).toHaveBeenCalledWith({kind:"command",id:"layer.new.layerViaCopy"},false);
 changeTarget=true;send();expect(apply).toHaveBeenCalledOnce();
});
