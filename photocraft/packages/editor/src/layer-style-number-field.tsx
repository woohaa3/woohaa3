import type {NumericUnits} from "./numeric-expression.js";
import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useState} from "react";

export function NumberField({value,label,min,max,factor=1,onChange,units}:{value:number;label:string;min:number;max:number;factor?:number;units?:NumericUnits;onChange:(value:number)=>void}) {
  const [raw,setRaw]=useState(String(Math.round(value*factor*1000)/1000));
  useEffect(()=>{if(Number.isFinite(value)) setRaw(String(Math.round(value*factor*1000)/1000));},[value,factor]);
  return <label>{label}<ArithmeticInput invalidate units={units??(factor===100?{unit:"%"}:undefined)}  value={raw} min={min*factor} max={max*factor} step="any" onChange={event=>{
    const next=event.currentTarget.value;setRaw(next);onChange(next.trim()===""?NaN:Number(next)/factor);
  }}/>{factor===100?"%":null}</label>;
}
