/** @vitest-environment jsdom */
// 只验证真实面板的事件与内核投影，不绘制缩略图或采集图像。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {LayerPanel} from "./photo-editor-panels.js";
import {decodeEditorState} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});

function setup() {
  const nested={id:4,name:"内组",kind:"Group",expanded:false,children:[{id:5,name:"后代",kind:"Pixel"}]};
  const group={id:2,name:"组",kind:"Group",blend:"Pass Through",expanded:false,locks:{all:false},children:[nested,{id:3,name:"子层",kind:"Pixel"}]};
  const raw={width:16,height:16,activeLayer:2,selectedLayers:[3],layers:[{id:1,name:"源层",kind:"Pixel"},group]};
  const commands=new Map(["layer.new.group","layer.groupLayers","layer.ungroupLayers","layer.setExpanded","layer.moveTo"].map(id=>[id,{allowed:true,enabled:true} as PhotocraftCommand]));
  const onCommand=vi.fn(),onSelect=vi.fn(),onBlend=vi.fn();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const render=(readonly=false)=>act(()=>root.render(<LayerPanel view={decodeEditorState({document:raw})!} commands={commands} readonly={readonly}
    onCommand={onCommand} onSelect={onSelect} onBlend={onBlend} onToggleVisible={vi.fn()} onRename={vi.fn()} onAddMask={vi.fn()}
    opacityEditing={{value:"100",active:false,disabled:readonly,update:vi.fn(),finish:()=>true}}/>));
  render();
  const row=(id:number)=>container.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
  const transfer={effectAllowed:"",dropEffect:"",setData:vi.fn()};
  const drag=(target:Element,type:string,y=0)=>{
    const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientY:y});
    Object.defineProperty(event,"dataTransfer",{value:transfer});act(()=>target.dispatchEvent(event));return event;
  };
  return {container,raw,group,nested,render,row,drag,onCommand,onSelect,onBlend};
}

it("折叠只隐藏子行，保留完整层数和内核选择；展开与 Alt 全部切换不选层",()=>{
  const {container,row,group,nested,render,onCommand,onSelect}=setup();
  expect(container.querySelector(".photo-editor__panel-title > span:last-child")?.textContent).toBe("5");
  expect(row(3)).toBeNull();expect(row(4)).toBeNull();expect(row(5)).toBeNull();
  const toggle=row(2).querySelector<HTMLButtonElement>('[aria-label="展开组"]')!;
  act(()=>toggle.click());
  expect(onCommand.mock.lastCall).toEqual(["layer.setExpanded",{layer:2,expanded:true}]);
  expect(onSelect).not.toHaveBeenCalled();
  group.expanded=true;render();
  expect(row(3).classList.contains("photo-editor__layer--selected")).toBe(true);
  expect(row(4)).not.toBeNull();expect(row(5)).toBeNull();
  act(()=>row(4).querySelector<HTMLButtonElement>('[aria-label="展开组"]')!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
  expect(onCommand.mock.lastCall).toEqual(["layer.setExpanded",{layer:4,expanded:true,all:true}]);
  nested.expanded=true;render(true);
  expect(row(5)).not.toBeNull();
  expect(row(2).querySelector<HTMLButtonElement>('[aria-label="折叠组"]')!.disabled).toBe(true);
});

it("组行中央落点移入，顶部和底部落点保留同级重排",()=>{
  const {row,raw,render,drag,onCommand}=setup();
  raw.activeLayer=1;raw.selectedLayers=[1];render();
  vi.spyOn(row(2),"getBoundingClientRect").mockReturnValue({top:100,height:60} as DOMRect);
  for (const [y,position] of [[105,"above"],[130,"into"],[155,"below"]] as const) {
    drag(row(1).querySelector(".photo-editor__layer-name")!,"dragstart");
    expect(drag(row(2),"dragover",y).defaultPrevented).toBe(true);
    expect(row(2).dataset.dropPosition).toBe(position);
    drag(row(2),"drop",y);
    expect(onCommand.mock.lastCall).toEqual(["layer.moveTo",{layers:[1],target:2,position}]);
  }
  expect(onCommand).toHaveBeenCalledTimes(3);
});

it("拒绝祖先投向后代及移入锁定组，取消和只读清理拖动",()=>{
  const {row,raw,group,render,drag,onCommand}=setup();
  group.expanded=true;raw.selectedLayers=[2];render();
  drag(row(2).querySelector(".photo-editor__layer-name")!,"dragstart");
  expect(drag(row(3),"dragover").defaultPrevented).toBe(false);
  drag(row(3),"drop");expect(onCommand).not.toHaveBeenCalled();
  raw.activeLayer=1;raw.selectedLayers=[1];group.locks.all=true;render();
  vi.spyOn(row(2),"getBoundingClientRect").mockReturnValue({top:100,height:60} as DOMRect);
  drag(row(1).querySelector(".photo-editor__layer-name")!,"dragstart");
  expect(drag(row(2),"dragover",130).defaultPrevented).toBe(false);
  drag(row(2),"drop",130);expect(onCommand).not.toHaveBeenCalled();
  group.locks.all=false;render();
  drag(row(1).querySelector(".photo-editor__layer-name")!,"dragstart");render(true);render(false);
  drag(row(2),"drop",130);expect(onCommand).not.toHaveBeenCalled();
});

it("新建组使用能力门，穿透选项只提供给组",()=>{
  const {container,raw,render,onCommand,onBlend}=setup();
  act(()=>container.querySelector<HTMLButtonElement>('[aria-label="新建组"]')!.click());
  expect(onCommand.mock.lastCall).toEqual(["layer.new.group"]);
  const select=container.querySelector<HTMLSelectElement>('[title="混合模式"]')!;
  expect(select.value).toBe("Pass Through");
  expect(select.options).toHaveLength(28);
  expect([...select.options].find(option=>option.value==="Overlay")?.textContent).toBe("叠加");
  act(()=>{select.value="Overlay";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(onBlend.mock.lastCall).toEqual([expect.objectContaining({id:2}),"Overlay"]);
  act(()=>{select.value="Normal";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(onBlend.mock.lastCall).toEqual([expect.objectContaining({id:2}),"Normal"]);
  raw.activeLayer=1;render();
  expect([...select.options].some(option=>option.value==="Pass Through")).toBe(false);
  render(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="新建组"]')!.disabled).toBe(true);
});
