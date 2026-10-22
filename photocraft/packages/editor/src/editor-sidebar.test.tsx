/** @vitest-environment jsdom */
// 仅验证 DOM 事件与状态；几何使用接口替身，不采集渲染。
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {EditorSidebar} from "./editor-sidebar.js";
import {useEditorDisplay} from "./editor-display.js";
import {PANEL_LAYOUT_KEY} from "./editor-panel-layout.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("宽度、分区、浮动拖动与取消只更新偏好；重挂载恢复，子内容不重建",()=>{
  localStorage.removeItem(PANEL_LAYOUT_KEY);
  const before=vi.fn();const container=document.createElement("div");document.body.append(container);let root=createRoot(container);
  const Harness=({disabled=false,visible=true}:{disabled?:boolean;visible?:boolean})=>{
    const display=useEditorDisplay(before);
    return <EditorSidebar display={{...display,state:{...display.state,sidebarVisible:visible}}} disabled={disabled}
      layers={<input data-draft defaultValue="草稿"/>} history={<div>历史</div>} properties={<div>属性</div>}/>;
  };
  const render=(disabled=false,visible=true)=>act(()=>root.render(<Harness disabled={disabled} visible={visible}/>));
  const event=(selector:string,type:string,x:number,y:number)=>{
    const target=container.querySelector<HTMLElement>(selector)!;
    const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,"pointerId",{value:1});
    act(()=>target.dispatchEvent(event));
  };
  const state=()=>JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)!);
  try {
    render();const draft=container.querySelector("[data-draft]");
    event(".photo-editor__panel-width","pointerdown",100,0);event(".photo-editor__panel-width","pointermove",40,0);event(".photo-editor__panel-width","pointerup",40,0);
    expect(state().width).toBe(340);expect(before).toHaveBeenCalledTimes(1);
    container.querySelector(".photo-editor__panel-stack")!.getBoundingClientRect=()=>({height:400}) as DOMRect;
    event(".photo-editor__panel-splitter","pointerdown",0,100);event(".photo-editor__panel-splitter","pointermove",0,140);event(".photo-editor__panel-splitter","pointerup",0,140);
    expect(state().split).toBe(.7);expect(before).toHaveBeenCalledTimes(1);
    act(()=>container.querySelector<HTMLButtonElement>(".photo-editor__sidebar-header button")!.click());expect(state().floating).toBe(true);expect(before).toHaveBeenCalledTimes(2);
    event(".photo-editor__sidebar-header","pointerdown",100,100);event(".photo-editor__sidebar-header","pointermove",160,180);event(".photo-editor__sidebar-header","pointerup",160,180);
    expect(state()).toMatchObject({x:80,y:100});expect(before).toHaveBeenCalledTimes(2);
    event(".photo-editor__panel-size","pointerdown",0,0);event(".photo-editor__panel-size","pointermove",40,50);event(".photo-editor__panel-size","pointercancel",40,50);
    expect(state()).toMatchObject({width:340,height:640});
    event(".photo-editor__sidebar-header","pointerdown",0,0);event(".photo-editor__sidebar-header","pointermove",50,50);render(true);
    expect(state()).toMatchObject({x:80,y:100});
    expect(container.querySelector("[data-draft]")).toBe(draft);
    render();event(".photo-editor__sidebar-header","pointerdown",0,0);event(".photo-editor__sidebar-header","pointermove",10,10);
    act(()=>container.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    expect(state()).toMatchObject({x:80,y:100});
    event(".photo-editor__sidebar-header","pointerdown",0,0);event(".photo-editor__sidebar-header","pointermove",10,10);render(false,false);
    expect(state()).toMatchObject({x:80,y:100});expect(container.querySelector("aside")!.hidden).toBe(true);
    render();event(".photo-editor__sidebar-header","pointerdown",0,0);event(".photo-editor__sidebar-header","pointermove",10,10);
    act(()=>window.dispatchEvent(new Event("blur")));expect(state()).toMatchObject({x:80,y:100});
    act(()=>root.unmount());root=createRoot(container);render();expect(state()).toMatchObject({floating:true,width:340,split:.7,x:80,y:100});
    expect(container.querySelector("aside")!.getAttribute("data-floating")).toBe("true");
  } finally {act(()=>root.unmount());container.remove();localStorage.removeItem(PANEL_LAYOUT_KEY);}
});

it("存储损坏回退默认偏好，存储被禁用时仍可调整当前面板",()=>{
  localStorage.setItem(PANEL_LAYOUT_KEY,"invalid-json");
  const container=document.createElement("div");const root=createRoot(container);
  function Harness(){const display=useEditorDisplay();return <><output>{display.state.panelLayout?.width}</output><button onClick={()=>display.updatePanels?.({width:400})}>改宽度</button></>;}
  try {
    act(()=>root.render(<Harness/>));expect(container.querySelector("output")!.textContent).toBe("280");
    const write=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("storage unavailable");});
    act(()=>container.querySelector<HTMLButtonElement>("button")!.click());expect(container.querySelector("output")!.textContent).toBe("400");
    write.mockRestore();
  } finally {act(()=>root.unmount());vi.restoreAllMocks();localStorage.removeItem(PANEL_LAYOUT_KEY);}
});
