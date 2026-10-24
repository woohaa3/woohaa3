import {useState} from "react";
import {ArithmeticInput} from "./arithmetic-input.js";
import {Button} from "./ui/Button.js";
import {SELECTION_MODIFY_RANGES,clampSelectionRadius,buildSelectionModify,type SelectionModifyId} from "./photo-editor-tools.js";

/** 选区修改命令的公共半径控件；命令可用性与只读状态由调用者门禁。 */
export function SelectionModifyControls({disabled,onRun,resolutionDpi=72}:{disabled:boolean;onRun:(id:string,params:unknown)=>void;resolutionDpi?:number}) {
 const [radius,setRadius]=useState<Record<SelectionModifyId,string>>({
  "select.modify.border":"1","select.modify.smooth":"1","select.modify.expand":"1","select.modify.contract":"1"
 });
 const [active,setActive]=useState<SelectionModifyId>("select.modify.border");
 const range=SELECTION_MODIFY_RANGES[active];
 const value=radius[active];
 const valid=value.trim()!=="" && Number.isFinite(Number(value)) && Number(value)>=range.min && Number(value)<=range.max;
 return <div className="photo-editor__selection-modify" data-selection-modify={active}>
  <label>修改<select value={active} disabled={disabled} onChange={event=>setActive(event.currentTarget.value as SelectionModifyId)}>
   {(Object.keys(SELECTION_MODIFY_RANGES) as SelectionModifyId[]).map(id=><option key={id} value={id}>{SELECTION_MODIFY_RANGES[id].label}</option>)}
  </select></label>
  <label>{range.label}（px）<ArithmeticInput invalidate units={{unit:"px",dpi:resolutionDpi}} min={range.min} max={range.max} step={1} disabled={disabled} value={value} onChange={event=>setRadius(current=>({...current,[active]:event.currentTarget.value}))}/></label>
  <Button size="sm" tone="ghost" disabled={disabled || !valid} onClick={()=>onRun(active,buildSelectionModify(active,clampSelectionRadius(active,Number(value))))}>应用</Button>
  <Button size="sm" tone="ghost" disabled={disabled} onClick={()=>onRun("select.grow",{tolerance:32})}>扩展相似像素</Button>
  <Button size="sm" tone="ghost" disabled={disabled} onClick={()=>onRun("select.similar",{tolerance:32})}>选择相似颜色</Button>
 </div>;
}
