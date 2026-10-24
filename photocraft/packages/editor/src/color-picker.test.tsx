/** @vitest-environment jsdom */
import {act} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";import {ColorPickerDialog,MAX_COLOR_SWATCHES,readColorSwatches,writeColorSwatches} from "./color-picker.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("本机色板写入 localStorage、去重、只接受 #rrggbb 并限制 256 项",()=>{
 try{
  localStorage.removeItem("photocraft.color-swatches.v1");
  expect(readColorSwatches()).toEqual([]);
  expect(writeColorSwatches(["#AABBCC","#aabbcc","#123456"])).toBe(true);
  expect(JSON.parse(localStorage.getItem("photocraft.color-swatches.v1")!)).toEqual(["#aabbcc","#123456"]);
  // 非法条目与损坏 JSON 都回退，不影响选择器。
  localStorage.setItem("photocraft.color-swatches.v1",JSON.stringify(["#aabbcc","red",7,null,"#112233"]));
  expect(readColorSwatches()).toEqual(["#aabbcc","#112233"]);
  localStorage.setItem("photocraft.color-swatches.v1","{not json");
  expect(readColorSwatches()).toEqual([]);
  // 上限：第 257 项被截断，返回值仍为已写入。
  const many=Array.from({length:MAX_COLOR_SWATCHES+5},(_,index)=>`#${index.toString(16).padStart(6,"0")}`);
  expect(writeColorSwatches(many)).toBe(true);
  expect(readColorSwatches()).toHaveLength(MAX_COLOR_SWATCHES);
  // 写入失败时返回 false，界面可提示「已在本次会话加入」。
  const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
  expect(writeColorSwatches(["#000000"])).toBe(false);
  spy.mockRestore();
 }finally{localStorage.removeItem("photocraft.color-swatches.v1");}
});
it("color candidates, web snapping, current restore and swatch actions stay local until confirm",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),apply=vi.fn(),close=vi.fn();
 const input=(field:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});const click=(label:string)=>act(()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===label)!.click());const submit=()=>act(()=>host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 try{act(()=>root.render(<ColorPickerDialog instance={{dialogId:"color",instanceId:"1"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial="#123456" apply={apply}/>));const hex=host.querySelector<HTMLInputElement>('input[type="text"]:not([data-numeric-input])')!;
 input(hex,"#aabbcc");expect(apply).not.toHaveBeenCalled();click("加入色板");expect(JSON.parse(localStorage.getItem("photocraft.color-swatches.v1")!)).toContain("#aabbcc");click("原色");expect(hex.value).toBe("#123456");
 input(hex,"#12");submit();expect(apply).not.toHaveBeenCalled();input(hex,"#123456");act(()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(hex.value).toBe("#003366");submit();expect(apply.mock.lastCall).toEqual(["#003366"]);click("取消");expect(close).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());host.remove();localStorage.removeItem("photocraft.color-swatches.v1");}
});
