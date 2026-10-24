/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {BrushSettingsPanel,DEFAULT_BRUSH_DYNAMICS,brushDynamicsPatch,decodeBrushDynamics} from "./brush-settings-panel.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();});

it("严格解码原生 BrushSettings：缺失/越界回退默认，动态按百分比显示",()=>{
  expect(decodeBrushDynamics(null)).toEqual(DEFAULT_BRUSH_DYNAMICS);
  expect(decodeBrushDynamics({})).toEqual(DEFAULT_BRUSH_DYNAMICS);
  const value=decodeBrushDynamics({
    spacing:0.25,spacingEnabled:false,pressureSize:false,pressureOpacity:true,angle:45,roundness:0.5,
    flipX:true,noise:true,wetEdges:true,buildUp:true,buildUpRate:30,
    shapeDynamics:{enabled:true,size:{jitter:0.5,minimum:0.2}},
    scattering:{enabled:true,scatter:1.5,bothAxes:true},
    transfer:{enabled:true,opacity:{jitter:0.3},flow:{jitter:0.1}}
  });
  expect(value).toMatchObject({spacing:0.25,spacingEnabled:false,pressureSize:false,pressureOpacity:true,angle:45,roundness:0.5,
    flipX:true,noise:true,wetEdges:true,buildUp:true,buildUpRate:30,shapeDynamics:true,sizeJitter:50,sizeMinimum:20,
    scattering:true,scatter:150,scatterBothAxes:true,transfer:true,opacityJitter:30,flowJitter:10});
  // 越界与错误类型回退默认而不是变成 0。
  expect(decodeBrushDynamics({spacing:99,angle:999,roundness:5,buildUpRate:0,pressureSize:"yes"})).toEqual(DEFAULT_BRUSH_DYNAMICS);
});

it("编译补丁把百分比换算回原生比例并钳制",()=>{
  const patch=brushDynamicsPatch({...DEFAULT_BRUSH_DYNAMICS,spacing:0.4,angle:400,roundness:-1,sizeJitter:50,sizeMinimum:20,
    scatter:200,opacityJitter:30,flowJitter:10,buildUpRate:999});
  expect(patch.spacing).toBe(0.4);
  expect(patch.angle).toBe(180);
  expect(patch.roundness).toBe(0);
  expect(patch.shapeDynamics).toEqual({enabled:false,size:{jitter:0.5,minimum:0.2}});
  expect(patch.scattering).toEqual({enabled:false,scatter:{jitter:2},bothAxes:false});
  expect(patch.transfer).toEqual({enabled:false,opacity:{jitter:0.3},flow:{jitter:0.1}});
  expect(patch.buildUpRate).toBe(120);
});

it("面板只在启用某分区时显示其子字段，并在禁用时不派发",()=>{
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const onChange=vi.fn();
  const render=(value=DEFAULT_BRUSH_DYNAMICS,disabled=false)=>act(()=>root.render(<BrushSettingsPanel value={value} disabled={disabled} onChange={onChange}/>));
  render();
  const labels=()=>[...host.querySelectorAll("label")].map(node=>node.textContent?.replace(/\s.*/,""));
  expect(labels()).not.toContain("大小抖动（%）");
  expect(labels()).not.toContain("散布量（%）");
  expect(labels()).not.toContain("不透明度抖动（%）");
  render({...DEFAULT_BRUSH_DYNAMICS,shapeDynamics:true,scattering:true,transfer:true});
  expect(labels()).toEqual(expect.arrayContaining(["大小抖动（%）","最小直径（%）","散布量（%）","不透明度抖动（%）","流量抖动（%）"]));
  const toggle=(label:string)=>[...host.querySelectorAll("label")].find(node=>node.textContent===label)!.querySelector("input")!;
  act(()=>toggle("喷枪").click());
  expect(onChange).toHaveBeenLastCalledWith({buildUp:true});
  onChange.mockClear();
  render(DEFAULT_BRUSH_DYNAMICS,true);
  act(()=>[...host.querySelectorAll("label")].find(node=>node.textContent==="湿边")!.querySelector("input")!.click());
  expect(onChange).not.toHaveBeenCalled();
});
