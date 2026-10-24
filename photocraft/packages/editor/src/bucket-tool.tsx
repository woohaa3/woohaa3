import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {StylePatternPreset} from "./editor-wasm.js";
import type {DocumentPoint} from "./photo-editor-tools.js";
export type BucketSettings={contents:"foreground"|"pattern";pattern:string;opacity:string;tolerance:string;antiAlias:boolean;contiguous:boolean;sampleAllLayers:boolean};
export const DEFAULT_BUCKET:BucketSettings={contents:"foreground",pattern:"",opacity:"100",tolerance:"32",antiAlias:true,contiguous:true,sampleAllLayers:false};
export function bucketParams(settings:BucketSettings,point:DocumentPoint,color:string,target:"pixels"|"mask") {
 const {opacity,tolerance,pattern,...rest}=settings;
 if(!opacity.trim() || !tolerance.trim() || !Number.isFinite(Number(opacity)) || !Number.isFinite(Number(tolerance)) || Number(opacity)<1 || Number(opacity)>100 || Number(tolerance)<0 || Number(tolerance)>255 || settings.contents==="pattern" && !settings.pattern)return null;
 return {...rest,...(settings.contents==="pattern"?{pattern}:{}),...point,color,target,opacity:Number(opacity),tolerance:Number(tolerance)};
}
export function BucketOptions({controller,value,onChange,disabled}:{controller:EditorWorkspaceController;value:BucketSettings;onChange:(patch:Partial<BucketSettings>)=>void;disabled:boolean}) {
 const [patterns,setPatterns]=useState<StylePatternPreset[]>([]),[error,setError]=useState<string|null>(null);
 useEffect(()=>{const result=controller.patternLibrary();if(result.ok){setPatterns([...result.value.presets,...(result.value.patternPresets??[])]);setError(null);}else setError(result.message);},[controller]);
 return <section className="photo-editor__options-group" aria-label="油漆桶选项">
 <label>填充<select disabled={disabled} value={value.contents} onChange={event=>onChange({contents:event.currentTarget.value as BucketSettings["contents"]})}><option value="foreground">前景色</option><option value="pattern">图案</option></select></label>
 {value.contents==="pattern"?<><label>图案<select disabled={disabled || !patterns.length} value={value.pattern} onChange={event=>onChange({pattern:event.currentTarget.value})}><option value="">选择图案</option>{patterns.map(pattern=><option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}</select></label>{!patterns.length?<span>{error??"暂无图案，可先在图层样式的图案库中导入 PAT。"}</span>:null}</>:null}
 <label>不透明度（%）<ArithmeticInput invalidate  min={1} max={100} step="any" disabled={disabled} value={value.opacity} onChange={event=>onChange({opacity:event.currentTarget.value})}/></label>
 <label>容差<ArithmeticInput invalidate  min={0} max={255} step="any" disabled={disabled} value={value.tolerance} onChange={event=>onChange({tolerance:event.currentTarget.value})}/></label>
 {([["antiAlias","抗锯齿"],["contiguous","连续区域"],["sampleAllLayers","所有图层取样"]] as const).map(([key,label])=><label key={key}><input type="checkbox" disabled={disabled} checked={value[key]} onChange={event=>onChange({[key]:event.currentTarget.checked})}/>{label}</label>)}
 </section>;
}
