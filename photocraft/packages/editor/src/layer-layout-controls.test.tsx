/** @vitest-environment jsdom */
// DOM/命令状态检查，不读取、移动或绘制图片。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { LayerLayoutControls } from "./layer-layout-controls.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });
function setup(quick=false) {
  const kinds=["leftEdges","horizontalCenters","rightEdges","topEdges","verticalCenters","bottomEdges"];
  const commands = new Map([...kinds.map(kind=>`layer.align.${kind}`),...kinds.map(kind=>`layer.distribute.${kind}`),"layer.distribute.horizontally","layer.distribute.vertically"]
    .map(id=>[id,{id,allowed:true,enabled:true} as PhotocraftCommand]));
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const onCommand=vi.fn();
  const render=(readonly=false,hasSelection=true)=>act(()=>root.render(<LayerLayoutControls quick={quick} commands={commands} readonly={readonly} hasSelection={hasSelection} onCommand={onCommand}/>));
  render();
  const select=(value:string)=>act(()=>{const node=container.querySelector("select")!;node.value=value;node.dispatchEvent(new Event("change",{bubbles:true}));});
  return {container,commands,onCommand,render,select};
}
it("六种对齐使用同一明确参照，选区消失后回到自动参照",()=>{
  const {container,onCommand,select,render}=setup();
  const buttons=()=>[...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')];
  expect(buttons()).toHaveLength(6);
  for (const to of ["auto","layers","canvas","selection"]) {
    select(to);
    for (const button of buttons()) act(()=>button.click());
    expect(onCommand.mock.calls.slice(-6)).toEqual([
      "leftEdges","horizontalCenters","rightEdges","topEdges","verticalCenters","bottomEdges"
    ].map(kind=>[`layer.align.${kind}`,{to}]));
  }
  render(false,false);
  expect(container.querySelector("select")!.value).toBe("auto");
  expect(container.querySelector<HTMLOptionElement>('option[value="selection"]')!.disabled).toBe(true);
  act(()=>buttons()[0]!.click());expect(onCommand.mock.lastCall).toEqual(["layer.align.leftEdges",{to:"auto"}]);
});
it("分布菜单提供边缘、中心和等间距，按内核可用状态分派",()=>{
  const {container,commands,onCommand,render}=setup();
  commands.set("layer.distribute.leftEdges",{id:"layer.distribute.leftEdges",allowed:true,enabled:false} as PhotocraftCommand);render();
  const trigger=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="分布")!;
  act(()=>trigger.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  const items=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map(item=>item.textContent)).toEqual(["水平等间距","垂直等间距","左边缘分布","水平中心分布","右边缘分布","顶边缘分布","垂直中心分布","底边缘分布"]);
  expect(items[2]!.dataset.disabled).toBe("");
  act(()=>items[0]!.click());expect(onCommand.mock.lastCall).toEqual(["layer.distribute.horizontally"]);
});
it("未允许入口隐藏，暂不可用显示原因，只读阻止所有操作",()=>{
  const {container,commands,onCommand,render}=setup();
  commands.set("layer.align.leftEdges",{id:"layer.align.leftEdges",allowed:true,enabled:false,disabledReason:"图层已锁定"} as PhotocraftCommand);
  commands.set("layer.align.rightEdges",{id:"layer.align.rightEdges",allowed:false,enabled:true} as PhotocraftCommand);
  render();
  const left=container.querySelector<HTMLButtonElement>('[aria-label="左对齐"]')!;
  expect(left.disabled).toBe(true);expect(left.title).toBe("图层已锁定");
  expect(container.querySelector('[aria-label="右对齐"]')).toBeNull();
  act(()=>left.click());expect(onCommand).not.toHaveBeenCalled();
  render(true);for (const button of container.querySelectorAll<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
  expect(container.querySelector("select")!.disabled).toBe(true);
  commands.clear();render();expect(container.textContent).toBe("");
});

it("Move快速入口有六个按钮和14项菜单，自动参照优先选区并保留八种分布",()=>{
 const {container,onCommand,render}=setup(true);expect(container.querySelector("select")).toBeNull();
 const buttons=()=>[...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')];expect(buttons()).toHaveLength(6);
 for(const selection of [false,true]){render(false,selection);for(const button of buttons())act(()=>button.click());expect(onCommand.mock.calls.slice(-6)).toEqual(["leftEdges","horizontalCenters","rightEdges","topEdges","verticalCenters","bottomEdges"].map(kind=>[`layer.align.${kind}`,{to:selection?"selection":"auto"}]));}
 const open=()=>act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="对齐与分布")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
 open();const items=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];expect(items).toHaveLength(14);expect(items.slice(6).map(item=>item.textContent)).toEqual(["水平等间距","垂直等间距","左边缘分布","水平中心分布","右边缘分布","顶边缘分布","垂直中心分布","底边缘分布"]);
 act(()=>items[0]!.click());expect(onCommand.mock.lastCall).toEqual(["layer.align.leftEdges",{to:"selection"}]);open();act(()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][6]!.click());expect(onCommand.mock.lastCall).toEqual(["layer.distribute.horizontally"]);
 render(true);for(const button of container.querySelectorAll<HTMLButtonElement>("button"))expect(button.disabled).toBe(true);
});
