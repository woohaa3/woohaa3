import {useEffect,useRef} from "react";

/** 鼠标拖动和连续方向键分别构成一次参数操作。 */
export function AdjustmentRange({label,value,min,max,disabled,onChange,onEnd,cancelRevision=0}: {
  label:string;value:number;min:number;max:number;disabled:boolean;
  onChange:(value:number)=>void;onEnd:(commit:boolean)=>boolean;
  cancelRevision?:number;
}) {
  const pointer=useRef<number|null>(null);
  const canceled=useRef(false);
  const previousCancel=useRef(cancelRevision);
  useEffect(()=>{
    if (previousCancel.current===cancelRevision) return;
    previousCancel.current=cancelRevision;
    if (pointer.current!==null) {pointer.current=null;canceled.current=true;}
  },[cancelRevision]);
  return <label data-adjustment-control>
    {label}
    <input type="range" min={min} max={max} value={value} disabled={disabled}
      onPointerDown={(event)=>{pointer.current=event.pointerId;canceled.current=false;event.currentTarget.setPointerCapture?.(event.pointerId);}}
      onChange={(event)=>{if (!canceled.current) onChange(Number(event.currentTarget.value));}}
      onPointerUp={(event)=>{
        if (pointer.current!==event.pointerId) return;
        pointer.current=null;
        if (!canceled.current) onEnd(true);
        canceled.current=false;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={()=>{pointer.current=null;canceled.current=true;onEnd(false);}}
      onLostPointerCapture={()=>{if (pointer.current!==null) {pointer.current=null;canceled.current=true;onEnd(false);}}}
      onKeyDown={(event)=>{
        if (/^(Arrow|Home|End|Page)/.test(event.key) && pointer.current===null) canceled.current=false;
        if (event.key==="Enter" && !event.nativeEvent.isComposing && event.keyCode!==229) {
          event.preventDefault();event.stopPropagation();onEnd(true);return;
        }
        if (event.key!=="Escape" || event.nativeEvent.isComposing || event.keyCode===229) return;
        event.preventDefault();event.stopPropagation();canceled.current=pointer.current!==null;onEnd(false);
      }}
      onKeyUp={(event)=>{if (/^(Arrow|Home|End|Page)/.test(event.key)) onEnd(true);}}
      onBlur={()=>{if (pointer.current===null) onEnd(true);}} />
    <output>{value}</output>
  </label>;
}
