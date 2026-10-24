import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useRef} from "react";

/** 鼠标拖动和连续方向键分别构成一次参数操作。 */
export function AdjustmentRange({label,value,min,max,disabled,onChange,onEnd,cancelRevision=0,defaultValue=0}: {
  label:string;value:number;min:number;max:number;disabled:boolean;
  onChange:(value:number)=>void;onEnd:(commit:boolean)=>boolean;
  cancelRevision?:number;defaultValue?:number;
}) {
  const scrub=useRef<{id:number;x:number;value:number;moved:boolean}|null>(null);
  const latest=useRef({onChange,onEnd,min,max,disabled});latest.current={onChange,onEnd,min,max,disabled};
  const cancelScrub=()=>{const previous=scrub.current;scrub.current=null;if(previous?.moved)latest.current.onEnd(false);};
  useEffect(()=>{window.addEventListener("blur",cancelScrub);return()=>{window.removeEventListener("blur",cancelScrub);scrub.current=null;};},[]);
  useEffect(()=>{if(disabled)cancelScrub();},[disabled]);
  const scrubMove=(event:{pointerId:number;clientX:number;altKey:boolean;shiftKey:boolean;preventDefault:()=>void})=>{
    const current=scrub.current;if(!current || current.id!==event.pointerId || latest.current.disabled)return;
    const delta=event.clientX-current.x;if(!current.moved && Math.abs(delta)<3)return;event.preventDefault();current.moved=true;current.x=event.clientX;
    current.value=Math.max(latest.current.min,Math.min(latest.current.max,current.value+delta*(event.altKey ? 0.1 : event.shiftKey ? 10 : 1)));latest.current.onChange(current.value);
  };
  const pointer=useRef<number|null>(null);
  const canceled=useRef(false);
  const previousCancel=useRef(cancelRevision);
  useEffect(()=>{
    if (previousCancel.current===cancelRevision) return;
    previousCancel.current=cancelRevision;scrub.current=null;
    if (pointer.current!==null) {pointer.current=null;canceled.current=true;}
  },[cancelRevision]);
  return <label data-adjustment-control>
    <span className="photo-editor__paint-scrub" title="拖动调值；Shift 加速，Alt/Option 精调" onPointerDown={event=>{
      if(disabled || event.button!==0 || !Number.isFinite(value))return;event.preventDefault();scrub.current={id:event.pointerId,x:event.clientX,value,moved:false};event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerMove={scrubMove} onPointerUp={event=>{const current=scrub.current;if(!current || current.id!==event.pointerId)return;scrubMove(event);scrub.current=null;if(current.moved)onEnd(true);if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
    onPointerCancel={cancelScrub} onLostPointerCapture={cancelScrub}>{label}</span>
    <input type="range" min={min} max={max} value={Number.isFinite(value)?value:defaultValue} disabled={disabled}
      onDoubleClick={event=>{if(disabled || value===defaultValue)return;event.preventDefault();event.stopPropagation();canceled.current=false;onChange(defaultValue);onEnd(true);}}
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
    <ArithmeticInput invalidate value={Number.isFinite(value)?value:""} min={min} max={max} disabled={disabled}
      onChange={event=>onChange(event.currentTarget.value.trim()===""?NaN:Number(event.currentTarget.value))}
      onBlur={()=>onEnd(true)} onKeyDown={event=>{
        if(event.nativeEvent.isComposing || event.keyCode===229)return;
        if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onEnd(false);}
        else if(event.key==="Enter"){event.preventDefault();event.stopPropagation();onEnd(true);}
      }} onKeyUp={event=>{if(event.key==="ArrowUp" || event.key==="ArrowDown")onEnd(true);}}/>
  </label>;
}
