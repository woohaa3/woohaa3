export const SAMPLE_SIZES=[1,3,5,11,31,51,101] as const;
export const SAMPLE_LAYERS=[{id:"current",label:"当前图层"},{id:"currentAndBelow",label:"当前及下方图层"},{id:"all",label:"所有图层"},{id:"allNoAdjustments",label:"所有图层（排除调整）"},{id:"currentAndBelowNoAdjustments",label:"当前及下方（排除调整）"}] as const;
export type SampleSettings={size:number;sampleLayer:string};
export const DEFAULT_SAMPLE:SampleSettings={size:1,sampleLayer:"all"};
export function EyedropperOptions({value,onChange,disabled}:{value:SampleSettings;onChange:(value:SampleSettings)=>void;disabled:boolean}) {
 return <><label>取样尺寸<select value={value.size} disabled={disabled} onChange={event=>onChange({...value,size:Number(event.currentTarget.value)})}>{SAMPLE_SIZES.map(size=><option key={size} value={size}>{size===1?"点取样":`${size} × ${size} 平均`}</option>)}</select></label><label>取样来源<select value={value.sampleLayer} disabled={disabled} onChange={event=>onChange({...value,sampleLayer:event.currentTarget.value})}>{SAMPLE_LAYERS.map(source=><option key={source.id} value={source.id}>{source.label}</option>)}</select></label></>;
}
