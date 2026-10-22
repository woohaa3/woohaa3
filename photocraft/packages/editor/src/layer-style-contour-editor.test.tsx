/** @vitest-environment jsdom */
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it} from "vitest";
import {LayerStyleContourEditor} from "./layer-style-contour-editor.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";});
function setup(initial:unknown="Linear") {
  let value=initial;
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const samples=Array.from({length:256},(_,i)=>i/255);
  function Host(){const [state,setState]=useState(initial);return <LayerStyleContourEditor value={state} label="等高线" presets={[{name:"Linear",contour:"Linear"},{name:"Cone",contour:{Custom:{name:"锥形",points:[{input:0,output:0},{input:.5,output:1},{input:1,output:0}],corners:[false,true,false]}}},{name:"Invert",contour:{Custom:{name:"反相",points:[{input:0,output:1},{input:1,output:0}],corners:[false,false]}}}]} samples={samples} onChange={next=>{value=next;setState(next);}}/>;}
  act(()=>root.render(<Host/>));
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const select=(title:string,next:string)=>{const select=[...container.querySelectorAll("label")].find(label=>label.textContent?.startsWith(title))!.querySelector("select")!;act(()=>{select.value=title==="预设"?({Linear:"preset:0",Cone:"preset:1",Invert:"preset:2"}[next]??next):next;select.dispatchEvent(new Event("change",{bubbles:true}));});};
  const input=(title:string)=>[...container.querySelectorAll("label")].find(label=>label.textContent===title+"%")!.querySelector<HTMLInputElement>("input")!;
  const type=(input:HTMLInputElement,next:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,next);input.dispatchEvent(new Event("input",{bubbles:true}));});
  const svg=container.querySelector<SVGSVGElement>("svg")!;
  svg.getBoundingClientRect=()=>({left:0,top:0,width:160,height:160} as DOMRect);
  const pointer=(type:string,x:number,y:number)=>act(()=>{const event=new MouseEvent(type,{clientX:x,clientY:y,bubbles:true,cancelable:true,button:0});Object.defineProperty(event,"pointerId",{value:1});svg.dispatchEvent(event);});
  return {container,button,select,input,type,pointer,svg,value:()=>value as {Custom:{name:string;points:{input:number;output:number}[];corners:boolean[]}}};
}
it("预设、控制点和拐角使用原生快照，线性切换保留自定曲线",()=>{
  const ui=setup();
  expect(ui.svg.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(256);
  ui.select("预设","Cone");expect(ui.value().Custom.corners).toEqual([false,true,false]);
  ui.select("控制点","1");ui.type(ui.input("输出"),"75");expect(ui.value().Custom.points[1]?.output).toBe(.75);
  act(()=>ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(ui.value().Custom.corners).toEqual([false,false,false]);
  act(()=>ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(ui.value().Custom.corners).toEqual([false,true,false]);
  ui.select("预设","Linear");expect(ui.value()).toBe("Linear");ui.select("预设","Custom");expect(ui.value().Custom.points[1]?.output).toBe(.75);
  act(()=>ui.button("添加控制点").click());expect(ui.value().Custom.points).toHaveLength(4);
  act(()=>ui.button("删除控制点").click());expect(ui.value().Custom.points).toHaveLength(3);
  ui.type(ui.input("输入"),"");expect(ui.input("输入").value).toBe("");expect(ui.container.textContent).toContain("输入须递增且不重复");
});
it("图内加点、拖动释放坐标和指针取消只修改当前曲线",()=>{
  const ui=setup();
  ui.pointer("pointerdown",80,40);ui.pointer("pointerup",80,40);
  expect(ui.value().Custom.points[1]).toEqual({input:.5,output:.75});
  ui.pointer("pointerdown",80,40);ui.pointer("pointermove",96,64);ui.pointer("pointerup",112,80);
  expect(ui.value().Custom.points[1]).toEqual({input:.7,output:.5});
  const before=structuredClone(ui.value());
  ui.pointer("pointerdown",112,80);ui.pointer("pointermove",80,32);ui.pointer("pointercancel",80,32);expect(ui.value()).toEqual(before);
  act(()=>ui.svg.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true,cancelable:true})));
  expect(ui.value().Custom.points).toHaveLength(2);expect(ui.value().Custom.corners).toHaveLength(2);
});
