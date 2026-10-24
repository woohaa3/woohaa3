/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {DocumentTabs,type DocumentTabContext} from "../src/document-tabs.js";
import {entryOf,snapshotOf} from "../src/test-support/document-workspace-harness.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("标签呈现实际倍率/活动层/蒙版/模式位深与未保存标记，保留来源和保存状态",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),activate=vi.fn(),close=vi.fn();
 const first=entryOf({id:"a",name:"图片",detail:"节点甲",status:"dirty"}),second=entryOf({id:"b",name:"图片",detail:"节点乙"});
 const context:DocumentTabContext={documentId:"a",generation:1,zoom:.6666667,layer:"标题",target:"mask",mode:"RGB",depthBits:8,dirty:true};
 const render=(entries=[first,second],activeContext:DocumentTabContext|null=context)=>act(()=>root.render(<DocumentTabs snapshot={snapshotOf(entries)} activeContext={activeContext} onActivate={activate} onClose={close}/>));
 try{
 render();let tab=host.querySelector<HTMLElement>('[data-document-id="a"]')!;expect(tab.querySelector(".photo-document-tab__name")?.textContent).toBe("图片 @ 66.67% (标题，图层蒙版，RGB/8) *");expect(tab.title).toContain("节点甲");expect(tab.textContent).toContain("未保存");
 render([{...first,status:"saving"},second]);expect(host.textContent).toContain("保存中");expect(host.querySelector('[data-document-id="a"] .photo-document-tab__name')?.textContent).toContain(" *");
 // 宿主上报真实进度时才带百分比；活动项以外的标签不借用该数字。
 render([{...first,status:"saving"},second],{...context,savePercent:42});expect(host.textContent).toContain("保存中 42%");
 render([{...first,status:"saving"},second],{...context,savePercent:undefined});
 expect(host.querySelector('[data-document-id="a"]')!.textContent).toContain("保存中");
 expect(host.querySelector('[data-document-id="a"]')!.textContent).not.toContain("保存中 %");
 render([{...first,status:"clean"},second],{...context,zoom:2,layer:"像素",target:"pixels",dirty:false});tab=host.querySelector<HTMLElement>('[data-document-id="a"]')!;expect(tab.querySelector(".photo-document-tab__name")?.textContent).toBe("图片 @ 200% (像素，RGB/8)");
 act(()=>tab.click());expect(activate).toHaveBeenCalledWith("a");act(()=>tab.querySelector<HTMLButtonElement>("button")!.click());expect(close).toHaveBeenCalledWith("a");expect(activate).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());host.remove();}
});
it("打开中的占位标签显示真实进度、关闭按钮改为取消，完成后不再显示进度",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),close=vi.fn(),activate=vi.fn();
 const opening=entryOf({id:"a",name:"大图.png",status:"opening"});
 const render=(entry=opening)=>act(()=>root.render(<DocumentTabs snapshot={snapshotOf([entry])} onActivate={activate} onClose={close}/>));
 try{
  render();
  const tab=host.querySelector<HTMLElement>('[data-document-id="a"]')!;
  expect(tab.textContent).toContain("打开中");
  expect(tab.querySelector<HTMLButtonElement>(".photo-document-tab__close")!.getAttribute("aria-label")).toBe("取消打开 大图.png");
  // 未上报进度时没有百分比，进度条为 0。
  expect(tab.textContent).not.toContain("%");
  expect(tab.querySelector<HTMLElement>("[data-open-progress]")!.getAttribute("data-open-progress")).toBe("0");
  render({...opening,openPercent:64});
  expect(host.textContent).toContain("打开中 64%");
  expect(host.querySelector<HTMLElement>("[data-open-progress]")!.getAttribute("data-open-progress")).toBe("64");
  // 打开中的占位标签不能被激活（还没有可呈现的资源）。
  act(()=>tab.click());
  expect(activate).not.toHaveBeenCalled();
  act(()=>host.querySelector<HTMLButtonElement>(".photo-document-tab__close")!.click());
  expect(close).toHaveBeenCalledWith("a");
  // 完成后按普通文档呈现，进度条消失。
  render({...entryOf({id:"a",name:"大图.png"}),openPercent:undefined});
  expect(host.textContent).not.toContain("打开中");
  expect(host.querySelector("[data-open-progress]")).toBeNull();
  expect(host.querySelector<HTMLButtonElement>(".photo-document-tab__close")!.getAttribute("aria-label")).toBe("关闭 大图.png");
 }finally{act(()=>root.unmount());host.remove();}
});
it("后台标签保留最后上下文，关闭及重开代际不复用；没有实际元数据不猜测",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),first=entryOf({id:"a",name:"甲"}),second=entryOf({id:"b",name:"乙"});
 const render=(entries=[first,second],activeContext:DocumentTabContext|null=null)=>act(()=>root.render(<DocumentTabs snapshot={snapshotOf(entries,activeContext?.documentId)} activeContext={activeContext} onActivate={()=>{}} onClose={()=>{}}/>));
 const title=(id:string)=>host.querySelector(`[data-document-id="${id}"] .photo-document-tab__name`)?.textContent;
 try{
 render(undefined,{documentId:"a",generation:1,zoom:1.5,layer:"A",target:"pixels",mode:"RGB",depthBits:8});
 render(undefined,{documentId:"b",generation:1,zoom:.5,layer:null,target:"pixels",mode:"",depthBits:0});expect(title("a")).toBe("甲 @ 150% (A，RGB/8)");expect(title("b")).toBe("乙 @ 50%");
 render([{...first,generation:2},second]);expect(title("a")).toBe("甲");
 render([second]);render([first,second]);expect(title("a")).toBe("甲");
 }finally{act(()=>root.unmount());host.remove();}
});

it("标签中键关闭不激活，右键可关闭当前/其他/全部且以被点击标签为保留目标",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),activate=vi.fn(),close=vi.fn(),others=vi.fn(),all=vi.fn();let entries=[entryOf({id:"a"}),entryOf({id:"b"})];
 const render=()=>act(()=>root.render(<DocumentTabs snapshot={snapshotOf(entries,"a")} onActivate={activate} onClose={close} onCloseOthers={others} onCloseAll={all}/>));render();
 const tab=(id="b")=>host.querySelector<HTMLElement>(`[data-document-id="${id}"]`)!;
 const context=()=>act(()=>tab().dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:30,clientY:20})));
 const item=(name:string)=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===name)!;
 try{
  act(()=>tab().dispatchEvent(new MouseEvent("auxclick",{button:1,bubbles:true,cancelable:true})));expect(close.mock.calls).toEqual([["b"]]);expect(activate).not.toHaveBeenCalled();close.mockClear();
  context();act(()=>item("关闭其他文档").click());expect(others.mock.calls).toEqual([["b"]]);expect(activate).not.toHaveBeenCalled();
  context();act(()=>item("关闭全部").click());expect(all).toHaveBeenCalledOnce();context();act(()=>item("关闭").click());expect(close.mock.calls).toEqual([["b"]]);
  context();entries=[entries[0]!,{...entries[1]!,generation:2}];render();expect(item("关闭")).toBeUndefined();expect(close).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());host.remove();}
});
it("标签拖排校验本次拖动与当前代际；外部、取消、重开和半手势无重排",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),reorder=vi.fn(),activate=vi.fn();let entries=[entryOf({id:"a"}),entryOf({id:"b"}),entryOf({id:"c"})],gate:string|null=null;
 const render=()=>act(()=>root.render(<DocumentTabs snapshot={{...snapshotOf(entries,"a"),activeGate:gate}} onActivate={activate} onClose={()=>{}} onReorder={reorder}/>));render();
 const tab=(id:string)=>host.querySelector<HTMLElement>(`[data-document-id="${id}"]`)!;
 const data=new Map<string,string>(),transfer={effectAllowed:"none",dropEffect:"none",setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type)??""};
 const send=(id:string,type:string,clientX=0,foreign=false)=>{const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX});Object.defineProperty(event,"dataTransfer",{value:foreign?{...transfer,getData:()=>"external"}:transfer});act(()=>tab(id).dispatchEvent(event));return event;};
 try{
  send("a","dragstart");send("c","dragover",100);expect(tab("c").dataset.dropAfter).toBe("true");send("c","drop",100);expect(reorder.mock.calls).toEqual([["a",null,1,undefined]]);expect(activate).not.toHaveBeenCalled();reorder.mockClear();
  send("a","dragstart");send("b","drop",-1);expect(reorder.mock.calls).toEqual([["a","b",1,1]]);reorder.mockClear();
  send("a","dragstart");send("a","dragend");send("c","drop",100);expect(reorder).not.toHaveBeenCalled();
  send("a","dragstart");send("c","drop",100,true);expect(reorder).not.toHaveBeenCalled();
  send("a","dragstart");entries=[{...entries[0]!,generation:2},entries[1]!,entries[2]!];render();send("c","drop",100);expect(reorder).not.toHaveBeenCalled();
  gate="笔迹未结束";render();expect(tab("a").draggable).toBe(false);expect(send("a","dragstart").defaultPrevented).toBe(true);send("c","drop",100);expect(reorder).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());host.remove();}
});
