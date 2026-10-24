/** @vitest-environment jsdom */
// 仅检查 DOM/事件和命令参数，不读取或绘制图像。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {LayerVisibilityEditing} from "./use-layer-visibility-editing.js";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {LayerPanel} from "./photo-editor-panels.js";
import {decodeEditorState} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
function setup(selected=[3,2],readonly=false,locks:Record<number,Record<string,boolean>>={},clipped:number[]=[],visibilityEditing?:LayerVisibilityEditing) {
  const view=decodeEditorState({document:{width:16,height:16,activeLayer:3,selectedLayers:selected,
    layers:[3,2,1].map(id=>({id,name:`图层${id}`,kind:"pixel",locks:locks[id],clipped:clipped.includes(id)}))}})!;
  const commands=new Map(["layer.moveTo","layer.lockLayers","layer.setProps","layer.createClippingMask","layer.releaseClippingMask"].map(id=>[id,{allowed:true,enabled:true} as PhotocraftCommand]));
  const onSelect=vi.fn(),onCommand=vi.fn(),onRename=vi.fn(),onToggleVisible=vi.fn(),onMask=vi.fn(),onEditContent=vi.fn(),onEditStyle=vi.fn(),onEditMask=vi.fn(),onTrashMask=vi.fn(),onFitLayer=vi.fn();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const render=(locked=readonly)=>act(()=>root.render(<LayerPanel view={view} commands={commands} readonly={locked}
    onSelect={onSelect} onCommand={onCommand} onToggleVisible={onToggleVisible} onBlend={vi.fn()} onRename={onRename}
    onFitLayer={onFitLayer} onTrashMask={onTrashMask} onMask={onMask} onEditContent={onEditContent} onEditStyle={onEditStyle} onEditMask={onEditMask} onAddMask={vi.fn()} visibilityEditing={visibilityEditing} opacityEditing={{value:"100",active:false,disabled:locked,update:vi.fn(),finish:()=>true}}/>));
  render();
  const row=(id:number)=>container.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
  const name=(id:number)=>row(id).querySelector<HTMLButtonElement>(".photo-editor__layer-name")!;
  const transfer={effectAllowed:"",dropEffect:"",setData:vi.fn()};
  const drag=(target:Element,type:string,y=0,altKey=false)=>{
    const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientY:y,altKey});
    Object.defineProperty(event,"dataTransfer",{value:transfer});act(()=>target.dispatchEvent(event));return event;
  };
  return {container,row,name,onSelect,onCommand,onRename,onToggleVisible,onMask,onEditContent,onEditStyle,onEditMask,onTrashMask,onFitLayer,drag,render,view,commands,transfer};
}

it("行内空白选择与整行/内容缩略图拖动共用命中；专用控件不触发选择或排序",()=>{
  const {row,onSelect,onCommand,drag}=setup();
  act(()=>row(1).dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true})));
  expect(onSelect.mock.calls).toEqual([[expect.objectContaining({id:1}),"range"]]);
  const eye=row(3).querySelector('[aria-label="隐藏图层"]')!;
  act(()=>eye.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(drag(eye,"dragstart").defaultPrevented).toBe(true);
  for(const source of [row(3),row(3).querySelector('[data-edit-target="pixels"]')!]) {
    drag(source,"dragstart");drag(row(1),"drop");
    expect(onCommand.mock.lastCall).toEqual(["layer.moveTo",{layers:[3,2],target:1,position:"below"}]);
  }
});

it("Alt 拖放复制集合，可在自身边缘复制；释放修饰键恢复移动，外部载荷不执行",()=>{
  const {row,name,drag,onCommand,transfer}=setup();
  vi.spyOn(row(3),"getBoundingClientRect").mockReturnValue({top:100,height:50} as DOMRect);
  expect(drag(row(3),"drop",110,true).defaultPrevented).toBe(false);
  drag(name(3),"dragstart");expect(transfer.effectAllowed).toBe("copyMove");
  expect(drag(row(3),"dragover",110,true).defaultPrevented).toBe(true);expect(transfer.dropEffect).toBe("copy");
  drag(row(3),"drop",110,true);
  expect(onCommand.mock.calls).toEqual([["layer.moveTo",{layers:[3,2],target:3,position:"above",copy:true}]]);
  drag(name(3),"dragstart");drag(row(1),"dragover",0,true);drag(row(1),"drop",0,false);
  expect(onCommand.mock.lastCall).toEqual(["layer.moveTo",{layers:[3,2],target:1,position:"below"}]);
});

it("连续重命名按可见行 Tab/Shift+Tab 导航并全选；边界/背景停止，Escape 不提交",()=>{
  const {container,name,row,onRename,view,render}=setup();
  const start=(id:number)=>act(()=>name(id).dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  const key=(value:string,shiftKey=false)=>act(()=>container.querySelector("li > input")!.dispatchEvent(new KeyboardEvent("keydown",{key:value,shiftKey,bubbles:true,cancelable:true})));
  start(3);
  expect(document.activeElement).toBe(row(3).querySelector("input"));
  expect((document.activeElement as HTMLInputElement).selectionEnd).toBe("图层3".length);
  key("Tab");expect(document.activeElement).toBe(row(2).querySelector("input"));
  key("Tab",true);expect(document.activeElement).toBe(row(3).querySelector("input"));
  key("Tab",true);expect(container.querySelector("li > input")).toBeNull();
  view.document!.layers.find(layer=>layer.id===1)!.background=true;render();
  start(2);key("Tab");expect(container.querySelector("li > input")).toBeNull();
  start(3);key("Escape");expect(container.querySelector("li > input")).toBeNull();expect(onRename).not.toHaveBeenCalled();
});

it("重命名提交失败留在当前字段；成功导航与 blur 只提交一次，IME 不结算",()=>{
  const {container,name,onRename}=setup();
  act(()=>name(3).dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  const input=container.querySelector<HTMLInputElement>("li > input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"新名称");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const key=(isComposing=false)=>act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",isComposing,bubbles:true,cancelable:true})));
  key(true);expect(onRename).not.toHaveBeenCalled();
  onRename.mockReturnValue(false);key();expect(document.activeElement).toBe(input);expect(onRename).toHaveBeenCalledTimes(1);
  onRename.mockReturnValue(true);key();expect(onRename).toHaveBeenCalledTimes(2);expect(container.querySelector("li > input")).not.toBe(input);
  act(()=>input.dispatchEvent(new FocusEvent("focusout",{bubbles:true})));expect(onRename).toHaveBeenCalledTimes(2);
});

it("背景标记由内核提供，双击与解锁使用同一转换；混合摘要按行显示且默认模式省略",()=>{
  const {container,row,name,view,commands,onCommand,onToggleVisible,render}=setup();
  const layer=view.document!.layers[0];layer.background=true;layer.locks.position=true;layer.effectiveLocks.position=true;layer.blend="Multiply";
  commands.set("layer.new.layerFromBackground",{allowed:true,enabled:true} as PhotocraftCommand);render();
  expect(row(3).querySelector(".photo-editor__layer-blend")?.textContent).toBe("正片叠底");expect(row(2).querySelector(".photo-editor__layer-blend")).toBeNull();
  act(()=>name(3).dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(container.querySelector("li > input")).toBeNull();expect(onCommand.mock.lastCall).toEqual(["layer.new.layerFromBackground",{layer:3}]);
  onCommand.mockClear();
  act(()=>row(3).dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(onCommand.mock.calls).toEqual([["layer.new.layerFromBackground",{layer:3}]]);
  act(()=>row(3).querySelector<HTMLButtonElement>('[aria-label="解锁图层"]')!.click());
  expect(onCommand.mock.lastCall).toEqual(["layer.new.layerFromBackground",{layer:3}]);
  act(()=>row(3).querySelector<HTMLButtonElement>('[aria-label="隐藏图层"]')!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
  expect(onToggleVisible.mock.lastCall).toEqual([expect.objectContaining({id:3}),{alt:true}]);
});
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


it("图层行右键对当前集合统一显隐，选择变化、只读和能力关闭使菜单失效",async()=>{
  const {row,commands,render,onCommand,onSelect,view}=setup();
  commands.set("layer.hideLayers",{allowed:true,enabled:true} as PhotocraftCommand);render();
  const context=async(id:number)=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));row(id).dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:100,clientY:100}));});};
  const item=()=>document.querySelector<HTMLElement>("[data-cursor-menu] .ui-menu__item")!;
  await context(3);expect(onSelect).not.toHaveBeenCalled();expect(item().textContent).toBe("隐藏所选图层");
  await act(async()=>item().click());expect(onCommand.mock.calls).toEqual([["layer.hideLayers"]]);
  view.document!.layers.forEach(layer=>{if(layer.selected || layer.active) layer.visible=false;});render();
  await context(2);expect(item().textContent).toBe("显示所选图层");
  commands.get("layer.hideLayers")!.enabled=false;render();expect(item().hasAttribute("data-disabled")).toBe(true);
  await act(async()=>item().click());expect(onCommand).toHaveBeenCalledTimes(1);
  view.document!.layers.find(layer=>layer.id===2)!.selected=false;render();expect(item()).toBeNull();
  commands.get("layer.hideLayers")!.enabled=true;render();await context(3);expect(item()).not.toBeNull();
  render(true);expect(item()).toBeNull();render(false);expect(item()).toBeNull();
  commands.get("layer.hideLayers")!.allowed=false;render();await context(3);expect(item()).toBeNull();
});


it("页脚接收本面板拖动集合，删除/复制/编组使用各自命令；外部、旧选择和关闭能力不提交",()=>{
  const {container,row,drag,commands,render,onCommand,view}=setup();
  for(const id of ["layer.new.layer","layer.new.group","layer.delete","layer.duplicate","layer.groupLayers"]) commands.set(id,{allowed:true,enabled:true} as PhotocraftCommand);
  render();
  const button=(label:string)=>container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  for(const [label,id] of [["新建图层","layer.duplicate"],["新建组","layer.groupLayers"],["删除图层","layer.delete"]]) {
    const target=button(label);
    drag(target,"drop");expect(onCommand).not.toHaveBeenCalled();
    drag(row(3),"dragstart");expect(drag(target,"dragover").defaultPrevented).toBe(true);
    expect(target.dataset.dropAction).toBe(id);drag(target,"drop");expect(onCommand.mock.calls).toEqual([[id]]);
    expect(target.dataset.dropAction).toBeUndefined();onCommand.mockClear();
  }
  drag(row(3),"dragstart");commands.get("layer.duplicate")!.allowed=false;render();
  expect(drag(button("新建图层"),"dragover").defaultPrevented).toBe(false);drag(button("新建图层"),"drop");expect(onCommand).not.toHaveBeenCalled();
  drag(row(3),"dragstart");view.document!.layers.find(layer=>layer.id===2)!.selected=false;render();
  drag(button("删除图层"),"drop");expect(onCommand).not.toHaveBeenCalled();
  drag(row(3),"dragstart");render(true);render(false);drag(button("删除图层"),"drop");expect(onCommand).not.toHaveBeenCalled();
});


it("眼睛列扫动跨过快速移动遗漏行，释放只确认一次；Escape、取消与只读回退且抑制点击",()=>{
  const visibility={active:true,begin:vi.fn(()=>true),preview:vi.fn(),finish:vi.fn(()=>true)};
  const {row,render,onToggleVisible}=setup([3,2],false,{},[],visibility);
  [3,2,1].forEach((id,index)=>vi.spyOn(row(id),"getBoundingClientRect").mockReturnValue({top:100+30*index,bottom:130+30*index} as DOMRect));
  const eye=row(3).querySelector<HTMLButtonElement>('[aria-label="隐藏图层"]')!;
  const pointer=(type:string,y:number,altKey=false)=>{
    const event=new MouseEvent(type,{button:0,clientX:20,clientY:y,altKey,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>eye.dispatchEvent(event));
  };
  pointer("pointerdown",110);pointer("pointermove",111);expect(visibility.begin).not.toHaveBeenCalled();
  pointer("pointermove",180);expect(visibility.begin.mock.calls).toEqual([[3]]);expect(visibility.preview.mock.lastCall).toEqual([[3,2,1],false]);
  expect(row(2).querySelector('[aria-label="显示图层"]')).not.toBeNull();
  pointer("pointerup",180);act(()=>eye.click());expect(onToggleVisible).not.toHaveBeenCalled();expect(visibility.finish.mock.calls).toEqual([[true]]);
  pointer("pointerdown",110);pointer("pointermove",140);act(()=>eye.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));expect(visibility.finish.mock.lastCall).toEqual([false]);
  pointer("pointerup",140);expect(visibility.finish).toHaveBeenCalledTimes(2);
  pointer("pointerdown",110);pointer("pointermove",140);pointer("pointercancel",140);expect(visibility.finish.mock.lastCall).toEqual([false]);
  pointer("pointerdown",110);pointer("pointermove",140);render(true);expect(visibility.finish.mock.lastCall).toEqual([false]);
  render(false);pointer("pointerdown",110,true);pointer("pointermove",180,true);pointer("pointerup",180,true);expect(visibility.begin).toHaveBeenCalledTimes(4);
});

it("显隐扫动启动失败仍抑制浏览器派发的 click，不退化为正式显隐写入",()=>{
  const visibility={active:false,begin:vi.fn(()=>false),preview:vi.fn(),finish:vi.fn(()=>true)};
  const {row,onToggleVisible}=setup([3],false,{},[],visibility);
  const eye=row(3).querySelector<HTMLButtonElement>('[aria-label="隐藏图层"]')!;
  for(const [type,y] of [["pointerdown",10],["pointermove",40],["pointerup",40]] as const) {
    const event=new MouseEvent(type,{button:0,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>eye.dispatchEvent(event));
  }
  act(()=>eye.click());expect(visibility.begin).toHaveBeenCalledOnce();expect(onToggleVisible).not.toHaveBeenCalled();expect(visibility.finish).not.toHaveBeenCalled();
});

it("列表空白取消图层选择，普通新建立即创建，Alt 打开选项，Mod 在下方创建",()=>{
  const {container,commands,render,onCommand,row}=setup();
  for(const id of ["select.deselectLayers","layer.new.layer"]) commands.set(id,{allowed:true,enabled:true} as PhotocraftCommand);render();
  act(()=>container.querySelector<HTMLUListElement>(".photo-editor__layers")!.click());expect(onCommand.mock.lastCall).toEqual(["select.deselectLayers"]);
  act(()=>row(3).click());expect(onCommand).toHaveBeenCalledTimes(1);
  const button=container.querySelector<HTMLButtonElement>('[aria-label="新建图层"]')!;
  act(()=>button.click());expect(onCommand.mock.lastCall).toEqual(["layer.new.layer",{}]);
  act(()=>button.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));expect(onCommand.mock.lastCall).toEqual(["layer.new.layer"]);
  act(()=>button.dispatchEvent(new MouseEvent("click",{bubbles:true,metaKey:true})));expect(onCommand.mock.lastCall).toEqual(["layer.new.layer",{position:"below"}]);
  commands.get("select.deselectLayers")!.allowed=false;render();const before=onCommand.mock.calls.length;
  act(()=>container.querySelector<HTMLUListElement>(".photo-editor__layers")!.click());expect(onCommand).toHaveBeenCalledTimes(before);
});

it("内核标签和链接状态投影到行及页脚，图层链接入口受能力和只读约束",()=>{
  const {container,row,view,commands,render,onCommand}=setup();
  view.document!.layers[0].labelColor="red";view.document!.layers[0].linkGroup=17;
  commands.set("layer.linkLayers",{allowed:true,enabled:true} as PhotocraftCommand);render();
  expect(row(3).dataset.layerLabel).toBe("red");expect(row(3).querySelector('[title="图层已链接"]')).not.toBeNull();
  const link=container.querySelector<HTMLButtonElement>('[aria-label="链接或取消链接图层"]')!;
  act(()=>link.click());expect(onCommand.mock.calls).toEqual([["layer.linkLayers"]]);render(true);expect(link.disabled).toBe(true);
});


it("已活动调整层的行名单击转向蒙版，内容缩略图仍选内容；背景缩略图 Mod 点击始终 replace",()=>{
  const {row,name,view,render,onSelect,onMask}=setup();const layer=view.document!.layers[0];layer.kind="adjustment";layer.hasMask=true;render();
  act(()=>name(3).click());expect(onMask.mock.lastCall).toEqual([expect.objectContaining({id:3}),{shift:false,alt:false}]);expect(onSelect).not.toHaveBeenCalled();
  act(()=>row(3).querySelector<HTMLButtonElement>('[data-edit-target="pixels"]')!.click());expect(onSelect.mock.lastCall?.[1]).toBe("replace");expect(onMask).toHaveBeenCalledOnce();
  act(()=>name(3).dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true})));expect(onSelect.mock.lastCall?.[1]).toBe("range");
  const background=view.document!.layers[2];background.background=true;render();
  act(()=>row(1).querySelector<HTMLButtonElement>('[data-edit-target="pixels"]')!.dispatchEvent(new MouseEvent("click",{bubbles:true,metaKey:true})));expect(onSelect.mock.lastCall).toEqual([expect.objectContaining({id:1}),"replace"]);
});
it("内容/样式/蒙版双击按目标分派，名称双击只重命名，背景只转换，控制器只读不启动编辑",()=>{
  const {container,row,name,view,commands,render,onEditContent,onEditStyle,onEditMask,onCommand}=setup();
  view.document!.layers[0].kind="text";view.document!.layers[1].kind="adjustment";view.document!.layers[1].hasMask=true;render();
  const dbl=(target:Element)=>act(()=>target.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  for(const id of [3,2]) dbl(row(id).querySelector('[data-edit-target="pixels"]')!);
  expect(onEditContent.mock.calls.map(args=>args[0].id)).toEqual([3,2]);expect(onEditStyle).not.toHaveBeenCalled();
  dbl(row(1));expect(onEditStyle.mock.lastCall?.[0].id).toBe(1);
  dbl(row(2).querySelector('[data-edit-target="mask"]')!);expect(onEditMask.mock.lastCall?.[0].id).toBe(2);expect(onEditStyle).toHaveBeenCalledOnce();
  dbl(name(3));expect(container.querySelector("li > input")).not.toBeNull();expect(onEditContent).toHaveBeenCalledTimes(2);
  act(()=>container.querySelector("li > input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  view.document!.layers[2].background=true;commands.set("layer.new.layerFromBackground",{allowed:true,enabled:true} as PhotocraftCommand);render();dbl(row(1).querySelector('[data-edit-target="pixels"]')!);expect(onCommand.mock.lastCall).toEqual(["layer.new.layerFromBackground",{layer:1}]);
  render(true);dbl(row(3));expect(onEditStyle).toHaveBeenCalledOnce();
});

it("蒙版拖动不冒泡为图层排序，只接收当前蒙版到垃圾桶；取消、目标改变与只读拒绝",()=>{
  const {container,row,view,commands,render,onTrashMask,onCommand,drag,onMask}=setup([3]);
  view.document!.layers[0].hasMask=true;view.document!.editTarget="mask";
  for(const id of ["layer.layerMask.delete","layer.delete","layer.new.layer"]) commands.set(id,{allowed:true,enabled:true} as PhotocraftCommand);render();
  const mask=row(3).querySelector<HTMLButtonElement>('[data-edit-target="mask"]')!,trash=container.querySelector<HTMLButtonElement>('[aria-label="删除图层"]')!,newLayer=container.querySelector<HTMLButtonElement>('[aria-label="新建图层"]')!;
  expect(mask.draggable).toBe(true);drag(mask,"dragstart");expect(onMask.mock.lastCall?.[0].id).toBe(3);
  expect(drag(newLayer,"dragover").defaultPrevented).toBe(false);expect(drag(trash,"dragover").defaultPrevented).toBe(true);expect(trash.dataset.dropAction).toBe("layer.layerMask.delete");
  drag(trash,"drop");expect(onTrashMask.mock.calls).toEqual([[3]]);expect(onCommand).not.toHaveBeenCalled();
  drag(mask,"dragstart");drag(mask,"dragend");drag(trash,"drop");expect(onTrashMask).toHaveBeenCalledOnce();
  drag(mask,"dragstart");view.document!.editTarget="pixels";render();drag(trash,"drop");expect(onTrashMask).toHaveBeenCalledOnce();
  view.document!.editTarget="mask";render();drag(mask,"dragstart");render(true);render(false);drag(trash,"drop");expect(onTrashMask).toHaveBeenCalledOnce();
});

it("Alt 分隔线命中相邻同级，眼睛/指示区和普通点击不被拦截，只读拒绝",()=>{
  const {row,view,commands,render,onCommand,onSelect}=setup();commands.set("layer.toggleClippingAt",{allowed:true,enabled:true} as PhotocraftCommand);render();
  for(const id of [3,2,1]) vi.spyOn(row(id),"getBoundingClientRect").mockReturnValue({left:0,right:280,top:(3-id)*52,bottom:(4-id)*52,height:52} as DOMRect);
  const click=(x:number,y:number,altKey=true)=>act(()=>row(2).dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,clientX:x,clientY:y,altKey})));
  click(100,54);expect(onCommand.mock.calls).toEqual([["layer.toggleClippingAt",{upper:3,lower:2}]]);expect(onSelect).not.toHaveBeenCalled();
  act(()=>row(2).dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:100,clientY:51,altKey:true})));expect(row(2).dataset.clipLine).toBe("create");
  act(()=>window.dispatchEvent(new KeyboardEvent("keyup",{key:"Alt"})));expect(row(2).dataset.clipLine).toBeUndefined();
  onCommand.mockClear();click(20,54);click(270,54);click(100,60);click(100,54,false);expect(onCommand).not.toHaveBeenCalled();
  view.document!.layers[0].parentId=99;render();click(100,54);expect(onCommand).not.toHaveBeenCalled();
  view.document!.layers[0].parentId=null;render(true);click(100,54);expect(onCommand).not.toHaveBeenCalled();
});

it("隔离列表只显示快照图层及其祖先，恢复不改变可见性且跨过滤分隔线无效",()=>{
  const {container,row,view,commands,render,onCommand}=setup();commands.set("select.isolateLayers",{allowed:true,enabled:true} as PhotocraftCommand);commands.set("layer.toggleClippingAt",{allowed:true,enabled:true} as PhotocraftCommand);
  view.document!.isolatedLayerIds=[3,1];render();expect(container.querySelector('[data-layer-id="2"]')).toBeNull();
  vi.spyOn(row(1),"getBoundingClientRect").mockReturnValue({left:0,right:280,top:52,height:52} as DOMRect);
  act(()=>row(1).dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:100,clientY:54,altKey:true})));expect(onCommand).not.toHaveBeenCalled();
  act(()=>[...container.querySelectorAll("button")].find(button=>button.textContent==="退出图层隔离")!.click());expect(onCommand.mock.lastCall).toEqual(["select.isolateLayers",{on:false}]);
  view.document!.layers[0].parentId=2;view.document!.isolatedLayerIds=[3];render();expect(row(2)).not.toBeNull();expect(container.querySelector('[data-layer-id="1"]')).toBeNull();
});

it("Ctrl/Cmd 缩略图载入透明度/蒙版，四种运算不改图层选择，背景保留 replace",()=>{
  const {row,commands,render,onCommand,onSelect,view,onMask}=setup();commands.set("select.loadSelection",{allowed:true,enabled:true} as PhotocraftCommand);view.document!.layers[0].hasMask=true;view.document!.layers[2].background=true;render();
  const click=(id:number,mask:boolean,shiftKey=false,altKey=false)=>act(()=>row(id).querySelector(`[data-edit-target="${mask?"mask":"pixels"}"]`)!.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true,shiftKey,altKey})));
  for(const [shift,alt,operation] of [[false,false,"new"],[true,false,"add"],[false,true,"subtract"],[true,true,"intersect"]] as const) {click(3,false,shift,alt);expect(onCommand.mock.lastCall).toEqual(["select.loadSelection",{layer:3,channel:"transparency",operation}]);}
  click(3,true);expect(onCommand.mock.lastCall).toEqual(["select.loadSelection",{layer:3,channel:"mask",operation:"new"}]);expect(onMask).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();
  click(1,false);expect(onSelect.mock.lastCall).toEqual([expect.objectContaining({id:1}),"replace"]);
  render(true);const count=onCommand.mock.calls.length;click(3,false);expect(onCommand).toHaveBeenCalledTimes(count);
});

it("Alt content-thumbnail requests a layer fit while Ctrl+Alt retains subtract-selection semantics",()=>{
 const {row,onFitLayer,onSelect,onCommand,commands}=setup();commands.set("select.loadSelection",{id:"select.loadSelection",allowed:true,enabled:true} as PhotocraftCommand);
 const thumb=row(2).querySelector('[data-edit-target="pixels"]')!;
 act(()=>thumb.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
 expect(onFitLayer).toHaveBeenCalledWith(expect.objectContaining({id:2}));expect(onSelect).not.toHaveBeenCalled();
 act(()=>thumb.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true,ctrlKey:true})));
 expect(onFitLayer).toHaveBeenCalledOnce();expect(onCommand).toHaveBeenLastCalledWith("select.loadSelection",{layer:2,channel:"transparency",operation:"subtract"});
});

it("图层种类与名称筛选只影响显示，保留祖先行与内核选择",()=>{
  const onCommand=vi.fn(),onSelect=vi.fn();
  const view=decodeEditorState({document:{width:16,height:16,activeLayer:1,selectedLayers:[1],
    layers:[{id:3,name:"调整",kind:"adjustment"},{id:2,name:"标题文字",kind:"type"},{id:1,name:"背景",kind:"pixel"}],
    isolatedLayers:[]}})!;
  const commands=new Map(["layer.moveTo"].map(id=>[id,{allowed:true,enabled:true} as PhotocraftCommand]));
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  act(()=>root.render(<LayerPanel view={view} commands={commands} readonly={false} onSelect={onSelect}
    onToggleVisible={()=>{}} onBlend={()=>{}} onRename={()=>true} onCommand={onCommand}
    onAddMask={()=>{}} opacityEditing={{value:"100",active:false,disabled:false,update:vi.fn(),finish:()=>true}}/>));
  // 名称单元格还带种类徽标，因此断言用「包含」而不是全等。
  const visibleNames=()=>[...container.querySelectorAll("[data-layer-id] .photo-editor__layer-name")].map(node=>node.textContent??"");
  expect(visibleNames()).toHaveLength(3);
  const select=container.querySelector<HTMLSelectElement>("[data-layer-filter] select")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"text");select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(visibleNames()).toHaveLength(1);expect(visibleNames()[0]).toContain("标题文字");
  act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"all");select.dispatchEvent(new Event("change",{bubbles:true}));});
  const input=container.querySelector<HTMLInputElement>("[data-layer-filter] input[type=search]")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"调整");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(visibleNames()).toHaveLength(1);expect(visibleNames()[0]).toContain("调整");
  // 筛选不派发选择或命令，也不改变文档。
  expect(onSelect).not.toHaveBeenCalled();expect(onCommand).not.toHaveBeenCalled();
});
