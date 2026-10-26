/** @vitest-environment jsdom */
// 仅验证 DOM 事件与状态；几何使用接口替身，不采集渲染。
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {EditorSidebar,PanelTabs} from "./editor-sidebar.js";
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

it("面板组按原生顺序堆叠并保留各面板节点",()=>{
  const container=document.createElement("div");const root=createRoot(container);
  const layers=<input data-testid="layers" defaultValue="layer"/>;
  const history=<div data-testid="history">history</div>;
  const properties=<div data-testid="properties">properties</div>;
  const info=<div data-testid="navigator">navigator</div>;
  const brushes=<div data-testid="brushes">brushes</div>;
  const color=<div data-testid="color">color</div>;
  const character=<div data-testid="character">character</div>;
  const controls={state:{sidebarVisible:true,panelLayout:undefined,extrasVisible:true,toolsVisible:true,optionsVisible:true,restore:null},toggle:vi.fn(),updatePanels:vi.fn()};
  try {
    act(()=>root.render(<EditorSidebar display={controls as never} disabled={false} layers={layers} history={history} properties={properties} info={info} color={color} character={character} characterVisible brushes={brushes} brushesVisible/>));
    expect([...container.querySelectorAll("[data-panel-group]")].map(node=>node.getAttribute("data-panel-group"))).toEqual(["color","properties","character","navigator","history","layers","brushes"]);
    const layerNode=container.querySelector("[data-testid=layers]");
    expect(container.querySelector("[data-testid=navigator]")?.textContent).toBe("navigator");
    expect(container.querySelector("[data-testid=layers]")).toBe(layerNode);
    const colorToggle=container.querySelector<HTMLElement>('[data-panel-group="color"] .photo-editor__panel-group-toggle')!;
    act(()=>colorToggle.click());
    expect(container.querySelector('[data-panel-group="color"]')?.getAttribute("data-collapsed-group")).toBe("true");
    expect(controls.updatePanels).toHaveBeenCalledWith({collapsedGroups:{color:true}});
    expect(container.querySelector<HTMLButtonElement>('[data-panel-group="color"] .photo-editor__panel-group-menu')?.getAttribute("aria-label")).toBe("颜色面板菜单");
    expect(container.querySelector('[data-testid=color]')?.parentElement?.hidden).toBe(false);
  } finally {act(()=>root.unmount());container.remove();}
});

it("面板组内 Tab 切换保留各内容节点",()=>{
  const container=document.createElement("div");const root=createRoot(container);
  try {
    act(()=>root.render(<PanelTabs tabs={[{id:"navigator",label:"导航器",content:<input data-testid="navigator-tab"/>},{id:"histogram",label:"直方图",content:<div data-testid="histogram-tab">h</div>}]}/>));
    const navigator=container.querySelector("[data-testid=navigator-tab]");
    act(()=>(container.querySelectorAll(".photo-editor__panel-tabs button")[1] as HTMLButtonElement).click());
    expect(container.querySelector("[data-testid=histogram-tab]")).not.toBeNull();
    expect(container.querySelector("[data-testid=navigator-tab]")).toBe(navigator);
    expect((container.querySelectorAll(".photo-editor__panel-tabs button")[1] as HTMLButtonElement).getAttribute("aria-selected")).toBe("true");
  } finally {act(()=>root.unmount());container.remove();}
});

it("面板组折叠写入工作区偏好并在重挂载后恢复",()=>{
  localStorage.removeItem(PANEL_LAYOUT_KEY);
  const container=document.createElement("div");document.body.append(container);let root=createRoot(container);
  const Harness=()=>{const display=useEditorDisplay();return <EditorSidebar display={display} disabled={false} layers={<div/>} history={<div/>} properties={<div/>} color={<div/>}/>;};
  try {
    act(()=>root.render(<Harness/>));
    act(()=>container.querySelector<HTMLButtonElement>('[data-panel-group="color"] .photo-editor__panel-group-toggle')!.click());
    expect(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)!).collapsedGroups).toEqual({color:true});
    act(()=>root.unmount());root=createRoot(container);act(()=>root.render(<Harness/>));
    expect(container.querySelector('[data-panel-group="color"]')?.getAttribute("data-collapsed-group")).toBe("true");
  } finally {act(()=>root.unmount());container.remove();localStorage.removeItem(PANEL_LAYOUT_KEY);}
});

it("面板菜单实际排序/关闭，窗口入口重开指定Tab并保留输入节点；高度拖动取消恢复",()=>{
 localStorage.removeItem(PANEL_LAYOUT_KEY);const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let controls:ReturnType<typeof useEditorDisplay>;
 function Harness(){controls=useEditorDisplay();return <><button data-open onClick={()=>controls.showPanel?.("properties","adjustments")}>重开</button><EditorSidebar display={controls} disabled={false} color={<div/>} properties={<input data-input defaultValue="草稿"/>} history={<div/>} layers={<div/>}/></>;}
 const event=(target:HTMLElement,type:string,y=0)=>{const event=new MouseEvent(type,{button:0,buttons:type==="pointerdown"?1:0,bubbles:true,cancelable:true,clientY:y});Object.defineProperty(event,"pointerId",{value:1});act(()=>target.dispatchEvent(event));};
 const menu=(group:string,item:string)=>{const trigger=host.querySelector<HTMLElement>(`[data-panel-group="${group}"] .photo-editor__panel-group-menu`)!;event(trigger,"pointerdown");event(trigger,"pointerup");const row=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===item)!;expect(row).toBeTruthy();act(()=>row.click());};
 try{act(()=>root.render(<Harness/>));const input=host.querySelector('[data-input]');menu("properties","上移面板组");expect(controls!.state.panelLayout?.groupOrder.slice(0,2)).toEqual(["properties","color"]);
 menu("properties","关闭面板组");expect(host.querySelector<HTMLElement>('[data-panel-group="properties"]')!.hidden).toBe(true);
 act(()=>host.querySelector<HTMLButtonElement>('[data-open]')!.click());expect(host.querySelector<HTMLElement>('[data-panel-group="properties"]')!.hidden).toBe(false);expect(controls!.state.panelLayout?.activeTabs.properties).toBe("adjustments");expect(host.querySelector('[data-input]')).toBe(input);
 const section=host.querySelector<HTMLElement>('[data-panel-group="properties"]')!;section.getBoundingClientRect=()=>({height:200}) as DOMRect;const resizer=section.querySelector<HTMLElement>('.photo-editor__group-resizer')!;
 event(resizer,"pointerdown",100);event(resizer,"pointermove",140);expect(controls!.state.panelLayout?.groupHeights.properties).toBe(240);event(resizer,"pointercancel",140);expect(controls!.state.panelLayout?.groupHeights.properties).toBeUndefined();
 }finally{act(()=>root.unmount());host.remove();localStorage.removeItem(PANEL_LAYOUT_KEY);}
});
