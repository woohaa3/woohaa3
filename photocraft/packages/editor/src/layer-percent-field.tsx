import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useRef,useState,type PointerEvent} from "react";
import {IconButton} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {ChevronDownIcon} from "./ui/icons.js";

type Props={label:string;value:string;disabled:boolean;update:(value:string)=>void;finish:(commit:boolean)=>boolean};
const number=(value:string)=>{const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(100,n)):100;};
/** 数值、滚轮、滑块和字段/标题拖动共用同一可取消属性事务。 */
export function LayerPercentField({label,value,disabled,update,finish}:Props) {
  const [open,setOpen]=useState(false);
  const drag=useRef<{id:number;x:number;value:number;started:boolean}|null>(null);
  const current=useRef({update,finish,disabled,value});current.current={update,finish,disabled,value};
  const element=useRef<HTMLSpanElement>(null),popup=useRef<HTMLDivElement>(null),wheelValue=useRef(number(value));
  const wheel=useRef<ReturnType<typeof setTimeout>|null>(null);
  const stop=(commit:boolean)=>{
    if(wheel.current!==null) {clearTimeout(wheel.current);wheel.current=null;}
    drag.current=null;return current.current.finish(commit);
  };
  useEffect(()=>{
    const cancel=()=>{if(drag.current || wheel.current!==null) stop(false);setOpen(false);};
    window.addEventListener("blur",cancel);
    return ()=>{window.removeEventListener("blur",cancel);if(drag.current || wheel.current!==null) stop(false);};
  },[]);
  useEffect(()=>{if(disabled) {if(drag.current || wheel.current!==null) stop(false);setOpen(false);}},[disabled]);
  useEffect(()=>{
    const consume=(event:WheelEvent)=>{
      const field=element.current;if(!field || current.current.disabled || event.ctrlKey || event.metaKey || event.altKey || !event.deltaY) return;
      const target=event.target instanceof Element ? event.target : null;
      const own=!!target && (field.contains(target) || !!popup.current?.contains(target));
      const focused=field.querySelector('input[data-numeric-input]')===document.activeElement;
      const canvas=!!target?.closest(".photo-editor-canvas") && field.closest(".photo-editor")===target.closest(".photo-editor");
      if(!own && !(focused && canvas)) return;
      event.preventDefault();event.stopPropagation();
      const previous=wheel.current===null ? number(current.current.value) : wheelValue.current;
      const next=Math.max(0,Math.min(100,previous+(event.deltaY<0?1:-1)*(event.shiftKey?10:1)));
      wheelValue.current=next;current.current.update(String(next));
      if(wheel.current!==null) clearTimeout(wheel.current);
      wheel.current=setTimeout(()=>{wheel.current=null;current.current.finish(true);},180);
    };
    document.addEventListener("wheel",consume,{capture:true,passive:false});
    return ()=>document.removeEventListener("wheel",consume,true);
  },[]);
  const start=(event:PointerEvent,prevent=false)=>{
    if(disabled || event.button!==0) return;
    if(prevent) event.preventDefault();drag.current={id:event.pointerId,x:event.clientX,value:number(value),started:false};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const scrub=(event:PointerEvent)=>{
    const d=drag.current;if(!d || d.id!==event.pointerId) return;
    if(!d.started && Math.abs(event.clientX-d.x)<2) return;
    d.started=true;event.preventDefault();
    current.current.update(String(Math.round(Math.max(0,Math.min(100,d.value+(event.clientX-d.x)*(event.altKey ? 0.1 : event.shiftKey ? 10 : 1))))));
  };
  const release=(event:PointerEvent)=>{if(drag.current?.id===event.pointerId) stop(true);};
  const cancel=()=>{if(drag.current) stop(false);};
  return <span ref={element} className="photo-editor__percent-field" onKeyDown={event=>{
    if(event.nativeEvent.isComposing || event.keyCode===229) return;
    if(event.key==="Escape" || event.key==="Enter") {event.preventDefault();event.stopPropagation();if(stop(event.key==="Enter")) setOpen(false);}
  }}>
    <span className="photo-editor__percent-scrub" title="左右拖动调整；Shift 加速，Alt/Option 精调" onPointerDown={event=>start(event,true)}
      onPointerMove={scrub} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel}>{label}</span>
    <ArithmeticInput invalidate units={{unit:"%"}}  min={0} max={100} value={value} disabled={disabled} title={label}
      onPointerDown={event=>start(event)} onPointerMove={scrub} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onChange={event=>update(event.currentTarget.value)} onBlur={()=>{if(!drag.current) stop(true);}}/>
    <span>%</span><IconButton size="sm" label={`${label}滑块`} title={`${label}滑块`} disabled={disabled} pressed={open} onClick={()=>setOpen(previous=>!previous)}><ChevronDownIcon size={12}/></IconButton>
    {element.current ? <Popover anchorElement={element.current} open={open && !disabled} autoFocus={false} onOpenChange={next=>{setOpen(next);if(!next) stop(false);}}
      side="bottom" align="end" className="photo-editor__percent-popup">
      <div ref={popup}><input type="range" min={0} max={100} value={number(value)} disabled={disabled} title={`${label}滑块`}
        onChange={event=>update(event.currentTarget.value)} onPointerUp={release}
        onPointerDown={event=>{if(!disabled) {drag.current={id:event.pointerId,x:event.clientX,value:number(value),started:true};event.currentTarget.setPointerCapture?.(event.pointerId);}}}
        onLostPointerCapture={cancel} onPointerCancel={cancel} onBlur={()=>stop(true)}
        onKeyUp={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key)) stop(true);}}/></div>
    </Popover>:null}
  </span>;
}
