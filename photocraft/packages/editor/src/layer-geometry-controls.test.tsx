/** @vitest-environment jsdom */
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {LayerGeometryControls,layerGeometryMatrix} from "./layer-geometry-controls.js";
import {MEASUREMENT_UNITS,measurementValue} from "./measurement-unit.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
it("位置与宽高沿左上锚点变换，锁比例、零尺寸和超限保护",()=>{
 const frame:[number,number,number,number]=[20,-10,120,40];
 expect(layerGeometryMatrix(frame,"x",-30,true)).toEqual([1,0,0,1,-50,0]);
 expect(layerGeometryMatrix(frame,"y",30,false)).toEqual([1,0,0,1,0,40]);
 expect(layerGeometryMatrix(frame,"width",200,true)).toEqual([2,0,0,2,-20,10]);
 expect(layerGeometryMatrix(frame,"height",100,false)).toEqual([1,0,0,2,0,10]);
 for(const value of [0,-1,.1,1601,Infinity,NaN])expect(layerGeometryMatrix(frame,"width",value,true)).toBeNull();
 expect(layerGeometryMatrix(frame,"x",1_000_001,false)).toBeNull();
 expect(layerGeometryMatrix([1,1,1,2],"x",3,false)).toBeNull();
});
it("七种单位按文档各轴换算，表达式确认和Enter后失焦只提交一次，Escape不写",()=>{
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn((_matrix:number[])=>true);
 const field=(key:string)=>node.querySelector<HTMLInputElement>(`[data-geometry-field="${key}"]`)!;
 const input=(key:string,value:string)=>act(()=>{const element=field(key);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});
 const key=(name:string)=>act(()=>field("width").dispatchEvent(new KeyboardEvent("keydown",{key:name,bubbles:true,cancelable:true})));
 for(const unit of MEASUREMENT_UNITS){
  act(()=>root.render(<LayerGeometryControls key={unit.id} frame={[20,10,120,60]} unit={unit.id} dpi={100} documentSize={{width:800,height:600}} disabled={false} linked onLinkedChange={()=>{}} onApply={apply}/>));
  input("width",String(measurementValue(200,unit.id,100,800)));key("Enter");act(()=>field("width").dispatchEvent(new FocusEvent("focusout",{bubbles:true})));
  apply.mock.lastCall![0].forEach((n:number,index:number)=>expect(n).toBeCloseTo([2,0,0,2,-20,-10][index],10));
 }
 expect(apply).toHaveBeenCalledTimes(7);
 act(()=>root.render(<LayerGeometryControls key="expression" frame={[20,10,120,60]} unit="pixels" dpi={100} documentSize={{width:800,height:600}} disabled={false} linked={false} onLinkedChange={()=>{}} onApply={apply}/>));
 input("width","2in");expect(apply).toHaveBeenCalledTimes(7);key("Enter");expect(apply.mock.lastCall![0]).toEqual([2,0,0,1,-20,0]);
 input("width","1/0");key("Enter");expect(apply).toHaveBeenCalledTimes(8);
 input("width","300");key("Escape");act(()=>field("width").dispatchEvent(new FocusEvent("focusout",{bubbles:true})));expect(field("width").value).toBe("100");expect(apply).toHaveBeenCalledTimes(8);
});
it("失败保留输入并可重试，输入法与只读不提交，锁比例切换后宽高独立",()=>{
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn((_matrix:number[])=>false);
 function Harness({disabled=false}:{disabled?:boolean}){const [linked,setLinked]=useState(true);return <LayerGeometryControls frame={[20,10,120,60]} unit="pixels" dpi={72} documentSize={{width:800,height:600}} disabled={disabled} linked={linked} onLinkedChange={setLinked} onApply={apply}/>;}
 const render=(disabled=false)=>act(()=>root.render(<Harness disabled={disabled}/>));render();
 const field=node.querySelector<HTMLInputElement>('[data-geometry-field="height"]')!;
 const input=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});
 const enter=(isComposing=false)=>act(()=>field.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing,bubbles:true,cancelable:true})));
 input("100");enter(true);expect(apply).not.toHaveBeenCalled();enter();expect(apply.mock.lastCall![0]).toEqual([2,0,0,2,-20,-10]);expect(field.value).toBe("100");
 act(()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());apply.mockReturnValue(true);enter();expect(apply.mock.lastCall![0]).toEqual([1,0,0,2,0,-10]);
 render(true);input("150");enter();expect(apply).toHaveBeenCalledTimes(2);
});
