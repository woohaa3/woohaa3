/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {DropdownMenu,MenuBar} from "./Menu.js";
import {UiProvider} from "./UiProvider.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const pointer=(node:Element,type:string)=>{
 const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==="pointerup"?0:1});Object.defineProperties(event,{pointerId:{value:7},pointerType:{value:"mouse"}});act(()=>node.dispatchEvent(event));
};
const item=(label:string)=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===label)!;
it("普通页脚菜单按下即开，拖入项目释放只执行一次；标题原地释放仍保持展开",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),choose=vi.fn();
 try{
 act(()=>root.render(<UiProvider><DropdownMenu label="调整" trigger={<button>调整</button>} items={[{id:"brightness",label:"亮度",onSelect:choose}]}/></UiProvider>));
 const trigger=host.querySelector("button")!;pointer(trigger,"pointerdown");expect(item("亮度")).toBeDefined();pointer(trigger,"pointerup");expect(choose).not.toHaveBeenCalled();expect(item("亮度")).toBeDefined();
 pointer(item("亮度"),"pointerover");pointer(item("亮度"),"pointermove");pointer(item("亮度"),"pointerup");expect(choose).toHaveBeenCalledOnce();expect(choose.mock.calls[0][0]).toBe("brightness");
 expect(document.querySelector('[role="menu"]')).toBeNull();
 }finally{act(()=>root.unmount());host.remove();}
});
it("菜单栏按住标题跨菜单及子菜单释放执行；空白、取消、失焦不执行",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),choose=vi.fn();
 const menus=<><DropdownMenu label="一" trigger={<button>一</button>} items={[{id:"first",label:"第一项",onSelect:choose}]}/><DropdownMenu label="二" trigger={<button>二</button>} items={[{id:"sub",label:"子菜单",onSelect:()=>{},children:[{id:"nested",label:"末项",onSelect:choose}]}]}/></>;
 try{
 act(()=>root.render(<UiProvider><MenuBar>{menus}</MenuBar></UiProvider>));const [first,second]=host.querySelectorAll("button");
 pointer(first,"pointerdown");expect(item("第一项")).toBeDefined();pointer(second,"pointerover");expect(item("第一项")).toBeUndefined();expect(item("子菜单")).toBeDefined();
 pointer(item("子菜单"),"pointerover");pointer(item("子菜单"),"pointermove");await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150));});
 expect(item("末项"),document.body.innerHTML).toBeDefined();pointer(item("末项"),"pointerover");pointer(item("末项"),"pointerup");expect(choose).toHaveBeenCalledOnce();expect(choose.mock.calls[0][0]).toBe("nested");
 pointer(first,"pointerdown");pointer(document.body,"pointerup");expect(document.querySelector('[role="menu"]')).toBeNull();expect(choose).toHaveBeenCalledOnce();
 pointer(first,"pointerdown");pointer(document.body,"pointercancel");expect(document.querySelector('[role="menu"]')).toBeNull();pointer(second,"pointerover");expect(document.querySelector('[role="menu"]')).toBeNull();
 pointer(first,"pointerdown");act(()=>window.dispatchEvent(new Event("blur")));expect(document.querySelector('[role="menu"]')).toBeNull();expect(choose).toHaveBeenCalledOnce();
 pointer(first,"pointerdown");pointer(first,"pointerup");expect(item("第一项")).toBeDefined();act(()=>item("第一项").click());expect(choose).toHaveBeenCalledTimes(2);
 }finally{act(()=>root.unmount());host.remove();}
});
