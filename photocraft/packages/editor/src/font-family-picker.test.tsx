import {recentFonts} from "./recent-fonts.js";
/** @vitest-environment jsdom */
import {act,useState} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";
import {FontFamilyPicker} from "./font-family-picker.js";import {UiProvider} from "./ui/UiProvider.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("关闭列表时累积滚轮逐项切换并夹紧，阻止宿主缩放；列表打开/禁用时不改字体",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),change=vi.fn(),bubble=vi.fn();host.addEventListener("wheel",bubble);
 function Probe({disabled=false}:{disabled?:boolean}){const [font,setFont]=useState<"Noto Sans SC"|"Inter">("Inter");return <UiProvider><FontFamilyPicker value={font} disabled={disabled} onChange={next=>{change(next);setFont(next);}}/></UiProvider>;}
 const wheel=(deltaY:number)=>{const event=new WheelEvent("wheel",{deltaY,bubbles:true,cancelable:true});act(()=>host.querySelector(".photo-editor__font-picker")!.dispatchEvent(event));return event;};
 try{act(()=>root.render(<Probe/>));expect(wheel(20).defaultPrevented).toBe(true);expect(change).not.toHaveBeenCalled();wheel(20);expect(change.mock.lastCall).toEqual(["Noto Sans SC"]);expect(bubble).not.toHaveBeenCalled();wheel(400);expect(change).toHaveBeenCalledOnce();wheel(-40);expect(change.mock.lastCall).toEqual(["Inter"]);
 await act(async()=>host.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));expect(document.querySelector('[role="menu"]')).not.toBeNull();wheel(40);expect(change).toHaveBeenCalledTimes(2);
 act(()=>root.render(<Probe disabled/>));wheel(40);expect(change).toHaveBeenCalledTimes(2);expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
 }finally{act(()=>root.unmount());host.remove();}
});

it("真实字体菜单Recent保留全部列表位置，搜索去重且同时匹配英文和本地名，关闭清空查询",async()=>{
 recentFonts.limit(0);const host=document.createElement("div");document.body.append(host);const root=createRoot(host),change=vi.fn();
 const render=(english=true,recentLimit=10)=>act(()=>root.render(<UiProvider><FontFamilyPicker value="Inter" disabled={false} english={english} recentLimit={recentLimit} onChange={change}/></UiProvider>));
 const open=async()=>{await act(async()=>host.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));};
 const items=()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
 try{
 render();await open();expect(items().map(item=>item.textContent)).toEqual(["Inter","Noto Sans SC"]);act(()=>items()[1].click());expect(change).toHaveBeenCalledWith("Noto Sans SC");
 await open();expect(items().map(item=>item.textContent)).toEqual(["Noto Sans SC","Inter","Noto Sans SC"]);expect(document.querySelector(".photo-editor__font-group")?.textContent).toBe("最近使用");
 const input=document.querySelector<HTMLInputElement>('.photo-editor__font-search')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"思源");input.dispatchEvent(new Event("input",{bubbles:true}));});expect(items().map(item=>item.textContent)).toEqual(["Noto Sans SC"]);expect(document.querySelector(".photo-editor__font-group")).toBeNull();
 act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));await open();expect(document.querySelector<HTMLInputElement>('.photo-editor__font-search')!.value).toBe("");
 render(false,0);expect(items().map(item=>item.textContent)).toContain("思源黑体");expect(document.querySelector(".photo-editor__font-group")).toBeNull();expect(recentFonts.snapshot()).toEqual([]);
 }finally{act(()=>root.unmount());host.remove();recentFonts.limit(0);}
});

it("字体样例使用原生Reader的五档尺寸与DPI，关闭不读取，失败无浏览器替代样例",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const read=vi.fn((_font:string,size:number,scale:number)=>({ok:true as const,value:{width:Math.round(100*size/18)*scale,height:Math.round(24*size/18)*scale,pixels:new Uint8Array(Math.round(100*size/18)*Math.round(24*size/18)*scale*scale*4)}}));
 const context={putImageData:vi.fn(),fillRect:vi.fn(),fillStyle:"",globalCompositeOperation:"source-over"};
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(context as never);
 vi.stubGlobal("devicePixelRatio",2);vi.stubGlobal("ImageData",class{constructor(public data:Uint8ClampedArray,public width:number,public height:number){}});
 const render=(preview:"off"|"small"|"medium"|"large"|"extraLarge"|"huge")=>act(()=>root.render(<UiProvider><FontFamilyPicker value="Inter" disabled={false} fontPreview={preview} readSample={read} recentLimit={0} onChange={()=>{}}/></UiProvider>));
 try{
  render("medium");await act(async()=>host.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
  expect(read.mock.calls.map(call=>call.slice(1))).toEqual([[18,2],[18,2]]);expect(document.querySelectorAll("canvas[data-font-sample]")).toHaveLength(2);expect(context.putImageData).toHaveBeenCalledTimes(2);
  for(const [preview,size] of [["small",14],["large",24],["extraLarge",32],["huge",40]] as const){render(preview);expect(read.mock.lastCall?.slice(1)).toEqual([size,2]);const canvas=document.querySelector<HTMLCanvasElement>("canvas[data-font-sample]")!;expect(canvas.style.height).toBe(`${Math.round(24*size/18)}px`);}
  const calls=read.mock.calls.length;render("off");expect(document.querySelector("canvas[data-font-sample]")).toBeNull();expect(read).toHaveBeenCalledTimes(calls);
  read.mockReturnValue({ok:false,code:"unavailable",message:"字体未加载"} as never);render("medium");expect(document.querySelector("canvas[data-font-sample]")).toBeNull();
 }finally{act(()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
