import {ArithmeticInput} from "./arithmetic-input.js";
import type {StylePatternPreset} from "./editor-wasm.js";
import type {RetouchSettings,RetouchToolId} from "./retouch-tools.js";

const percentField=(label:string,value:number,onChange:(value:number)=>void,disabled:boolean,min=1,max=100)=>(
 <label key={label}>{label}<ArithmeticInput invalidate min={min} max={max} step={1} disabled={disabled} value={String(value)} onChange={event=>onChange(Number(event.currentTarget.value))}/></label>
);
const checkbox=(label:string,checked:boolean,onChange:(value:boolean)=>void,disabled:boolean)=>(
 <label key={label}><input type="checkbox" checked={checked} disabled={disabled} onChange={event=>onChange(event.currentTarget.checked)}/>{label}</label>
);
const selectField=<T extends string>(label:string,value:T,options:readonly (readonly [T,string])[],onChange:(value:T)=>void,disabled:boolean)=>(
 <label key={label}>{label}<select value={value} disabled={disabled} onChange={event=>onChange(event.currentTarget.value as T)}>{options.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
);

const TONE_RANGES=[["shadows","阴影"],["midtones","中间调"],["highlights","高光"]] as const;
const SAMPLING=[["continuous","连续取样"],["once","一次取样"],["backgroundSwatch","背景色板"]] as const;
const LIMITS=[["contiguous","连续"],["discontiguous","不连续"],["findEdges","查找边缘"]] as const;
const HEALING=[["contentAware","内容感知"],["createTexture","创建纹理"],["proximityMatch","近似匹配"]] as const;

/** 润饰工具参数；全部为本机工具设置，命令可用性与只读由调用者门禁。 */
export function RetouchOptions({tool,value,onChange,disabled,patterns,resolutionDpi=72}:{
  tool:RetouchToolId;value:RetouchSettings;onChange:(patch:Partial<RetouchSettings>)=>void;disabled:boolean;
  patterns:readonly StylePatternPreset[];resolutionDpi?:number;
}) {
  const size=(label="尺寸")=><label>{label}<ArithmeticInput invalidate units={{unit:"px",dpi:resolutionDpi}} min={1} max={5000} step={1} disabled={disabled} value={String(value.size)} onChange={event=>onChange({size:Number(event.currentTarget.value)})}/></label>;
  const strength=percentField("强度",value.strength,strength=>onChange({strength}),disabled);
  const common=[size(),percentField("硬度",value.hardness,hardness=>onChange({hardness}),disabled),percentField("不透明度",value.opacity,opacity=>onChange({opacity}),disabled)];
  const strokeTolerance=percentField("容差",value.tolerance,tolerance=>onChange({tolerance}),disabled,0,100);
  switch(tool){
    case "cloneStamp": return <section className="photo-editor__options-group" aria-label="仿制图章选项">
      {common}
      {checkbox("对齐",value.aligned,aligned=>onChange({aligned}),disabled)}
      {selectField("取样",value.sampleLayer,[["current","当前图层"],["currentAndBelow","当前及下方"],["all","所有图层"]],sampleLayer=>onChange({sampleLayer}),disabled)}
      <p>Alt/Option 单击画布取样；来源也可在「克隆源」面板中设置五个槽位。</p>
    </section>;
    case "healingBrush": return <section className="photo-editor__options-group" aria-label="修复画笔选项">
      {common}
      {checkbox("对齐",value.aligned,aligned=>onChange({aligned}),disabled)}
      {selectField("取样",value.sampleLayer,[["current","当前图层"],["currentAndBelow","当前及下方"],["all","所有图层"]],sampleLayer=>onChange({sampleLayer}),disabled)}
      <p>Alt/Option 单击画布取样；释放时与目标周边融合并作为一步历史提交。</p>
    </section>;
    case "colorReplacement": return <section className="photo-editor__options-group" aria-label="颜色替换选项">
      {common}
      {selectField("模式",value.mode,[["hue","色相"],["saturation","饱和度"],["color","颜色"],["luminosity","明度"]],mode=>onChange({mode}),disabled)}
      {selectField("取样",value.sampling,SAMPLING,sampling=>onChange({sampling}),disabled)}
      {selectField("限制",value.limits,LIMITS,limits=>onChange({limits}),disabled)}
      {strokeTolerance}{checkbox("抗锯齿",value.antiAlias,antiAlias=>onChange({antiAlias}),disabled)}
    </section>;
    case "mixer": return <section className="photo-editor__options-group" aria-label="混合画笔选项">
      {common}
      {percentField("湿度",value.wet,wet=>onChange({wet}),disabled)}
      {percentField("载入",value.load,load=>onChange({load}),disabled)}
      {percentField("混合",value.mix,mix=>onChange({mix}),disabled)}
      {percentField("流量",value.flow,flow=>onChange({flow}),disabled)}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
      {checkbox("每次描边后清洁画笔",value.cleanAfterStroke,cleanAfterStroke=>onChange({cleanAfterStroke}),disabled)}
      {checkbox("每次描边后载入画笔",value.loadAfterStroke,loadAfterStroke=>onChange({loadAfterStroke}),disabled)}
    </section>;
    case "patternStamp": return <section className="photo-editor__options-group" aria-label="图案图章选项">
      {common}
      <label>图案<select value={value.pattern} disabled={disabled || !patterns.length} onChange={event=>onChange({pattern:event.currentTarget.value})}><option value="">选择图案</option>{patterns.map(pattern=><option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}</select></label>
      {!patterns.length?<span>暂无图案，可先在图层样式的图案库中导入 PAT。</span>:null}
      {checkbox("对齐",value.aligned,aligned=>onChange({aligned}),disabled)}
      {checkbox("印象派",value.impressionist,impressionist=>onChange({impressionist}),disabled)}
      {percentField("缩放",value.scale,scale=>onChange({scale}),disabled,1,1000)}
      <label>角度（°）<ArithmeticInput invalidate min={-360} max={360} step="any" units={{unit:"°"}} disabled={disabled} value={String(value.angle)} onChange={event=>onChange({angle:Number(event.currentTarget.value)})}/></label>
    </section>;
    case "historyBrush": return <section className="photo-editor__options-group" aria-label="历史记录画笔选项">
      {common}{percentField("流量",value.flow,flow=>onChange({flow}),disabled)}
      <label>来源状态<input type="number" min={0} placeholder="最早保留状态" value={value.historyState??""} disabled={disabled} onChange={event=>onChange({historyState:event.currentTarget.value===""?null:Math.max(0,Math.round(Number(event.currentTarget.value))||0)})}/></label>
      <p>来源状态使用当前文档的历史行；留空即最早保留状态。</p>
    </section>;
    case "dodge": case "burn": return <section className="photo-editor__options-group" aria-label={tool==="dodge"?"减淡选项":"加深选项"}>
      {common}
      {selectField("范围",value.toneRange,TONE_RANGES,toneRange=>onChange({toneRange}),disabled)}
      {percentField("曝光度",value.exposure,exposure=>onChange({exposure}),disabled)}
      {checkbox("保护色调",value.protectTones,protectTones=>onChange({protectTones}),disabled)}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
    </section>;
    case "sponge": return <section className="photo-editor__options-group" aria-label="海绵选项">
      {common}
      {checkbox("饱和（关闭则去色）",value.saturate,saturate=>onChange({saturate}),disabled)}
      {checkbox("振动增强",value.saturate,()=>onChange({saturate:!value.saturate}),disabled)}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
    </section>;
    case "blur": case "sharpen": case "smudge": return <section className="photo-editor__options-group" aria-label="局部画笔选项">
      {common}{strength}{percentField("流量",value.flow,flow=>onChange({flow}),disabled)}
      {tool==="sharpen"?checkbox("保护细节",value.protectDetail,protectDetail=>onChange({protectDetail}),disabled):null}
      {tool==="smudge"?checkbox("手指绘画",value.fingerPainting,fingerPainting=>onChange({fingerPainting}),disabled):null}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
    </section>;
    case "spotHealing": return <section className="photo-editor__options-group" aria-label="污点修复选项">
      {common}
      {selectField("类型",value.healingType,HEALING,healingType=>onChange({healingType}),disabled)}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
    </section>;
    case "redEye": return <section className="photo-editor__options-group" aria-label="红眼选项">
      {percentField("瞳孔大小",value.pupilSize,pupilSize=>onChange({pupilSize}),disabled)}
      {percentField("变暗量",value.darken,darken=>onChange({darken}),disabled,0,100)}
      <p>在瞳孔上单击；一次点击记一步历史。</p>
    </section>;
    case "magicEraser": return <section className="photo-editor__options-group" aria-label="魔术橡皮擦选项">
      {percentField("容差",value.tolerance,tolerance=>onChange({tolerance}),disabled,0,255)}
      {checkbox("抗锯齿",value.antiAlias,antiAlias=>onChange({antiAlias}),disabled)}
      {checkbox("连续",value.contiguous,contiguous=>onChange({contiguous}),disabled)}
      {checkbox("所有图层取样",value.sampleAllLayers,sampleAllLayers=>onChange({sampleAllLayers}),disabled)}
      {percentField("不透明度",value.opacity,opacity=>onChange({opacity}),disabled)}
      <p>单击按颜色清除相近像素；一次点击记一步历史。</p>
    </section>;
    case "backgroundEraser": return <section className="photo-editor__options-group" aria-label="背景橡皮擦选项">
      {common}
      {selectField("取样",value.sampling,SAMPLING,sampling=>onChange({sampling}),disabled)}
      {selectField("限制",value.limits,LIMITS,limits=>onChange({limits}),disabled)}
      {strokeTolerance}
      {checkbox("保护前景色",value.protectForegroundColor,protectForegroundColor=>onChange({protectForegroundColor}),disabled)}
    </section>;
  }
}

/** 选区运算控件由 App 复用；润饰工具沿用同一枚举。 */
export function RetouchSelectionMode({value,onChange,disabled}:{value:SelectionMode;onChange:(mode:SelectionMode)=>void;disabled:boolean}) {
  return <label>选区运算<select value={value} disabled={disabled} onChange={event=>onChange(event.currentTarget.value as SelectionMode)}>
    {([["replace","替换"],["add","增加"],["subtract","减去"],["intersect","相交"]] as const).map(([id,label])=><option key={id} value={id}>{label}</option>)}
  </select></label>;
}
