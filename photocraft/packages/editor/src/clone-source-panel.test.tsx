/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {CloneSourcePanel,activeCloneSource} from "./clone-source-panel.js";
import {decodeCloneSourceList} from "./editor-wasm.js";
import type {CloneSourceList,EditorWorkspaceController} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();});

const source=(index:number,overrides:Partial<CloneSourceList["sources"][number]>={})=>({
  index, source:[10,20] as [number,number], anchor:null, offset:null, layer:2,
  width:100, height:100, linked:true, rotation:0, flipH:false, flipV:false, ...overrides
});
const snapshot=(active=0):CloneSourceList=>({
  active,
  sources:[source(0),source(1,{source:null}),source(2,{source:null}),source(3,{source:null}),source(4,{source:null})],
  overlay:{show:false,opacity:50,clipped:false,autoHide:false,invert:false,blend:"normal"}
});

function setup(initial:CloneSourceList=snapshot()) {
  let state=initial;
  const controller={
    cloneSources:vi.fn(()=>({ok:true as const,value:state})),
    cloneSourceSelect:vi.fn((index:number)=>{state={...state,active:index};return {ok:true as const,value:state.sources[index]!};}),
    cloneSourceSet:vi.fn((params:{index:number}&Record<string,unknown>)=>{const next={...state.sources[params.index]!,...params};state={...state,sources:state.sources.map(slot=>slot.index===params.index?next:slot)};return {ok:true as const,value:next};}),
    cloneSourceResetTransform:vi.fn((index:number)=>({ok:true as const,value:state.sources[index]!})),
    cloneSourceOverlay:vi.fn((params:Partial<CloneSourceList["overlay"]>)=>{state={...state,overlay:{...state.overlay,...params}};return {ok:true as const,value:state.overlay};})
  } as unknown as EditorWorkspaceController & {cloneSourceSet:ReturnType<typeof vi.fn>};
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const message=vi.fn();
  const render=(props:{visible?:boolean;disabled?:boolean;allowed?:boolean}={})=>act(()=>root.render(<CloneSourcePanel controller={controller} visible={props.visible??true} disabled={props.disabled??false} documentKey="doc-a" allowed={props.allowed??true} message={message}/>));
  return {controller,host,render,message,get:()=>state};
}

it("五个来源槽位显示取样状态并可切换活动槽",()=>{
  const {host,render,controller}=setup();
  render();
  const slots=[...host.querySelectorAll("[data-clone-slot]")];
  expect(slots).toHaveLength(5);
  expect(slots[0]!.getAttribute("data-selected")).toBe("true");
  expect(slots[0]!.getAttribute("title")).toContain("(10, 20)");
  expect(slots[1]!.getAttribute("title")).toContain("尚未取样");
  act(()=>slots[1]!.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(controller.cloneSourceSelect).toHaveBeenCalledWith(1);
  expect(host.querySelector('[data-clone-slot="1"]')!.getAttribute("data-selected")).toBe("true");
  // 切换后空槽位提示改为取样引导。
  expect(host.textContent).toContain("Alt/Option 单击画布取样来源");
});

it("变换字段、链接与叠层写入命令；命令未开放或只读时不显示/不派发",()=>{
  const {host,render,controller,message}=setup();
  render();
  const number=(label:string)=>[...host.querySelectorAll("label")].find(node=>node.textContent?.startsWith(label))!.querySelector("input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(number("宽 %"),"150");number("宽 %").dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>number("宽 %").dispatchEvent(new Event("change",{bubbles:true})));
  expect(controller.cloneSourceSet).toHaveBeenCalledWith(expect.objectContaining({index:0,width:150}));
  const toggle=(label:string)=>act(()=>[...host.querySelectorAll("label")].find(node=>node.textContent===label)!.querySelector("input")!.click());
  toggle("链接宽高");
  expect(controller.cloneSourceSet).toHaveBeenCalledWith({index:0,linked:false});
  toggle("水平翻转");
  expect(controller.cloneSourceSet).toHaveBeenCalledWith({index:0,flipH:true});
  toggle("反相");
  expect(controller.cloneSourceOverlay).toHaveBeenCalledWith({invert:true});
  expect(message).toHaveBeenLastCalledWith(null);
  act(()=>[...host.querySelectorAll("button")].find(node=>node.textContent==="重置变换")!.click());
  expect(controller.cloneSourceResetTransform).toHaveBeenCalledWith(0);
  // 只读时不派发命令。
  render({disabled:true});
  const before=controller.cloneSourceSet.mock.calls.length;
  act(()=>[...host.querySelectorAll("button")].find(node=>node.textContent==="清除来源")!.click());
  expect(controller.cloneSourceSet).toHaveBeenCalledTimes(before);
  // 命令未开放时整个面板不渲染。
  render({allowed:false});
  expect(host.querySelector("[data-clone-source-panel]")).toBeNull();
});

it("隐藏时不读取快照，切换文档后重新读取",()=>{
  const {controller,render}=setup();
  render({visible:false});
  expect(controller.cloneSources).not.toHaveBeenCalled();
  render();
  expect(controller.cloneSources).toHaveBeenCalledOnce();
});

it("严格解码原生克隆源快照：字段缺失、越界与非法叠层都拒绝",()=>{
  const good={active:1,sources:Array.from({length:5},(_,index)=>source(index,{source:null})),overlay:{show:true,opacity:40,clipped:true,autoHide:true,invert:false,blend:"darken"}};
  const decoded=decodeCloneSourceList(good);
  expect(decoded.active).toBe(1);expect(decoded.sources).toHaveLength(5);expect(decoded.overlay.blend).toBe("darken");
  expect(()=>decodeCloneSourceList({...good,sources:good.sources.slice(0,4)})).toThrow();
  expect(()=>decodeCloneSourceList({...good,active:5})).toThrow();
  expect(()=>decodeCloneSourceList({...good,overlay:{...good.overlay,blend:"multiply"}})).toThrow();
  expect(()=>decodeCloneSourceList({...good,overlay:{...good.overlay,opacity:150}})).toThrow();
  expect(()=>decodeCloneSourceList({...good,sources:[{...source(0),source:[1,"x"]},...good.sources.slice(1)]})).toThrow();
  expect(()=>decodeCloneSourceList(null)).toThrow();
});

it("活动槽位辅助函数在无快照时返回 null",()=>{
  expect(activeCloneSource(null)).toBeNull();
  expect(activeCloneSource(snapshot(2))?.index).toBe(2);
});
