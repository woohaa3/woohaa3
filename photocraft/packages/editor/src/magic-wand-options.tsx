import {ArithmeticInput} from "./arithmetic-input.js";
import type {MagicWandSettings} from "./photo-editor-tools.js";

/** 魔棒选项：取样容差与范围属于本机工具记忆，不写工程。 */
export function MagicWandOptions({value,onChange,disabled}:{value:MagicWandSettings;onChange:(patch:Partial<MagicWandSettings>)=>void;disabled:boolean}) {
 return <section className="photo-editor__options-group" aria-label="魔棒选项">
  <label>容差<ArithmeticInput invalidate min={0} max={255} step={1} disabled={disabled} value={String(value.tolerance)} onChange={event=>onChange({tolerance:Number(event.currentTarget.value)})}/></label>
  {([["antialias","抗锯齿"],["contiguous","连续区域"],["sampleAllLayers","所有图层取样"]] as const).map(([key,label])=><label key={key}><input type="checkbox" disabled={disabled} checked={value[key]} onChange={event=>onChange({[key]:event.currentTarget.checked})}/>{label}</label>)}
 </section>;
}
