/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {TextInputOverlay} from "./text-input-overlay.js";
import {textFrameContains} from "./text-geometry.js";
import type {TextEditing} from "./use-text-editing.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";});
function setup(composing=false,escapeCommits=true) {
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const edit={composing,style:{text:"abcd"},selection:{start:1,end:3,direction:"forward"},geometry:{caret:[[0,0],[0,20]],selection:[],frame:[[0,0],[100,0],[100,20],[0,20]]},hit:vi.fn(()=>1),update:vi.fn(),select:vi.fn()} as unknown as TextEditing;
  const end=vi.fn();act(()=>root.render(<TextInputOverlay editing={edit} origin={{x:10,y:10}} zoom={2} disabled={false} escapeCommits={escapeCommits} onEnd={end}/>));
  const overlay=host.querySelector<HTMLElement>(".photo-editor-text")!,input=host.querySelector("textarea")!;
  overlay.setPointerCapture=vi.fn();
  return {edit,end,overlay,input};
}
it("文字框外点击只提交，框内定位，组合输入时不提交",()=>{
  const {edit,end,overlay}=setup();
  const click=(x:number)=>act(()=>overlay.dispatchEvent(new MouseEvent("pointerdown",{clientX:x,clientY:20,button:0,bubbles:true,cancelable:true})));
  click(220);expect(end).toHaveBeenCalledWith(true);expect(edit.hit).not.toHaveBeenCalled();
  click(50);expect(edit.hit).toHaveBeenCalledWith([20,5],false,undefined,undefined);
});
it("Tab替换文字选择并更新插入点，ShiftTab与IME不插入",()=>{
  const {edit,input,end}=setup();
  const key=(options:KeyboardEventInit={})=>act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true,...options})));
  key();expect(edit.update).toHaveBeenCalledWith({text:"a\td"},{start:2,end:2,direction:"none"});expect(end).not.toHaveBeenCalled();
  key({shiftKey:true});key({isComposing:true});expect(edit.update).toHaveBeenCalledOnce();
});
it("组合输入不接受框外提交或Tab",()=>{
  const {edit,end,overlay,input}=setup(true);
  act(()=>overlay.dispatchEvent(new MouseEvent("pointerdown",{clientX:220,clientY:20,button:0,bubbles:true})));
  act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true})));
  expect(end).not.toHaveBeenCalled();expect(edit.update).not.toHaveBeenCalled();
});
it("旋转文字框采用实际四边形，无布局不猜测",()=>{
  const frame:[[number,number],[number,number],[number,number],[number,number]]=[[10,0],[20,10],[10,20],[0,10]];
  expect(textFrameContains(frame,[10,10])).toBe(true);expect(textFrameContains(frame,[1,1])).toBe(false);expect(textFrameContains(frame,[0,10])).toBe(true);expect(textFrameContains(undefined,[0,0])).toBeNull();
});

it.each([true,false])("Escape提交偏好=%s，组合输入不结束",escapeCommits=>{
  const {input,end}=setup(false,escapeCommits);
  act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(end).toHaveBeenCalledWith(escapeCommits);
});

it("连续点击按插入点、词、行、段落、全文循环，点按释放不折叠多击选择",()=>{
  const {edit,overlay}=setup();overlay.hasPointerCapture=()=>false;const send=(type:string,x=40)=>{const event=new MouseEvent(type,{clientX:x,clientY:20,button:0,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>overlay.dispatchEvent(event));};
  for(let i=0;i<6;i++){send("pointerdown");send("pointerup");}
  expect(vi.mocked(edit.hit).mock.calls.map(call=>call[3])).toEqual([undefined,"word","line","paragraph","all",undefined]);
  send("pointerdown",80);send("pointerup",80);expect(vi.mocked(edit.hit).mock.lastCall?.[3]).toBeUndefined();
});

it("IME underline consumes the native quadrilateral and transforms with the viewport",()=>{
 const {edit}=setup(true);edit.preeditGeometry=[[[10,0],[20,10],[10,20],[0,10]]];
 act(()=>root.render(<TextInputOverlay editing={edit} origin={{x:10,y:10}} zoom={2} disabled={false} onEnd={()=>{}}/>));
 const line=document.querySelector('[data-text-preedit="true"]');expect(line?.getAttribute("x1")).toBe("10");expect(line?.getAttribute("y1")).toBe("30");expect(line?.getAttribute("x2")).toBe("30");expect(line?.getAttribute("y2")).toBe("50");
 edit.composing=false;act(()=>root.render(<TextInputOverlay editing={edit} origin={{x:10,y:10}} zoom={2} disabled={false} onEnd={()=>{}}/>));expect(document.querySelector('[data-text-preedit="true"]')).toBeNull();
});
it("typed quotes convert but paste and composition keep literal text",()=>{
 const {edit,input}=setup();edit.style.text="";edit.selection={start:0,end:0,direction:"none"};
 const type=(inputType:string,isComposing=false)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,'"');input.setSelectionRange(1,1);input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType,data:'"',isComposing}));});
 type("insertText");expect(edit.update).toHaveBeenLastCalledWith({text:"“"},{start:1,end:1,direction:"none"});
 // Reset the DOM value so React receives another real input transition.
 input.value="";type("insertFromPaste");expect(edit.update).toHaveBeenLastCalledWith({text:'"'},{start:1,end:1,direction:"none"});
 input.value="";type("insertCompositionText",true);expect(edit.update).toHaveBeenLastCalledWith({text:'"'},{start:1,end:1,direction:"none"});
});
it("竖排沿文字流使用原生簇导航、左右换列，IME候选锚点跟随横向光标",()=>{ const {edit,input}=setup();edit.style.orientation="vertical";edit.geometry!.caret=[[0,0],[20,0]];edit.navigate=vi.fn();
 act(()=>root.render(<TextInputOverlay editing={edit} origin={{x:10,y:10}} zoom={2} disabled={false} onEnd={()=>{}}/>));
 expect(input.style.writingMode).toBe("vertical-rl");expect(input.style.width).toBe("40px");expect(input.style.height).toBe("1px");
 const key=(key:string,options:KeyboardEventInit={})=>act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options})));
 key("ArrowUp",{shiftKey:true});expect(edit.navigate).toHaveBeenLastCalledWith("charPrev",true);key("ArrowDown");expect(edit.navigate).toHaveBeenLastCalledWith("charNext",false);key("ArrowLeft");expect(edit.navigate).toHaveBeenLastCalledWith("lineNext",false);key("ArrowRight");expect(edit.navigate).toHaveBeenLastCalledWith("linePrev",false);key("ArrowDown",{altKey:true});expect(edit.navigate).toHaveBeenLastCalledWith("wordNext",false);
 const count=vi.mocked(edit.navigate).mock.calls.length;key("ArrowUp",{isComposing:true});expect(edit.navigate).toHaveBeenCalledTimes(count);
});

it("段落框出现八个手柄；拖动手柄只改草稿框，框外点击仍提交",()=>{
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const rect={x:10,y:10,width:100,height:40},transform=[1,0,0,1,0,0] as [number,number,number,number,number,number];
  const resizeBox=vi.fn(()=>true),end=vi.fn(),hit=vi.fn(()=>1);
  const edit={composing:false,style:{text:"abcd"},selection:{start:1,end:1,direction:"none"},
    geometry:{caret:[[10,10],[10,30]],selection:[],frame:[[10,10],[110,10],[110,50],[10,50]]},
    paragraphBox:{rect,transform},hit,update:vi.fn(),select:vi.fn(),resizeBox} as unknown as TextEditing;
  act(()=>root.render(<TextInputOverlay editing={edit} origin={{x:10,y:10}} zoom={2} disabled={false} onEnd={end}/>));
  const overlay=host.querySelector<HTMLElement>(".photo-editor-text")!,captured=new Set<number>();
  overlay.setPointerCapture=vi.fn((id:number)=>{captured.add(id);});overlay.hasPointerCapture=(id:number)=>captured.has(id);overlay.releasePointerCapture=vi.fn((id:number)=>captured.delete(id));
  expect(host.querySelectorAll("[data-text-box-handle]")).toHaveLength(8);
  const send=(type:string,x:number,y:number,extra:PointerEventInit={})=>{const event=new MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true,...extra});Object.defineProperty(event,"pointerId",{value:3});act(()=>overlay.dispatchEvent(event));};
  // 右中手柄在文档 (110,30) → 屏幕 (10+110*2,10+30*2)=(230,70)。
  send("pointerdown",230,70);
  expect(host.querySelector('[data-text-box-handle="5"]')?.getAttribute("data-active")).toBe("true");
  // 拖到文档 x=140 → 宽度 130；不结束输入。
  send("pointermove",290,70);
  expect(resizeBox).toHaveBeenLastCalledWith([10,10,130,40]);expect(end).not.toHaveBeenCalled();
  send("pointerup",290,70);
  expect(resizeBox).toHaveBeenLastCalledWith([10,10,130,40]);
  // 框外点击提交；框内仍然定位。
  send("pointerdown",600,70);expect(end).toHaveBeenCalledWith(true);
  send("pointerdown",100,70);expect(hit).toHaveBeenCalled();
  act(()=>root.unmount());host.remove();
});
