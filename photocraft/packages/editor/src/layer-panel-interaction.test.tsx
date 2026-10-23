/** @vitest-environment jsdom */
// 仅检查 DOM/事件和命令参数，不读取或绘制图像。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {LayerPanel} from "./photo-editor-panels.js";
import {decodeEditorState} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
function setup(selected=[3,2],readonly=false,locks:Record<number,Record<string,boolean>>={},clipped:number[]=[]) {
  const view=decodeEditorState({document:{width:16,height:16,activeLayer:3,selectedLayers:selected,
    layers:[3,2,1].map(id=>({id,name:`图层${id}`,kind:"pixel",locks:locks[id],clipped:clipped.includes(id)}))}})!;
  const commands=new Map(["layer.moveTo","layer.lockLayers","layer.setProps","layer.createClippingMask","layer.releaseClippingMask"].map(id=>[id,{allowed:true,enabled:true} as PhotocraftCommand]));
  const onSelect=vi.fn(),onCommand=vi.fn();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const render=(locked=readonly, filteredLayerIds: number[] | null = null)=>act(()=>root.render(<LayerPanel view={view} commands={commands} readonly={locked} filteredLayerIds={filteredLayerIds}
    onSelect={onSelect} onCommand={onCommand} onToggleVisible={vi.fn()} onBlend={vi.fn()} onRename={vi.fn()}
    onAddMask={vi.fn()} opacityEditing={{value:"100",active:false,disabled:locked,update:vi.fn(),finish:()=>true}}/>));
  render();
  const row=(id:number)=>container.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
  const name=(id:number)=>row(id).querySelector<HTMLButtonElement>(".photo-editor__layer-name")!;
  const transfer={effectAllowed:"",dropEffect:"",setData:vi.fn()};
  const drag=(target:Element,type:string,y=0)=>{
    const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientY:y});
    Object.defineProperty(event,"dataTransfer",{value:transfer});act(()=>target.dispatchEvent(event));return event;
  };
  return {container,row,name,onSelect,onCommand,drag,render};
}
it("多选显示来自内核，名字和内容缩略图按修饰键选择",()=>{
  const {container,row,name,onSelect}=setup();
  expect(container.textContent).toContain("已选 2 / 3");
  expect(row(2).classList.contains("photo-editor__layer--selected")).toBe(true);
  expect(row(2).classList.contains("photo-editor__layer--active")).toBe(false);
  for (const [target,modifiers,mode] of [
    [name(1),{shiftKey:true},"range"], [name(2),{ctrlKey:true},"toggle"],
    [row(1).querySelector('[data-edit-target="pixels"]')!,{metaKey:true},"toggle"],
    [name(3),{},"replace"]
  ] as const) {
    act(()=>target.dispatchEvent(new MouseEvent("click",{bubbles:true,...modifiers})));
    expect(onSelect.mock.lastCall?.[1]).toBe(mode);
  }
});
it("拖动所选集合按上下落点只分派一次重排；外部拖放和取消不提交",()=>{
  const {row,name,onSelect,onCommand,drag}=setup();
  vi.spyOn(row(1),"getBoundingClientRect").mockReturnValue({top:100,height:50} as DOMRect);
  drag(name(3),"dragstart");expect(onSelect).not.toHaveBeenCalled();
  expect(drag(row(1),"dragover",110).defaultPrevented).toBe(true);
  expect(row(1).dataset.dropPosition).toBe("above");
  drag(row(1),"drop",140);
  expect(onCommand.mock.calls).toEqual([["layer.moveTo",{layers:[3,2],target:1,position:"below"}]]);
  expect(row(1).dataset.dropPosition).toBeUndefined();
  drag(row(1),"drop",110);expect(onCommand).toHaveBeenCalledTimes(1);
  drag(name(3),"dragstart");drag(name(3),"dragend");drag(row(1),"drop");
  expect(onCommand).toHaveBeenCalledTimes(1);
});
it("未选中行拖动先替换选择，自身投放无操作；只读切换使旧拖动失效",()=>{
  const {row,name,onSelect,onCommand,drag,render}=setup();
  drag(name(1),"dragstart");expect(onSelect.mock.lastCall).toEqual([expect.objectContaining({id:1}),"replace"]);
  expect(drag(row(1),"dragover").defaultPrevented).toBe(false);
  drag(row(1),"drop");expect(onCommand).not.toHaveBeenCalled();
  drag(name(3),"dragstart");render(true);expect(name(3).draggable).toBe(false);
  render(false);drag(row(1),"drop");expect(onCommand).not.toHaveBeenCalled();
});

it("锁定显示所选集合的混合状态，批量操作和单层解锁使用明确目标",()=>{
  const {container,row,onCommand,render}=setup([3,2],false,{3:{position:true}});
  const position=container.querySelector<HTMLButtonElement>('[data-lock="position"]')!;
  expect(position.dataset.lockState).toBe("mixed");expect(position.title).toContain("部分已锁定");
  act(()=>position.click());expect(onCommand.mock.lastCall).toEqual(["layer.lockLayers",{position:true}]);
  const unlock=row(3).querySelector<HTMLButtonElement>('[aria-label="解锁图层"]')!;
  act(()=>unlock.click());expect(onCommand.mock.lastCall).toEqual(["layer.setProps",{layer:3,locks:{transparency:false,pixels:false,position:false,artboard:false,all:false}}]);
  expect(row(1).querySelector('[aria-label="解锁图层"]')).toBeNull();
  render(true);
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-lock], [aria-label="解锁图层"]')) expect(button.disabled).toBe(true);
});
it("全部锁定禁用属性与其他锁定输入，所选集合含锁定层时不能拖动",()=>{
  const {container,name,onCommand,drag}=setup([3,2],false,{3:{all:true}});
  expect(container.querySelector<HTMLSelectElement>('[title="混合模式"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[data-layer-opacity] input')!.disabled).toBe(true);
  for (const key of ["transparency","pixels","position"]) expect(container.querySelector<HTMLButtonElement>(`[data-lock="${key}"]`)!.disabled).toBe(true);
  expect(name(3).draggable).toBe(false);expect(name(2).draggable).toBe(false);expect(name(1).draggable).toBe(true);
  expect(drag(name(2),"dragstart").defaultPrevented).toBe(true);
  const all=container.querySelector<HTMLButtonElement>('[data-lock="all"]')!;
  expect(all.disabled).toBe(false);expect(all.dataset.lockState).toBe("mixed");
  act(()=>all.click());expect(onCommand.mock.lastCall).toEqual(["layer.lockLayers",{all:true}]);
});

it("剪贴状态在行内可见，创建使用集合命令；只读禁止操作",()=>{
  const {container,onCommand,render}=setup();
  expect(container.querySelector(".photo-editor__clipping-indicator")).toBeNull();
  const button=container.querySelector<HTMLButtonElement>(".photo-editor__clipping-action")!;
  expect(button.textContent).toBe("创建剪贴");act(()=>button.click());
  expect(onCommand.mock.lastCall).toEqual(["layer.createClippingMask"]);
  render(true);expect(button.disabled).toBe(true);
});
it("所选图层已剪贴时显示释放入口和关系标记",()=>{
  const {container,row,onCommand}=setup([3,2],false,{},[3]);
  expect(row(3).querySelector(".photo-editor__clipping-indicator")?.getAttribute("title")).toBe("剪贴到下方基底");
  expect(row(2).querySelector(".photo-editor__clipping-indicator")).toBeNull();
  const button=container.querySelector<HTMLButtonElement>(".photo-editor__clipping-action")!;
  expect(button.textContent).toBe("释放剪贴");act(()=>button.click());
  expect(onCommand.mock.lastCall).toEqual(["layer.releaseClippingMask"]);
});

it("过滤只改变列表；清空条件恢复列表",()=>{
  const {container,row,onSelect,onCommand,render}=setup();
  render(false,[1]);
  expect(row(1)).not.toBeNull();expect(row(2)).toBeNull();expect(row(3)).toBeNull();
  expect(container.querySelectorAll("[data-layer-id]")).toHaveLength(1);
  expect(onSelect).not.toHaveBeenCalled();expect(onCommand).not.toHaveBeenCalled();
  render(false,[]);expect(container.textContent).toContain("没有匹配的图层");
  render(false,null);expect(container.querySelectorAll("[data-layer-id]")).toHaveLength(3);
});
/**
 * U58：颜色标签与链接必须在图层行里看得见。
 *
 * 这两个状态只存在于内核视图模型里；面板若不投影，用户无法知道「这层已链接」「这层是蓝色标签」，
 * 也就无法在移动前判断会影响哪些层。
 */
it("图层行显示颜色标签与链接组标记，并可从动作区设置标签颜色",()=>{
  const view=decodeEditorState({document:{width:16,height:16,activeLayer:3,selectedLayers:[3],
    layers:[{id:3,name:"已链接",kind:"pixel",linkGroup:7,labelColor:"blue"},{id:2,name:"普通",kind:"pixel"}]}})!;
  const commands=new Map(["layer.setLabelColor"].map(id=>[id,{allowed:true,enabled:true} as PhotocraftCommand]));
  const onCommand=vi.fn();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  act(()=>root.render(<LayerPanel view={view} commands={commands} readonly={false} filteredLayerIds={null}
    onSelect={vi.fn()} onCommand={onCommand} onToggleVisible={vi.fn()} onBlend={vi.fn()} onRename={vi.fn()}
    onAddMask={vi.fn()} opacityEditing={{value:"100",active:false,disabled:false,update:vi.fn(),finish:()=>true}}/>));

  const linked=container.querySelector<HTMLElement>('[data-layer-id="3"]')!;
  const plain=container.querySelector<HTMLElement>('[data-layer-id="2"]')!;
  expect(linked.dataset.linkGroup).toBe("7");
  expect(plain.dataset.linkGroup).toBeUndefined();
  expect(linked.querySelector(".photo-editor__label-swatch")!.getAttribute("data-label")).toBe("blue");
  // 「无标签」不画色块，避免每行都有一个小方块。
  expect(plain.querySelector(".photo-editor__label-swatch")).toBeNull();

  // 动作区的图层颜色按钮开出的菜单项把所有标签色发成 `layer.setLabelColor`。
  const trigger=container.querySelector<HTMLButtonElement>('button[aria-label="图层颜色"]');
  expect(trigger).not.toBeNull();
  expect(trigger!.disabled).toBe(false);
});
