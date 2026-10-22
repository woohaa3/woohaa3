/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {LayerStylePatternLibrary} from "./layer-style-pattern-library.js";
import type {PatternLibraryActions} from "./use-layer-properties-editing.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup() {
  const library:PatternLibraryActions={ready:true,presets:[{key:"stable",id:"resource",name:"用户图案",width:16,height:16}],
    import:vi.fn(()=>true),rename:vi.fn(()=>true),remove:vi.fn(()=>true),export:vi.fn(()=>new Uint8Array([1,2]))};
  const picker=vi.fn();const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const render=(disabled=false)=>act(()=>root.render(<LayerStylePatternLibrary library={library} disabled={disabled} onPickerActive={picker}/>));
  render();const button=(label:string)=>[...container.querySelectorAll("button")].find(b=>b.textContent===label)!;
  return {library,picker,container,render,button};
}
it("管理选择与图层选择分离，重命名/删除使用稳定身份，默认项不出现在用户管理列表",()=>{
  const {library,container,button}=setup();
  expect(button("重命名图案").disabled).toBe(true);
  const select=container.querySelector("select")!;
  act(()=>{select.value="stable";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(library.rename).not.toHaveBeenCalled();expect(library.import).not.toHaveBeenCalled();
  const input=container.querySelector<HTMLInputElement>('input:not([type="file"])')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"新图案");input.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>button("重命名图案").click());expect(library.rename).toHaveBeenCalledWith("stable","新图案");
  act(()=>button("删除图案").click());expect(library.remove).toHaveBeenCalledWith("stable");
  expect(button("删除图案").disabled).toBe(true);expect(select.options.length).toBe(2);
});
it("文件载入检查大小，读取期间禁用操作，晚到文件不进入已禁用的编辑器",async()=>{
  const {library,picker,container,render,button}=setup();const input=container.querySelector<HTMLInputElement>("[data-pattern-file]")!;
  act(()=>button("载入图案…").click());expect(picker).toHaveBeenLastCalledWith(true);
  let resolve!:(value:ArrayBuffer)=>void;
  const arrayBuffer=vi.fn(()=>new Promise<ArrayBuffer>(done=>{resolve=done;}));
  Object.defineProperty(input,"files",{configurable:true,value:[{size:10,arrayBuffer}]});
  act(()=>input.dispatchEvent(new Event("change",{bubbles:true})));expect(button("载入图案…").disabled).toBe(true);
  render(true);await act(async()=>resolve(new ArrayBuffer(2)));expect(library.import).not.toHaveBeenCalled();
  render();Object.defineProperty(input,"files",{configurable:true,value:[{size:33*1024*1024,arrayBuffer}]});
  act(()=>input.dispatchEvent(new Event("change",{bubbles:true})));
  expect(arrayBuffer).toHaveBeenCalledOnce();expect(container.textContent).toContain("不能超过 32 MiB");
  Object.defineProperty(input,"files",{configurable:true,value:[{size:2,arrayBuffer:async()=>new Uint8Array([3,4]).buffer}]});
  await act(async()=>input.dispatchEvent(new Event("change",{bubbles:true})));
  expect(library.import).toHaveBeenCalledWith(new Uint8Array([3,4]));expect(container.textContent).toContain("选择应用");
  vi.mocked(library.import).mockClear();
  Object.defineProperty(input,"files",{configurable:true,value:[{size:2,arrayBuffer}]});
  act(()=>input.dispatchEvent(new Event("change",{bubbles:true})));
  library.owner={};render();await act(async()=>resolve(new ArrayBuffer(2)));
  expect(library.import).not.toHaveBeenCalled();expect(button("载入图案…").disabled).toBe(false);
});
it("保存 PAT 使用独立下载与资源回收，空库和读取状态没有失效入口",async()=>{
  const {library,picker,container,render,button}=setup();
  const create=vi.fn(()=>"blob:pattern"),revoke=vi.fn();vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:revoke});
  const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
  act(()=>button("保存图案库…").click());expect(library.export).toHaveBeenCalledWith(undefined);expect(click).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();expect(picker).toHaveBeenCalledWith(true);
  await new Promise(resolve=>setTimeout(resolve,10));expect(revoke).toHaveBeenCalledWith("blob:pattern");
  library.ready=false;render();expect(button("载入图案…").disabled).toBe(true);
  library.ready=true;library.presets=[];render();expect(button("保存图案库…").disabled).toBe(true);
  expect(container.querySelector("select")).toBeNull();
});
