import {useRef} from "react";
import {ArithmeticInput} from "./arithmetic-input.js";
import {measurementValue,MEASUREMENT_UNITS,type MeasurementUnit,type PointPicaSize} from "./measurement-unit.js";
import type {TransformFrame} from "./transform-layer.js";
import type {NumericUnit} from "./numeric-expression.js";
export type LayerGeometryField="x"|"y"|"width"|"height";
/** Properties dimensions are world-space bounds; scaling keeps their top-left anchor fixed. */
export function layerGeometryMatrix(frame:TransformFrame,field:LayerGeometryField,px:number,linked:boolean):number[]|null {
 if(!frame.every(Number.isFinite)||!Number.isFinite(px))return null;
 const [x,y,right,bottom]=frame,width=right-x,height=bottom-y;
 if(width<=0||height<=0)return null;
 if(field==="x"||field==="y")return Math.abs(px)<=1_000_000?[1,0,0,1,field==="x"?px-x:0,field==="y"?px-y:0]:null;
 const scale=px/(field==="width"?width:height);if(scale<.01||scale>16)return null;
 const sx=field==="width"||linked?scale:1,sy=field==="height"||linked?scale:1;
 return [sx,0,0,sy,x*(1-sx),y*(1-sy)];
}
/** No native draft exists while typing; a confirmed field is one cancellable native transaction. */
export function LayerGeometryControls({frame,unit,dpi,pointPicaSize=72,documentSize,disabled,onApply,linked,onLinkedChange}:{
 linked:boolean;onLinkedChange:(value:boolean)=>void;frame:TransformFrame;unit:MeasurementUnit;dpi:number;pointPicaSize?:PointPicaSize;documentSize:{width:number;height:number};disabled:boolean;onApply:(matrix:number[])=>boolean;
}) {
 const submitted=useRef<string|null>(null);
 const unitSpec=MEASUREMENT_UNITS.find(spec=>spec.id===unit)!;
 const values={x:frame[0],y:frame[1],width:frame[2]-frame[0],height:frame[3]-frame[1]};
 const apply=(field:LayerGeometryField,number:number)=>{
  if(disabled || submitted.current===`${field}:${number}`)return;
  const extent=field==="x"||field==="width"?documentSize.width:documentSize.height;
  const factor=measurementValue(1,unit,dpi,extent,pointPicaSize),px=number/factor;
  if(Math.abs(px-values[field])<1e-8)return;
  const matrix=layerGeometryMatrix(frame,field,px,linked);
  if(matrix && onApply(matrix))submitted.current=`${field}:${number}`;
 };
 return <div className="photo-editor__layer-geometry" data-layer-geometry>
  {([["x","X"],["y","Y"],["width","宽"],["height","高"]] as const).map(([field,label])=>{
   const extent=field==="x"||field==="width"?documentSize.width:documentSize.height;
   // Keep precision for round trips; the unit suffix is rendered outside the editable expression.
   const value=Number(measurementValue(values[field],unit,dpi,extent,pointPicaSize).toPrecision(12));
   return <label key={field}>{label}<ArithmeticInput data-geometry-field={field} value={value} disabled={disabled}
    min={(field==="width"||field==="height"?value*.01:-1_000_000*measurementValue(1,unit,dpi,extent,pointPicaSize))}
    max={(field==="width"||field==="height"?value*16:1_000_000*measurementValue(1,unit,dpi,extent,pointPicaSize))}
    units={{unit:(unitSpec.suffix==="pica"?"pc":unitSpec.suffix) as NumericUnit,dpi,pointsPerInch:pointPicaSize}}
    onChange={()=>{submitted.current=null;}} onBlur={event=>apply(field,Number(event.currentTarget.value))}
    onKeyDown={event=>{
     if(event.nativeEvent.isComposing || event.keyCode===229)return;
     if(event.key==="Enter"){event.preventDefault();event.stopPropagation();apply(field,Number(event.currentTarget.value));}
     if(event.key==="Escape"){event.preventDefault();event.stopPropagation();submitted.current=null;}
    }}/><span>{unitSpec.suffix}</span></label>;
  })}
  <label className="photo-editor__layer-geometry-link"><input type="checkbox" checked={linked} disabled={disabled} onChange={event=>onLinkedChange(event.currentTarget.checked)}/>锁定比例</label>
 </div>;
}
