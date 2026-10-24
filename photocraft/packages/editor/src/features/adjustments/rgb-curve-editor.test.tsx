/** @vitest-environment jsdom */
// 只验证 DOM、参数和指针生命周期；不采集 SVG 或图片渲染。
import {act,cloneElement,useState,type ReactElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {RgbCurveEditor,type CurvePoint} from "../../rgb-curve-editor.js";
vi.mock("../../ui/Popover.js",()=>({Popover:({open,trigger,children,onOpenChange}: {open:boolean;trigger:ReactElement;children:ReactElement;onOpenChange:(open:boolean)=>void})=><>{cloneElement(trigger,{onClick:()=>onOpenChange(!open)})}{open?children:null}</>}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();});
function setup(editing=false) {
  const change=vi.fn(),end=vi.fn(()=>true),apply=vi.fn();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  function Harness(){const [points,setPoints]=useState<CurvePoint[]>([[0,0],[128,128],[255,255]]);return <RgbCurveEditor points={points} onChange={points=>{change(points);setPoints(points);}} readonly={false} editing={editing} onEnd={end} onApply={apply} samples={Array.from({length:256},(_,i)=>i)}/>;}
  act(()=>root.render(<Harness/>));act(()=>container.querySelector<HTMLButtonElement>("button")!.click());
  const graph=container.querySelector<SVGSVGElement>("svg")!;
  graph.getBoundingClientRect=()=>({left:0,top:0,width:255,height:255} as DOMRect);
  graph.setPointerCapture=vi.fn();graph.hasPointerCapture=()=>true;graph.releasePointerCapture=vi.fn();
  const send=(type:string,x:number,y:number)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:255-y});Object.defineProperty(event,"pointerId",{value:1});act(()=>graph.dispatchEvent(event));};
  const key=(target:Element,key:string)=>act(()=>target.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true})));
  return {container,graph,change,end,apply,send,key};
}
it("图上添加、选中拖动、约束相邻输入与 Delete 删除各自只结算一次",()=>{
  const {container,graph,change,end,send,key}=setup();
  send("pointerdown",60,100);send("pointermove",80,120);send("pointerup",80,120);
  expect(change).toHaveBeenLastCalledWith([[0,0],[80,120],[128,128],[255,255]]);
  expect(end.mock.calls).toEqual([[true]]);
  send("pointerdown",80,120);send("pointermove",180,160);send("pointerup",180,160);
  expect(change).toHaveBeenLastCalledWith([[0,0],[127,160],[128,128],[255,255]]);
  key(graph,"Delete");expect(change).toHaveBeenLastCalledWith([[0,0],[128,128],[255,255]]);
  expect(end).toHaveBeenCalledTimes(3);
  send("pointerdown",0,0);send("pointerup",0,0);change.mockClear();key(graph,"Delete");expect(change).not.toHaveBeenCalled();
  expect(container.querySelector("polyline")!.getAttribute("points")!.split(" ")).toHaveLength(256);
});
it("Esc 和指针取消恢复新建偏好，迟到移动与释放不补交",()=>{
  const {change,end,send,key,graph}=setup();
  send("pointerdown",128,128);send("pointermove",100,180);key(graph,"Escape");
  expect(change).toHaveBeenLastCalledWith([[0,0],[128,128],[255,255]]);
  send("pointermove",110,190);send("pointerup",110,190);expect(end.mock.calls).toEqual([[false]]);
  send("pointerdown",128,128);send("pointermove",90,180);send("pointercancel",90,180);
  expect(change).toHaveBeenLastCalledWith([[0,0],[128,128],[255,255]]);
  expect(end.mock.calls).toEqual([[false],[false]]);
});
it("数值非法时不能关闭或确认，修正后 Enter 结算，输入框删除不删控制点",()=>{
  const {container,change,end,key}=setup(true);
  const input=container.querySelectorAll<HTMLInputElement>("input")[2]!;
  act(()=>input.focus());
  const type=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  type("0");key(input,"Enter");expect(end).not.toHaveBeenCalled();
  expect(container.querySelector("polyline")).toBeNull();
  key(input,"Delete");expect(change).toHaveBeenCalledTimes(1);
  type("100");key(input,"Enter");expect(end.mock.calls).toEqual([[true]]);
});
it("已有曲线完成不创建图层，新建偏好只有明确点击才创建",()=>{
  const {container,send,apply}=setup(false);send("pointerdown",80,150);send("pointerup",80,150);
  expect(apply).not.toHaveBeenCalled();
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="新建曲线层")!.click());
  expect(apply).toHaveBeenCalledOnce();expect(container.querySelector("svg")).toBeNull();
});
it("inline 直接把曲线铺在面板里，不需要先点按钮（A4）",()=>{
  // 回归：曲线调整层的属性面板只有一行「RGB 曲线」按钮，曲线收在 Popover 后面；选中曲线层
  // 看不到图形也拖不动（2026-10-24 审片 A4）。inline 必须立刻渲染 svg。
  const change=vi.fn(),end=vi.fn(()=>true);
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  act(()=>root.render(<RgbCurveEditor points={[[0,0],[255,255]]} onChange={change} readonly={false} editing inline
    onEnd={end} samples={Array.from({length:256},(_,i)=>i)} onApply={()=>true}/>));
  expect(container.querySelector("svg[data-curve-graph]")).not.toBeNull();
  expect(container.querySelector("polyline")).not.toBeNull();
  // 没有触发按钮：图形不是 popover 内容。
  expect([...container.querySelectorAll("button")].some(button=>button.textContent==="RGB 曲线")).toBe(false);
});
it("点选邻近控制点不挪点，拖动保留松手时的最后坐标",()=>{
  const {change,send}=setup();
  send("pointerdown",130,130);send("pointerup",130,130);expect(change).not.toHaveBeenCalled();
  send("pointerdown",128,128);send("pointermove",100,160);send("pointerup",90,170);
  expect(change).toHaveBeenLastCalledWith([[0,0],[90,170],[255,255]]);
});
