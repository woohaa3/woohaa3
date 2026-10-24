/**
 * 画笔设置面板（I132）。
 *
 * 固定引擎的 `BrushSettings` 已经有完整的动态分区（形状动态、散布、纹理、双重画笔、颜色动态、
 * 传递、姿势、噪波、湿边、喷枪与锁定）。本面板只编辑其中可安全暴露的子集，并用
 * `tools.setBrush` 提交；预设仍是会话状态，不改工程内容。
 *
 * 纹理与双重画笔涉及图案资源与第二条笔尖，未在本批开放——面板不显示无效果的控件。
 */
import {ArithmeticInput} from "./arithmetic-input.js";
import type {NumericUnit} from "./numeric-expression.js";

/** 面板暴露的画笔动态字段（与原生 `ShapeDynamics`/`Scattering`/`Transfer` 同名子集）。 */
export type BrushDynamics = {
  spacing: number;
  spacingEnabled: boolean;
  pressureSize: boolean;
  pressureOpacity: boolean;
  angle: number;
  roundness: number;
  flipX: boolean;
  flipY: boolean;
  shapeDynamics: boolean;
  sizeJitter: number;
  sizeMinimum: number;
  scattering: boolean;
  scatter: number;
  scatterBothAxes: boolean;
  transfer: boolean;
  opacityJitter: number;
  flowJitter: number;
  noise: boolean;
  wetEdges: boolean;
  buildUp: boolean;
  buildUpRate: number;
};

export const DEFAULT_BRUSH_DYNAMICS: BrushDynamics = {
  spacing:0.1, spacingEnabled:true, pressureSize:true, pressureOpacity:false,
  angle:0, roundness:1, flipX:false, flipY:false,
  shapeDynamics:false, sizeJitter:0, sizeMinimum:0,
  scattering:false, scatter:0, scatterBothAxes:false,
  transfer:false, opacityJitter:0, flowJitter:0,
  noise:false, wetEdges:false, buildUp:false, buildUpRate:20
};

const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));

/** 严格解码原生 `brush.get`：缺失或越界的字段回退默认，不让半截数据变成零值。 */
export function decodeBrushDynamics(value:unknown):BrushDynamics {
  if(!value||typeof value!=="object")return DEFAULT_BRUSH_DYNAMICS;
  const raw=value as Record<string,unknown>;
  const record=(key:string)=>raw[key]&&typeof raw[key]==="object"?raw[key] as Record<string,unknown>:{};
  const number=(key:string,min:number,max:number,fallback:number,source:Record<string,unknown>=raw)=>{
    const candidate=source[key];
    return typeof candidate==="number"&&Number.isFinite(candidate)&&candidate>=min&&candidate<=max?candidate:fallback;
  };
  const flag=(key:string,fallback:boolean,source:Record<string,unknown>=raw)=>{
    const candidate=source[key];
    return typeof candidate==="boolean"?candidate:fallback;
  };
  const shape=record("shapeDynamics"),scatter=record("scattering"),transfer=record("transfer");
  const dynamic=(source:Record<string,unknown>,key:string)=>{
    const entry=source[key];
    if(!entry||typeof entry!=="object")return {jitter:0,minimum:0};
    const fields=entry as Record<string,unknown>;
    // 原生 `Dynamic.jitter` 是 0–1；面板按百分比显示。
    return {jitter:clamp(number("jitter",0,1,0,fields)*100,0,100),minimum:clamp(number("minimum",0,1,0,fields)*100,0,100)};
  };
  const sizeDynamic=dynamic(shape,"size");
  return {
    spacing:clamp(number("spacing",0.01,10,DEFAULT_BRUSH_DYNAMICS.spacing),0.01,10),
    spacingEnabled:flag("spacingEnabled",DEFAULT_BRUSH_DYNAMICS.spacingEnabled),
    pressureSize:flag("pressureSize",DEFAULT_BRUSH_DYNAMICS.pressureSize),
    pressureOpacity:flag("pressureOpacity",DEFAULT_BRUSH_DYNAMICS.pressureOpacity),
    angle:clamp(number("angle",-180,180,DEFAULT_BRUSH_DYNAMICS.angle),-180,180),
    roundness:clamp(number("roundness",0,1,DEFAULT_BRUSH_DYNAMICS.roundness),0,1),
    flipX:flag("flipX",false),flipY:flag("flipY",false),
    shapeDynamics:flag("enabled",false,shape),
    sizeJitter:sizeDynamic.jitter,sizeMinimum:sizeDynamic.minimum,
    scattering:flag("enabled",false,scatter),
    scatter:clamp(number("scatter",0,10,0,scatter)*100,0,1000),
    scatterBothAxes:flag("bothAxes",false,scatter),
    transfer:flag("enabled",false,transfer),
    opacityJitter:dynamic(transfer,"opacity").jitter,flowJitter:dynamic(transfer,"flow").jitter,
    noise:flag("noise",false),wetEdges:flag("wetEdges",false),
    buildUp:flag("buildUp",false),buildUpRate:clamp(number("buildUpRate",0.1,120,DEFAULT_BRUSH_DYNAMICS.buildUpRate),0.1,120)
  };
}

/** 编译成 `tools.setBrush` 的深合并补丁（原生按 camelCase 分区字段合并）。 */
export function brushDynamicsPatch(value:BrushDynamics):Record<string,unknown> {
  const dynamic=(jitter:number,minimum=0)=>({jitter:clamp(jitter,0,100)/100,...(minimum?{minimum:clamp(minimum,0,100)/100}:{})});
  return {
    spacing:clamp(value.spacing,0.01,10),spacingEnabled:value.spacingEnabled,
    pressureSize:value.pressureSize,pressureOpacity:value.pressureOpacity,
    angle:clamp(value.angle,-180,180),roundness:clamp(value.roundness,0,1),
    flipX:value.flipX,flipY:value.flipY,
    shapeDynamics:{enabled:value.shapeDynamics,size:dynamic(value.sizeJitter,value.sizeMinimum)},
    // `scatter` 原生是 1.0 = 100%，面板同样按百分比输入，因此这里不重复除以 100。
    scattering:{enabled:value.scattering,scatter:{jitter:clamp(value.scatter,0,1000)/100},bothAxes:value.scatterBothAxes},
    transfer:{enabled:value.transfer,opacity:dynamic(value.opacityJitter),flow:dynamic(value.flowJitter)},
    noise:value.noise,wetEdges:value.wetEdges,
    buildUp:value.buildUp,buildUpRate:clamp(value.buildUpRate,0.1,120)
  };
}

const number=(label:string,value:number,min:number,max:number,step:number,unit:NumericUnit|undefined,onCommit:(next:number)=>void,disabled:boolean,key:string)=>(
  <label key={key}>{label}
    <ArithmeticInput invalidate min={min} max={max} step={step} disabled={disabled}
      units={unit?{unit}:undefined} value={String(Math.round(value*100)/100)}
      onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>=min&&next<=max)onCommit(next);}}/>
  </label>
);
const toggle=(label:string,checked:boolean,onChange:(next:boolean)=>void,disabled:boolean,key:string)=>(
  <label key={key}><input type="checkbox" checked={checked} disabled={disabled} onChange={event=>onChange(event.currentTarget.checked)}/>{label}</label>
);

export function BrushSettingsPanel({value,disabled,onChange}:{value:BrushDynamics;disabled:boolean;onChange:(patch:Partial<BrushDynamics>)=>void}) {
  // 使用普通容器而不是新的选项分组：画笔设置是当前画笔选项的一部分，不应另起一个工具分组。
  return <section className="photo-editor__options-subgroup" aria-label="画笔设置" data-brush-settings="true">
    {number("间距（%）",value.spacing*100,1,1000,1,"%",next=>onChange({spacing:next/100}),disabled,"spacing")}
    {toggle("间距启用",value.spacingEnabled,next=>onChange({spacingEnabled:next}),disabled,"spacingEnabled")}
    {toggle("压力控制大小",value.pressureSize,next=>onChange({pressureSize:next}),disabled,"pressureSize")}
    {toggle("压力控制不透明度",value.pressureOpacity,next=>onChange({pressureOpacity:next}),disabled,"pressureOpacity")}
    {number("角度（°）",value.angle,-180,180,1,"°",next=>onChange({angle:next}),disabled,"angle")}
    {number("圆度（%）",value.roundness*100,0,100,1,"%",next=>onChange({roundness:next/100}),disabled,"roundness")}
    {toggle("水平翻转",value.flipX,next=>onChange({flipX:next}),disabled,"flipX")}
    {toggle("垂直翻转",value.flipY,next=>onChange({flipY:next}),disabled,"flipY")}
    {toggle("形状动态",value.shapeDynamics,next=>onChange({shapeDynamics:next}),disabled,"shapeDynamics")}
    {value.shapeDynamics?<>
      {number("大小抖动（%）",value.sizeJitter,0,100,1,"%",next=>onChange({sizeJitter:next}),disabled,"sizeJitter")}
      {number("最小直径（%）",value.sizeMinimum,0,100,1,"%",next=>onChange({sizeMinimum:next}),disabled,"sizeMinimum")}
    </>:null}
    {toggle("散布",value.scattering,next=>onChange({scattering:next}),disabled,"scattering")}
    {value.scattering?<>
      {number("散布量（%）",value.scatter,0,1000,1,"%",next=>onChange({scatter:next}),disabled,"scatter")}
      {toggle("双轴",value.scatterBothAxes,next=>onChange({scatterBothAxes:next}),disabled,"scatterBothAxes")}
    </>:null}
    {toggle("传递",value.transfer,next=>onChange({transfer:next}),disabled,"transfer")}
    {value.transfer?<>
      {number("不透明度抖动（%）",value.opacityJitter,0,100,1,"%",next=>onChange({opacityJitter:next}),disabled,"opacityJitter")}
      {number("流量抖动（%）",value.flowJitter,0,100,1,"%",next=>onChange({flowJitter:next}),disabled,"flowJitter")}
    </>:null}
    {toggle("杂色",value.noise,next=>onChange({noise:next}),disabled,"noise")}
    {toggle("湿边",value.wetEdges,next=>onChange({wetEdges:next}),disabled,"wetEdges")}
    {toggle("喷枪",value.buildUp,next=>onChange({buildUp:next}),disabled,"buildUp")}
    {value.buildUp?number("喷枪速率（次/秒）",value.buildUpRate,0.1,120,1,undefined,next=>onChange({buildUpRate:next}),disabled,"buildUpRate"):null}
  </section>;
}
