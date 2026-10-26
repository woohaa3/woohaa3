/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {BrushPresetPanel,decodeBrushPresets,normalizePresetName} from "./brush-preset-panel.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();});

const rows=[
  {name:"圆 24",builtin:true,size:24,hardness:.8,tip:"round"},
  {name:"我的笔尖",builtin:false,size:40,hardness:.5,tip:"sampled"}
];

function setup(initial=rows as unknown) {
  let list=initial;
  const controller={
    brushPresets:vi.fn(()=>({ok:true as const,value:{presets:list}})),
    saveBrushPreset:vi.fn((name:string)=>{list=[...(list as typeof rows),{name,builtin:false,size:24,hardness:.8,tip:"round"}];return {ok:true as const,value:{name}};}),
    updateBrushPreset:vi.fn(()=>({ok:true as const,value:{}})),
    deleteBrushPreset:vi.fn((name:string)=>{list=(list as typeof rows).filter(row=>row.name!==name);return {ok:true as const,value:{}};}),
    setBrushPreset:vi.fn(()=>({ok:true as const,value:{}})),
    defineBrushFromSelection:vi.fn((name:string)=>({ok:true as const,value:{name}}))
  } as unknown as EditorWorkspaceController;
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const render=(props:{visible?:boolean;disabled?:boolean;canDefine?:boolean;onApplied?:()=>void;syncCurrent?:()=>{ok:boolean;message?:string}}={})=>act(()=>root.render(
    <BrushPresetPanel controller={controller} visible={props.visible??true} disabled={props.disabled??false}
      onApplied={props.onApplied} syncCurrent={props.syncCurrent} documentKey="doc" canDefineFromSelection={props.canDefine??true} defineBlockedReason="请先建立非空像素选区"/>));
  return {host,render,controller,get:()=>list};
}

it("列出预设并为内置项隐藏更新/删除，非内置项提供应用/更新/删除",()=>{
  const {host,render,controller}=setup();
  render();
  const items=[...host.querySelectorAll("[data-brush-preset]")];
  expect(items).toHaveLength(2);
  expect(items[0]!.getAttribute("data-builtin")).toBe("true");
  expect(items[0]!.querySelectorAll("button")).toHaveLength(1);
  expect(items[1]!.querySelectorAll("button")).toHaveLength(3);
  act(()=>[...items[1]!.querySelectorAll("button")].find(b=>b.textContent==="应用")!.click());
  expect(controller.setBrushPreset).toHaveBeenCalledWith("我的笔尖");
  act(()=>[...items[1]!.querySelectorAll("button")].find(b=>b.textContent==="更新")!.click());
  expect(controller.updateBrushPreset).toHaveBeenCalledWith("我的笔尖");
  act(()=>[...items[1]!.querySelectorAll("button")].find(b=>b.textContent==="删除")!.click());
  expect(controller.deleteBrushPreset).toHaveBeenCalledWith("我的笔尖");
});

it("命名后存储当前画笔并刷新列表；空白名称不派发",()=>{
  const {host,render,controller}=setup();
  render();
  const input=host.querySelector<HTMLInputElement>("input[type=text]")!;
  const store=[...host.querySelectorAll("button")].find(b=>b.textContent==="存储当前画笔") as HTMLButtonElement;
  expect(store.disabled).toBe(true);
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"新画笔");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(store.disabled).toBe(false);
  act(()=>store.click());
  expect(controller.saveBrushPreset).toHaveBeenCalledWith("新画笔");
  expect(input.value).toBe("");
  expect(host.textContent).toContain("新画笔");
});

it("从选区定义在缺少选区时禁用并给出原因；有选区时提交名称",()=>{
  const {host,render,controller}=setup();
  render({canDefine:false});
  const define=[...host.querySelectorAll("button")].find(b=>b.textContent==="从选区定义…") as HTMLButtonElement;
  expect(define.disabled).toBe(true);
  expect(define.title).toContain("选区");
  render({canDefine:true});
  const input=host.querySelector<HTMLInputElement>("input[type=text]")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"选区笔尖");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const enabled=[...host.querySelectorAll("button")].find(b=>b.textContent==="从选区定义…") as HTMLButtonElement;
  act(()=>enabled.click());
  expect(controller.defineBrushFromSelection).toHaveBeenCalledWith("选区笔尖");
});

it("只读时不派发，隐藏时不读取",()=>{
  const {host,render,controller}=setup();
  render({visible:false});
  expect(controller.brushPresets).not.toHaveBeenCalled();
  render({disabled:true});
  expect(controller.brushPresets).toHaveBeenCalledOnce();
  act(()=>[...host.querySelectorAll("[data-brush-preset]")][1]!.querySelector("button")!.click());
  expect(controller.setBrushPreset).not.toHaveBeenCalled();
});

it("严格解码预设列表并规范化名称",()=>{
  expect(decodeBrushPresets({presets:rows as unknown})).toEqual(rows);
  expect(()=>decodeBrushPresets(null)).toThrow();
  expect(()=>decodeBrushPresets({})).toThrow();
  expect(()=>decodeBrushPresets({presets:[{name:"",builtin:false,size:24,hardness:.5,tip:"round"}]})).toThrow();
  expect(()=>decodeBrushPresets({presets:[{name:"a",builtin:false,size:0,hardness:.5,tip:"round"}]})).toThrow();
  expect(()=>decodeBrushPresets({presets:[{name:"a",builtin:false,size:24,hardness:.5}]})).toThrow();
  expect(normalizePresetName("  圆笔  ")).toBe("圆笔");
  expect(normalizePresetName("   ")).toBeNull();
  expect(normalizePresetName("x".repeat(129))).toBeNull();
  expect(normalizePresetName("x".repeat(128))).toHaveLength(128);
});

it("只有应用成功才回填参数，保存和更新先同步当前工具参数",()=>{
 const {host,render,controller}=setup(),onApplied=vi.fn(),syncCurrent=vi.fn(()=>({ok:true}));render({onApplied,syncCurrent});
 const buttons=()=>[...host.querySelector('[data-brush-preset="我的笔尖"]')!.querySelectorAll('button')];
 act(()=>buttons()[0]!.click());expect(onApplied).toHaveBeenCalledOnce();
 vi.mocked(controller.setBrushPreset).mockReturnValueOnce({ok:false,code:"failed",message:"无法应用"});act(()=>buttons()[0]!.click());expect(onApplied).toHaveBeenCalledOnce();
 act(()=>buttons()[1]!.click());expect(syncCurrent).toHaveBeenCalledOnce();expect(controller.updateBrushPreset).toHaveBeenCalledOnce();
 syncCurrent.mockReturnValueOnce({ok:false});act(()=>buttons()[1]!.click());expect(controller.updateBrushPreset).toHaveBeenCalledOnce();
});
