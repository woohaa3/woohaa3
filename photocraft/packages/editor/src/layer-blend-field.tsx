import {useEffect,useRef,useState} from "react";
import {Button} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {ChevronDownIcon} from "./ui/icons.js";
import {BLEND_LABELS} from "./layer-blends.js";
export type LayerBlendEditing={active:boolean;preview:(blend:string)=>boolean;finish:(commit:boolean)=>boolean};
/** 悬停只更新候选；点击/拖出释放确认，滚轮每格独立确认。 */
export function LayerBlendField({value,options,disabled,editing,owner,target}:{value:string;options:readonly string[];disabled:boolean;editing:LayerBlendEditing;owner?:object;target?:number}) {
  const [open,setOpen]=useState(false),[hovered,setHovered]=useState<string|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),pressed=useRef(false),suppressClick=useRef(false);
  const current=useRef({value,options,disabled,editing});current.current={value,options,disabled,editing};
  const close=()=>{pressed.current=false;setOpen(false);setHovered(null);current.current.editing.finish(false);};
  const choose=(mode:string)=>{
    if(current.current.disabled || !current.current.options.includes(mode) || !current.current.editing.preview(mode) || !current.current.editing.finish(true)) return false;
    current.current.value=mode;setHovered(null);return true;
  };
  const latest=useRef({close,choose});latest.current={close,choose};
  useEffect(()=>{
    const cancel=()=>latest.current.close();
    const release=(event:PointerEvent)=>{
      if(!pressed.current) return;pressed.current=false;
      const target=document.elementFromPoint?.(event.clientX,event.clientY)??event.target;
      const item=target instanceof Element?target.closest<HTMLButtonElement>('[data-blend-option]'):null;
      if(item && menu.current?.contains(item) && !item.disabled) {
        if(latest.current.choose(item.dataset.blendOption!)) {setOpen(false);suppressClick.current=true;}
      } else if(!(target instanceof Node) || !trigger.current?.contains(target)) cancel();
    };
    window.addEventListener("blur",cancel);document.addEventListener("pointercancel",cancel);document.addEventListener("pointerup",release);
    return ()=>{window.removeEventListener("blur",cancel);document.removeEventListener("pointercancel",cancel);document.removeEventListener("pointerup",release);current.current.editing.finish(false);};
  },[]);
  useEffect(()=>{if(disabled) close();},[disabled]);
  useEffect(()=>{close();},[owner,target]);
  useEffect(()=>{if(open) [...(menu.current?.querySelectorAll<HTMLElement>('[data-blend-option]')??[])].find(item=>item.dataset.blendOption===value)?.scrollIntoView?.({block:"nearest"});},[open,value]);
  useEffect(()=>{
    const wheel=(event:WheelEvent)=>{
      if(current.current.disabled || !event.deltaY || event.ctrlKey || event.metaKey || event.altKey) return;
      const target=event.target;if(!(target instanceof Node) || !(trigger.current?.contains(target) || menu.current?.contains(target))) return;
      event.preventDefault();event.stopPropagation();
      current.current.editing.finish(false);
      const choices=current.current.options,index=choices.indexOf(current.current.value),next=Math.max(0,Math.min(choices.length-1,index+(event.deltaY>0?1:-1)));
      if(next!==index && choices[next]) latest.current.choose(choices[next]);
    };
    document.addEventListener("wheel",wheel,{capture:true,passive:false});return ()=>document.removeEventListener("wheel",wheel,true);
  },[]);
  return <div className="photo-editor__blend-field" onKeyDown={event=>{if(event.key==="Escape") {event.preventDefault();event.stopPropagation();close();}}}>
    <Button ref={trigger} size="sm" disabled={disabled} title="混合模式；按住拖动选择，悬停预览，滚轮逐项确认"
      onPointerDown={event=>{if(disabled || event.button!==0) return;event.preventDefault();pressed.current=true;suppressClick.current=true;setOpen(true);}}
      onClick={()=>{if(suppressClick.current) {suppressClick.current=false;return;}if(open) close();else setOpen(true);}}>
      <span>{BLEND_LABELS[hovered??value]??hovered??value}</span><ChevronDownIcon size={12}/>
    </Button>
    {trigger.current ? <Popover anchorElement={trigger.current} open={open && !disabled} onOpenChange={next=>{if(!next) close();else setOpen(true);}} autoFocus={false}
      side="bottom" align="start" className="photo-editor__blend-popup">
      <div ref={menu} className="photo-editor__blend-options" onPointerLeave={()=>{editing.finish(false);setHovered(null);}}>
        {options.map(mode=><Button key={mode} size="sm" tone="ghost" data-blend-option={mode} data-selected={mode===(hovered??value)?"true":undefined} disabled={disabled}
          onPointerEnter={()=>{if(!disabled && editing.preview(mode)) setHovered(mode);}}
          onClick={()=>{if(latest.current.choose(mode)) {setOpen(false);pressed.current=false;}}}>{BLEND_LABELS[mode]??mode}</Button>)}
      </div>
    </Popover>:null}
  </div>;
}
