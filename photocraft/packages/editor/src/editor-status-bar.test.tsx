/** @vitest-environment jsdom */
import {act} from "react";import {createRoot,type Root} from "react-dom/client";import {afterEach,expect,it,vi} from "vitest";
import {ZoomField,DocumentStatus,parseZoomPercent} from "./editor-status-bar.js";import {decodeEditorState} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";localStorage.removeItem("photocraft.status-info.v1");});
function setup(){const host=document.createElement("div");document.body.append(host);root=createRoot(host);return host;}
it("缩放百分比拒绝空白/零/非数值，允许小数和百分号",()=>{expect(parseZoomPercent(" 125.5% ")).toBe(1.255);expect(parseZoomPercent("(100+50)%")).toBeNull();expect(parseZoomPercent("100%+50%")).toBe(1.5);expect(parseZoomPercent("200/2")).toBe(1);for(const text of ["","0%","-2","NaN","Infinity","10abc","0x10"])expect(parseZoomPercent(text)).toBeNull();});
it("输入确认只更新一次，非法失焦回退，方向键和原生滚轮不会传给宿主",()=>{
 const host=setup(),changed=vi.fn();act(()=>root.render(<ZoomField zoom={1} width={800} height={600} onChange={changed}/>));const input=host.querySelector("input")!;
 const edit=(text:string)=>{act(()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));});};
 edit("125.5%");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));expect(changed.mock.calls).toEqual([[1.255]]);
 edit("bad");act(()=>input.blur());expect(changed).toHaveBeenCalledTimes(1);expect(input.value).toBe("100%");
 edit("100%");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",shiftKey:true,bubbles:true})));expect(changed.mock.lastCall).toEqual([1.1]);
 const bubbled=vi.fn();host.addEventListener("wheel",bubbled);const event=new WheelEvent("wheel",{deltaY:1,bubbles:true,cancelable:true});act(()=>input.dispatchEvent(event));expect(event.defaultPrevented).toBe(true);expect(bubbled).not.toHaveBeenCalled();expect(changed.mock.lastCall).toEqual([.99]);
});
it("拖动消费最终位置，取消恢复起始倍率；状态选项持久化但不产生文档命令",()=>{
 const host=setup(),changed=vi.fn();act(()=>root.render(<ZoomField zoom={1} width={800} height={600} onChange={changed}/>));const input=host.querySelector("input")!;input.setPointerCapture=vi.fn();input.hasPointerCapture=()=>true;input.releasePointerCapture=vi.fn();
 const send=(type:string,x:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>input.dispatchEvent(event));};
 send("pointerdown",100);send("pointermove",110);send("pointerup",120);expect(changed.mock.calls).toEqual([[1.1],[1.2]]);
 send("pointerdown",100);send("pointermove",110);send("pointercancel",110);expect(changed.mock.lastCall).toEqual([1]);
 const doc=decodeEditorState({document:{width:800,height:600,resolution:300,mode:"RGB",depth:8,layers:[{id:1,kind:"raster"}],statusMetadata:{flatBytes:1440000,layeredBytes:1920000,profile:"sRGB"}}})!.document!;
 act(()=>root.render(<DocumentStatus document={doc} tool="铅笔"/>));const select=host.querySelector("select")!;act(()=>{select.value="tool";select.dispatchEvent(new Event("change",{bubbles:true}));});expect(host.textContent).toContain("铅笔");expect(localStorage.getItem("photocraft.status-info.v1")).toBe("tool");
 act(()=>{select.value="profile";select.dispatchEvent(new Event("change",{bubbles:true}));});expect(host.textContent).toContain("sRGB（8 bpc）");
});
